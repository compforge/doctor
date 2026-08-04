// chat 子命令：按 profile 配置完备度呈现能力（能力阶梯）——
//   配了 server（+llm）    → 连 doctor-server 的交互式 REPL（本文件主体）
//   只配了 llm             → 本地问答（llm 直连 + kubectl 渠道 + ~/.doctor/skills；尚未实现，先提示）
//   都没配                 → 仅采集命令（doctor cpu / doctor mem / doctor trace）可用，打印能力提示
// 从 main.tsx 抽出——main.tsx 只负责子命令路由。
import { render } from "ink";
import React from "react";
import { homedir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "./bootstrap";
import { loadConfig, resolveProfile } from "./config/config";
import { createSession } from "./session";
import { DOCTOR_CLI_VERSION } from "./version";
import { mapErrorMessage } from "../protocol";
import { reportError } from "./error-log";
import { App } from "../tui";
import type { CliFlags } from "../protocol";

export async function runRepl(flags: CliFlags): Promise<void> {
  // 能力分流在 TTY 检查之前：提示类输出不需要交互终端。
  // --resume 隐含 profile 且必然来自 server 会话，留给 bootstrap 原路处理。
  if (flags.resume === undefined) {
    const configPath = flags.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
    let name = "";
    let hasServer = false;
    let hasLlm = false;
    try {
      const resolved = resolveProfile(loadConfig(configPath), flags.profile);
      name = resolved.name;
      hasServer = !!resolved.profile.server;
      hasLlm = !!resolved.profile.llm;
    } catch (err) {
      reportError(err, {
        context: "doctor chat/local-startup",
        summary: "启动失败",
        displayMessage: mapErrorMessage(err),
      });
      process.exit(1);
    }
    if (!hasServer) {
      if (hasLlm) {
        process.stdout.write(
          `profile '${name}' 配置了 llm（未配 server）：本地问答即将支持，当前版本尚未实现。\n` +
            `现在可用的能力：doctor cpu / doctor mem / doctor mems / doctor trace（直连采集）\n`,
        );
      } else {
        process.stdout.write(
          `当前 profile '${name}' 未配置 llm / server，问答不可用。\n` +
            `现在可用的能力：doctor cpu / doctor mem / doctor mems / doctor trace（直连采集）\n` +
            `补齐 profile.llm 可解锁本地问答（即将支持）；再补 server 则连接 doctor-server。\n`,
        );
      }
      return;
    }
  }

  if (!process.stdin.isTTY) {
    process.stderr.write("doctor chat 仅支持交互式终端（非交互采集请用 doctor cpu / doctor mem / doctor mems / doctor trace）\n");
    process.exit(2);
  }

  let boot;
  try {
    boot = await bootstrap(flags);
  } catch (err) {
    reportError(err, {
      context: "doctor chat/server-startup",
      summary: "启动失败",
      displayMessage: mapErrorMessage(err),
    });
    process.exit(1);
    return; // unreachable but satisfies TS narrowing
  }

  const configPath = flags.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  const config = loadConfig(configPath);

  // 把对话生命周期 + SSE 事件循环装进 Session controller，UI 层只通过 Session 接口
  // 与之交互（subscribe / submit / switchProfile / dispose）
  const session = createSession({
    client: boot.client,
    connectionId: boot.connectionId,
    profileName: boot.profileName,
    resumeConversationId: boot.resumeConversationId,
    state: boot.state,
    statePath: boot.statePath,
    config,
  });

  const { waitUntilExit, unmount } = render(
    React.createElement(App, {
      session,
      version: DOCTOR_CLI_VERSION,
      initialProfileName: boot.profileName,
      initialConnectionId: boot.connectionId,
      initialResumeConversationId: boot.resumeConversationId,
      initialProfile: config.profiles[boot.profileName],
      config,
      startupWarnings: boot.warnings,
      verbose: flags.verbose,
    }),
    // Ink 7 新增：只重写发生变化的行，避免每次 SSE chunk 把整段动态区
    // 全部 erase + rewrite 引起的"逐字闪烁"。配合 `<Static>` 一起，从
    // 全局 → 增量渲染，消除流式输出期的视觉抖动。
    { incrementalRendering: true },
  );

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      await Promise.race([
        session.dispose(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // best effort
    }
    unmount();
  };
  process.on("SIGTERM", () => cleanup().then(() => process.exit(0)));
  process.on("beforeExit", () => {
    void cleanup();
  });

  await waitUntilExit();
  await cleanup();
}
