// Session controller：把"对话生命周期 + SSE 事件循环"从 React 组件里抽出来。
//
// 设计目的：
// - tui 层只消费 UiEvent 高层事件 + 调几个 callback，不再 import protocol 客户端、
//   也不再 import config 工具。这样把 tui 整体替换（pi-tui / 自研 / web）只要重新写
//   "如何渲染 UiEvent + 如何调用 session 方法"，业务流程一行不用碰。
// - controller 是纯 TS（没有 React），能脱离 Ink 单独 unit test：mock 一个 client，
//   注入一组 SSE 事件，断言 UiEvent 序列。这是抽出来的最大短期收益。
// - SSE wire format（text.chunk / tool_call.* / run.completed 等）只在这里被解码；
//   将来换 transport（websocket / JSONRPC）只换 streamMessage 来源即可。

import stripAnsi from "strip-ansi";

import type { AgentEventBase, State } from "../protocol";
import { DoctorClient, ServerError, mapErrorMessage } from "../protocol";
import { profileToUpload, validateProfile } from "./config/config";
import type { Config } from "./config/model";
import { recordConversation, saveState } from "./config/state";

// UI 层订阅的高层事件——抽象掉 SSE wire 细节。
// 工具事件给原始 args / result，让 UI 层（按 tool 类型）自行决定怎么展示——
// 跟 opencode 的 PART_MAPPING 思路一致：domain 摘要逻辑不在 controller 里写死。
export type UiEvent =
  | { kind: "info"; tone: "muted" | "warn" | "error"; text: string }
  | { kind: "user_message"; text: string }
  | { kind: "assistant_start" }
  | { kind: "assistant_chunk"; text: string }
  | { kind: "assistant_end"; text: string }
  | { kind: "tool_started"; toolCallId: string; toolName: string; args: unknown }
  | {
      kind: "tool_finished";
      toolCallId: string;
      ok: boolean;
      result: string;
      durationMs?: number;
      truncated?: boolean;
      timeoutMs?: number;
    }
  | { kind: "session_attached"; sessionId: string }
  | { kind: "turn_completed" }
  | { kind: "profile_switched"; name: string; connectionId: string }
  | { kind: "error"; message: string };

export interface SessionState {
  profileName: string;
  connectionId: string;
  conversationId?: string;
  turnCount: number;
}

export interface SessionDeps {
  client: DoctorClient;
  connectionId: string;
  profileName: string;
  resumeConversationId?: string;
  state: State;
  statePath: string;
  config: Config;
}

export interface Session {
  getState(): SessionState;
  subscribe(listener: (e: UiEvent) => void): () => void;
  submit(text: string): Promise<void>;
  // 中断当前 turn——参考 pi-mono 分层 ESC 的"streaming → abort"分支：
  // 关 SSE，client 这边停渲染；server 仍会把已发起的工具跑完，下一 turn 不受影响。
  abort(): void;
  switchProfile(name: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createSession(deps: SessionDeps): Session {
  let client = deps.client;
  let connectionId = deps.connectionId;
  let profileName = deps.profileName;
  let conversationId: string | undefined = deps.resumeConversationId;
  let persistedState = deps.state;
  let turnCount = 0;
  // 当前 turn 的 AbortController；ESC 触发 abort。turn 结束（成功/失败/中断）后清空。
  let currentAbort: AbortController | undefined;

  const listeners = new Set<(e: UiEvent) => void>();
  const emit = (e: UiEvent) => {
    for (const l of listeners) l(e);
  };

  function getState(): SessionState {
    return { profileName, connectionId, conversationId, turnCount };
  }

  function subscribe(listener: (e: UiEvent) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function startStream(
    text: string,
    retry: boolean,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<AgentEventBase>> {
    try {
      return client.streamMessage(
        connectionId,
        {
          text,
          conversation_id: conversationId,
        },
        signal,
      );
    } catch (err) {
      // server 重启 / GC 后旧 cid 已没；尝试用相同 profile 重建一次连接，再发同一条 turn
      if (retry && err instanceof ServerError && err.code === "connection_not_found") {
        const profile = deps.config.profiles[profileName];
        const cid = await client.createConnection(profileToUpload(profile));
        connectionId = cid;
        emit({
          kind: "info",
          tone: "warn",
          text: `connection 失效，已重建 cid=${cid.slice(0, 8)}…`,
        });
        return startStream(text, false, signal);
      }
      throw err;
    }
  }

  async function submit(text: string) {
    turnCount++;
    emit({ kind: "user_message", text });

    let assistantStarted = false;
    let assistantBuf = "";
    // 同一 tool_call_id 在 result + completed 都会触发 finished，去重避免 UI 重复更新
    const toolFinished = new Set<string>();
    // tool_call_id → tool_call.started 的 occurred_at（毫秒），用于算工具执行耗时
    const toolStartTime = new Map<string, number>();

    const ac = new AbortController();
    currentAbort = ac;
    try {
      const events = await startStream(text, true, ac.signal);
      for await (const ev of events) {
        switch (ev.event_type) {
          case "session.created":
          case "session.attached":
            conversationId = ev.session_id;
            persistedState = recordConversation(persistedState, ev.session_id, profileName);
            emit({ kind: "session_attached", sessionId: ev.session_id });
            break;
          case "text.chunk": {
            const chunk = String(ev.content ?? "");
            if (!assistantStarted) {
              assistantStarted = true;
              emit({ kind: "assistant_start" });
            }
            assistantBuf += chunk;
            emit({ kind: "assistant_chunk", text: chunk });
            break;
          }
          case "thinking.chunk":
            // 思考流逐 token 出现刷屏，且与最终答复重复；CLI 一律不渲染
            break;
          case "tool_call.started": {
            const id = String(ev.tool_call_id ?? Math.random());
            const occurredAt = Number(ev.occurred_at);
            if (Number.isFinite(occurredAt)) toolStartTime.set(id, occurredAt);
            emit({
              kind: "tool_started",
              toolCallId: id,
              toolName: String(ev.tool_name ?? "tool"),
              args: ev.args,
            });
            break;
          }
          case "tool_call.result": {
            // result 在 completed 之前到，且带完整 content + status——是 tool 执行结果的权威信号
            const id = String(ev.tool_call_id ?? "");
            if (toolFinished.has(id)) break;
            toolFinished.add(id);
            const status = String(ev.status ?? "completed").toLowerCase();
            const ok = status === "completed";
            // shell / kubectl 等工具输出常带 ANSI 控制码，进 Ink 前先洗掉避免色彩污染布局
            const result = stripAnsi(String(ev.display_content ?? ev.content ?? ""));
            const durationMs = computeDuration(toolStartTime, id, ev.occurred_at);
            const truncated = ev.truncated === true;
            const timeoutMs = typeof ev.timeout_ms === "number" ? ev.timeout_ms : undefined;
            emit({ kind: "tool_finished", toolCallId: id, ok, result, durationMs, truncated, timeoutMs });
            break;
          }
          case "tool_call.completed": {
            // result 已经处理过；completed 仅作兜底（理论不会触发，留着防 result 缺失）
            const id = String(ev.tool_call_id ?? "");
            if (toolFinished.has(id)) break;
            toolFinished.add(id);
            const status = String(ev.status ?? "completed").toLowerCase();
            const durationMs = computeDuration(toolStartTime, id, ev.occurred_at);
            emit({
              kind: "tool_finished",
              toolCallId: id,
              ok: status === "completed",
              result: "",
              durationMs,
            });
            break;
          }
          case "run.completed":
            if (assistantStarted) {
              emit({ kind: "assistant_end", text: assistantBuf });
            }
            saveState(deps.statePath, persistedState);
            emit({ kind: "turn_completed" });
            break;
          default:
            // 未识别事件透明放过
            break;
        }
      }
    } catch (err) {
      // ESC / dispose 主动 abort——不当作错误展示，单独 emit 中断标记
      if (ac.signal.aborted) {
        if (assistantStarted) {
          emit({ kind: "assistant_end", text: `${assistantBuf}\n\n[已中断]` });
        }
        emit({
          kind: "info",
          tone: "warn",
          text: "已中断当前 turn（server 仍会跑完已发起的工具）",
        });
        emit({ kind: "turn_completed" });
      } else {
        if (assistantStarted) {
          emit({ kind: "assistant_end", text: `${assistantBuf}\n\n[流中断]` });
        }
        emit({ kind: "error", message: mapErrorMessage(err) });
      }
    } finally {
      if (currentAbort === ac) currentAbort = undefined;
    }
  }

  function abort() {
    currentAbort?.abort();
  }

  async function switchProfile(name: string) {
    const profile = deps.config.profiles[name];
    if (!profile) {
      emit({ kind: "error", message: `profile '${name}' 不在 config 中` });
      return;
    }
    const v = validateProfile(profile);
    if (v.errors.length) {
      emit({ kind: "error", message: v.errors.join("\n") });
      return;
    }
    if (!profile.server) {
      emit({
        kind: "error",
        message: `profile '${name}' 未配置 server（本地模式），REPL 内无法切换；采集请退出后用 doctor cpu / doctor mem / doctor trace`,
      });
      return;
    }
    try {
      await client.deleteConnection(connectionId);
      const next = new DoctorClient(profile.server);
      if (!(await next.healthz())) {
        emit({ kind: "error", message: `server ${profile.server} 不可达` });
        return;
      }
      const cid = await next.createConnection(profileToUpload(profile));
      client = next;
      connectionId = cid;
      profileName = name;
      conversationId = undefined;
      turnCount = 0;
      emit({ kind: "profile_switched", name, connectionId: cid });
      emit({
        kind: "info",
        tone: "muted",
        text: `switched to profile=${name} (cid=${cid.slice(0, 8)}…), 新对话开始`,
      });
      for (const w of v.warnings) emit({ kind: "info", tone: "warn", text: w });
    } catch (err) {
      emit({ kind: "error", message: `切换 profile 失败：${mapErrorMessage(err)}` });
    }
  }

  async function dispose() {
    try {
      await client.deleteConnection(connectionId);
    } catch {
      // best effort
    }
    saveState(deps.statePath, persistedState);
  }

  return { getState, subscribe, submit, abort, switchProfile, dispose };
}

function computeDuration(
  startTimes: Map<string, number>,
  id: string,
  endRaw: unknown,
): number | undefined {
  const start = startTimes.get(id);
  startTimes.delete(id);
  if (start === undefined) return undefined;
  const end = Number(endRaw);
  if (!Number.isFinite(end)) return undefined;
  const ms = end - start;
  return ms >= 0 ? ms : undefined;
}
