import { Box, Static, Text, useApp, useInput, useStdin } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Config, Profile } from "../app/config/model";
import type { Session, SessionState, UiEvent } from "../app/session";
import { Banner } from "./Banner";
import { openEditorSync } from "./editor";
import {
  EXPORT_PROMPT,
  type ExportMeta,
  buildHeader,
  resolveExportPath,
  writeExport,
} from "./export";
import { type HistoryItem, HistoryItemView } from "./History";
import { Input } from "./Input";
import { KEYMAP } from "./keymap";
import { renderMarkdown } from "./markdown";
import { ProfilePicker } from "./ProfilePicker";
import { HELP_TEXT, parseSlash } from "./slash";
import { StatusBar } from "./StatusBar";

// 向后搜索 HistoryItem 数组中最后一个指定 kind 的下标；找不到返回 -1。
// 不用 Array.findLastIndex（ES2023）避免升 tsconfig lib。
function lastIndexOf(items: readonly { kind: string }[], kind: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === kind) return i;
  }
  return -1;
}

// tui 层只通过 Session 接口和配置数据模型与下层交互——
// 不再 import protocol 客户端、不再 import config 工具。
// 替换 UI 层只要重写本组件 + 子组件，不动 Session / protocol / config 逻辑。
interface Props {
  session: Session;
  version: string;
  initialProfileName: string;
  initialConnectionId: string;
  initialResumeConversationId?: string;
  initialProfile: Profile | undefined;
  config: Config;
  startupWarnings: string[];
  verbose: boolean;
}

export function App(props: Props) {
  const { exit } = useApp();
  const { session } = props;

  // history 拆成两段：
  //   committed —— 已 commit 到 scrollback、永不再渲染（走 <Static>）
  //   pending   —— 当前 turn / slash 命令进行中可变（走普通 Box 渲染）
  // 关键性能点：每个 text.chunk / tool_call.chunk 触发的 setState 只 reconcile pending
  // 那几个 node，不动已 commit 的几百个老 history item。
  // pending 用 ref + version 计数器驱动 re-render，避免 setState-inside-setState 反模式。
  const [committed, setCommitted] = useState<HistoryItem[]>([]);
  const pendingRef = useRef<HistoryItem[]>([]);
  const [, setPendingVersion] = useState(0);
  const writePending = (mutator: (p: HistoryItem[]) => HistoryItem[]) => {
    pendingRef.current = mutator(pendingRef.current);
    setPendingVersion((v) => v + 1);
  };
  const appendPending = (item: HistoryItem) => writePending((p) => [...p, item]);
  const flushPending = () => {
    if (pendingRef.current.length === 0) return;
    const toFlush = pendingRef.current;
    pendingRef.current = [];
    toolIndexById.current.clear();
    setCommitted((c) => [...c, ...toFlush]);
    setPendingVersion((v) => v + 1);
  };

  const { setRawMode } = useStdin();
  const [inputValue, setInputValue] = useState("");
  const [snap, setSnap] = useState<SessionState>(session.getState());
  const [busy, setBusy] = useState(false);
  // /profile 无参 → 弹下拉，picker 期间隐藏 Input；选完或 ESC 关闭
  const [pickerMode, setPickerMode] = useState<"profile" | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  const exitArmedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // tool_call.id → pendingRef 内的 index；turn 结束 flush 时清空
  const toolIndexById = useRef(new Map<string, number>());

  useEffect(() => {
    const unsub = session.subscribe((e: UiEvent) => {
      switch (e.kind) {
        case "user_message":
          appendPending({ kind: "user", text: e.text });
          break;
        case "assistant_start":
          appendPending({ kind: "assistant", text: "" });
          break;
        case "assistant_chunk":
          writePending((p) => {
            const next = p.slice();
            // Agent 在文本生成中途会插入工具调用，tool item 会出现在 assistant item 之后，
            // 末尾不一定是 assistant item——向后搜索确保 chunk 始终追加到正确的 item。
            const i = lastIndexOf(next, "assistant");
            if (i >= 0) {
              const cur = next[i];
              if (cur.kind === "assistant") next[i] = { ...cur, text: cur.text + e.text };
            }
            return next;
          });
          break;
        case "assistant_end":
          writePending((p) => {
            const next = p.slice();
            const i = lastIndexOf(next, "assistant");
            if (i >= 0 && next[i].kind === "assistant") {
              next[i] = { kind: "assistant", text: e.text, rendered: renderMarkdown(e.text) };
            }
            return next;
          });
          break;
        case "tool_started":
          writePending((p) => {
            toolIndexById.current.set(e.toolCallId, p.length);
            return [
              ...p,
              {
                kind: "tool",
                toolCallId: e.toolCallId,
                toolName: e.toolName,
                args: e.args,
                status: "running",
              },
            ];
          });
          break;
        case "tool_finished": {
          const idx = toolIndexById.current.get(e.toolCallId);
          if (idx === undefined) break;
          writePending((p) => {
            const next = p.slice();
            const cur = next[idx];
            if (!cur || cur.kind !== "tool") return p;
            next[idx] = {
              ...cur,
              status: e.ok ? "success" : "failure",
              result: e.result,
              durationMs: e.durationMs,
              truncated: e.truncated,
              timeoutMs: e.timeoutMs,
            };
            return next;
          });
          break;
        }
        case "info":
          appendPending({ kind: "info", tone: e.tone, text: e.text });
          break;
        case "error":
          appendPending({ kind: "info", tone: "error", text: `错误：${e.message}` });
          break;
        case "session_attached":
        case "turn_completed":
        case "profile_switched":
          setSnap(session.getState());
          break;
      }
    });
    return unsub;
  }, [session]);

  useInput((input, key) => {
    // ESC: abort running turn (keep REPL alive); no-op when idle.
    if (key.escape) {
      if (busy) session.abort();
      return;
    }
    if (!key.ctrl) return;

    // Ctrl+E: open $EDITOR for multi-line composition (idle only).
    if (input === KEYMAP.OPEN_EDITOR.input && !busy) {
      setRawMode(false);
      try {
        const edited = openEditorSync(inputValue);
        if (edited !== null) setInputValue(edited);
      } finally {
        setRawMode(true);
      }
      return;
    }

    // Ctrl+C: quit (double-tap to confirm when busy).
    if (input !== KEYMAP.EXIT.input) return;
    if (busy) {
      if (exitArmed) {
        session.dispose().then(() => exit());
      } else {
        setExitArmed(true);
        if (exitArmedTimer.current) clearTimeout(exitArmedTimer.current);
        exitArmedTimer.current = setTimeout(() => setExitArmed(false), 3000);
      }
      return;
    }
    session.dispose().then(() => exit());
  });

  // 切 profile 的下游：picker 选完 / `/profile <name>` 都走这里
  async function runSwitchProfile(name: string) {
    setBusy(true);
    try {
      await session.switchProfile(name);
    } finally {
      setBusy(false);
      setSnap(session.getState());
      flushPending();
    }
  }

  // ProfilePicker 选中回调：关 picker，走切换流程
  async function onPickerSelect(name: string) {
    setPickerMode(null);
    if (name === snap.profileName) {
      appendPending({
        kind: "info",
        tone: "muted",
        text: `已经在 profile=${name}，无需切换`,
      });
      flushPending();
      return;
    }
    await runSwitchProfile(name);
  }

  function onPickerCancel() {
    setPickerMode(null);
    appendPending({ kind: "info", tone: "muted", text: "已取消 profile 选择" });
    flushPending();
  }

  // /export：CLI 拼 EXPORT_PROMPT 走普通 chat 流，server 自动喂 conversation 历史，
  // LLM 流回结构化 markdown 报告——CLI 只负责发起、抓最末 assistant.text 落盘。
  // 已知副作用：summarize prompt + 报告会持久化到 transcript，下次 --resume 看得到。
  async function handleExport(rawPath: string | undefined) {
    const state = session.getState();
    const path = resolveExportPath(rawPath, state.conversationId);

    // 真正空的会话：还没有 conversation_id 且本进程也没 turn——server 端没东西可总结
    if (!state.conversationId && state.turnCount === 0) {
      appendPending({
        kind: "info",
        tone: "warn",
        text: "当前对话为空，先问个问题再 /export",
      });
      flushPending();
      return;
    }

    // submit 期间通过 subscribe 跟踪是否中断 / 出错——这两种情况不写文件
    let aborted = false;
    let errored = false;
    const unsub = session.subscribe((e) => {
      if (e.kind === "error") errored = true;
      if (e.kind === "info" && e.tone === "warn" && e.text.includes("已中断")) aborted = true;
    });

    appendPending({
      kind: "info",
      tone: "muted",
      text: `正在生成诊断报告 → ${path}`,
    });

    setBusy(true);
    setExitArmed(false);
    try {
      await session.submit(EXPORT_PROMPT);
      if (errored || aborted) {
        appendPending({
          kind: "info",
          tone: "warn",
          text: "导出未完成，未写入文件",
        });
        return;
      }
      // 抓最末 assistant.text（向后扫；同 assistant_chunk 的搜索方式一致）
      let report: string | undefined;
      const items = pendingRef.current;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "assistant") {
          report = it.text;
          break;
        }
      }
      if (!report || !report.trim()) {
        appendPending({
          kind: "info",
          tone: "error",
          text: "未拿到模型输出，未写入文件",
        });
        return;
      }
      const cur = props.config.profiles[state.profileName];
      const curLlm = cur?.llm;
      const curModelTag = curLlm?.model
        ? `${curLlm.provider ?? "?"}/${curLlm.model}${curLlm.thinking ? "*" : ""}`
        : "(no model)";
      const meta: ExportMeta = {
        conversationId: state.conversationId,
        profileName: state.profileName,
        serverUrl: cur?.server ?? "",
        readonly: cur?.readonly ?? false,
        modelTag: curModelTag,
        cliVersion: props.version,
      };
      const content = buildHeader(meta) + report.trim() + "\n";
      await writeExport(content, path);
      appendPending({
        kind: "info",
        tone: "muted",
        text: `已写入 ${path}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendPending({
        kind: "info",
        tone: "error",
        text: `导出失败：${msg}`,
      });
    } finally {
      unsub();
      setBusy(false);
      setExitArmed(false);
      setSnap(session.getState());
      flushPending();
    }
  }

  async function handleSubmit(text: string) {
    const slash = parseSlash(text);
    if (slash.kind !== "noop") {
      switch (slash.kind) {
        case "exit":
          await session.dispose();
          exit();
          return;
        case "help":
          appendPending({ kind: "info", tone: "muted", text: HELP_TEXT });
          flushPending();
          return;
        case "switch_profile":
          await runSwitchProfile(slash.profileName);
          return;
        case "open_profile_picker":
          setPickerMode("profile");
          return;
        case "export":
          await handleExport(slash.path);
          return;
        case "unknown":
          appendPending({
            kind: "info",
            tone: "warn",
            text: `未知命令：${text}，输入 /help 查看可用命令`,
          });
          flushPending();
          return;
      }
    }
    setBusy(true);
    setExitArmed(false);
    try {
      await session.submit(text);
    } finally {
      setBusy(false);
      setExitArmed(false);
      setSnap(session.getState());
      // turn 内所有 user/assistant/tool/info/error 项都堆在 pending，
      // submit 返回（成功或失败）后一次性 flush 到 committed，下一帧起 <Static> 接管
      flushPending();
    }
  }

  // 三段式布局：Banner（Static）→ committed history（Static）→ pending → Input → StatusBar
  // Static 使每次 setState 时 React 只 reconcile pending 这一段，不触及已 commit 内容
  const llm = props.initialProfile?.llm;
  const modelTag = llm?.model
    ? `${llm.provider ?? "?"}/${llm.model}${llm.thinking ? "*" : ""}`
    : "(no model)";

  return (
    <Box flexDirection="column">
      <Static items={[{ key: "banner" }]}>
        {() => (
          <Banner
            key="banner"
            version={props.version}
            profileName={props.initialProfileName}
            profile={props.initialProfile}
            connectionId={props.initialConnectionId}
            resumeConversationId={props.initialResumeConversationId}
            warnings={props.startupWarnings}
          />
        )}
      </Static>
      <Static items={committed}>
        {(item, idx) => (
          <Box key={idx} marginBottom={item.kind === "tool" ? 0 : 1} flexDirection="column">
            <HistoryItemView item={item} verbose={props.verbose} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column">
        {pendingRef.current.map((item, i) => (
          <Box key={i} marginBottom={item.kind === "tool" ? 0 : 1} flexDirection="column">
            <HistoryItemView item={item} verbose={props.verbose} />
          </Box>
        ))}
      </Box>
      {pickerMode === "profile" ? (
        <ProfilePicker
          profiles={props.config.profiles}
          currentProfile={snap.profileName}
          onSelect={onPickerSelect}
          onCancel={onPickerCancel}
        />
      ) : (
        <Input disabled={busy} value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
      )}
      {exitArmed ? (
        <Box>
          <Text color="yellow">⏎ 再按 Ctrl+C 退出（当前任务已发出，server 仍会跑完）</Text>
        </Box>
      ) : null}
      <StatusBar
        profileName={snap.profileName}
        connectionId={snap.connectionId}
        conversationId={snap.conversationId}
        modelTag={modelTag}
        turnCount={snap.turnCount}
        busy={busy}
      />
    </Box>
  );
}
