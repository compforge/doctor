import { isInteractive } from "../terminal/policy";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";

import { runPlainRepl } from "../chat/plain-repl";
import { Session } from "../chat/session";
import type { CliFlags } from "../protocol";
import { mapErrorMessage } from "../protocol";
import { bootstrap } from "./bootstrap";
import type { DistributionManifest } from "./distribution";
import { reportError } from "./error-report";
import { useLogger } from "../terminal/log";

export async function runRepl(
  flags: CliFlags,
  plugin: PluginDefinition | undefined,
  commandContext: CommandContext,
  agentCommands?: Readonly<Record<string, DistributionManifest>>,
): Promise<void> {
  if (!isInteractive()) {
    useLogger().error("doctor chat 仅支持交互式终端（非交互采集请用 doctor cpu / doctor mem / doctor trace）");
    process.exitCode = 2;
    return;
  }

  let boot;
  try {
    boot = await bootstrap(flags, plugin, commandContext, agentCommands);
  } catch (error) {
    reportError(error, {
      context: "doctor chat/startup",
      summary: "启动失败",
      displayMessage: mapErrorMessage(error),
      plugin: plugin ? `${plugin.id}@${plugin.version}` : undefined,
    });
    process.exitCode = 1;
    return;
  }

  const session = new Session(
    boot.model,
    boot.agent,
    plugin ? `${plugin.id}@${plugin.version}` : undefined,
  );
  if (!process.versions.bun) {
    // 旧内核的 Node SEA 不具备当前 OpenTUI 所需的 FFI，Chat 在该运行时使用行式交互。
    await runPlainRepl(session);
    return;
  }

  await runFullscreenRepl(session);
}

async function runFullscreenRepl(session: Session): Promise<void> {
  const [core, opentuiReact, chatTui, react, chat] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("chat-tui"),
    import("react"),
    import("../chat/controller"),
  ]);
  const {
    createCliRenderer,
    createClipboard,
    createHostClipboard,
    createRendererClipboardAdapter,
  } = core;
  const { createRoot } = opentuiReact;
  const { ChatShell } = chatTui;
  const { createElement } = react;
  const { CHAT_COMMANDS, Controller } = chat;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    autoFocus: false,
  });
  const clipboard = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  });
  const root = createRoot(renderer);

  let finished = false;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  let controller: InstanceType<typeof Controller>;
  const cleanup = async () => {
    if (finished) return;
    finished = true;
    try {
      await Promise.race([
        controller.dispose(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } finally {
      root.unmount();
      try {
        await clipboard.dispose();
      } finally {
        renderer.destroy();
        resolveExit();
      }
    }
  };

  controller = new Controller(session, cleanup);
  const onSignal = () => { void cleanup(); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  root.render(createElement(ChatShell, {
    protocol: controller,
    commands: CHAT_COMMANDS,
    clipboard,
  }));

  await exited;
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
}
