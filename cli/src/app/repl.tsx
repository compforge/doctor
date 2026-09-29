import { isInteractive } from "../terminal/policy";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";

import { runPlainRepl } from "../chat/plain-repl";
import { Session, type ChatRestart, type RestartChat } from "../chat/session";
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

  let nextFlags = flags;
  while (true) {
    const restart = await runChatSession(nextFlags, plugin, commandContext, agentCommands);
    if (!restart) return;
    nextFlags = { ...flags, continue: false, resume: undefined, session: restart.session,
      noSession: restart.session ? false : flags.noSession };
  }
}

async function runChatSession(
  flags: CliFlags,
  plugin: PluginDefinition | undefined,
  commandContext: CommandContext,
  agentCommands?: Readonly<Record<string, DistributionManifest>>,
): Promise<ChatRestart | undefined> {
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
    boot.history, boot.historyStore,
  );
  let restart: ChatRestart | undefined;
  const onRestart: RestartChat = (request) => { restart = request; };
  // SEA ships the native assets and enables FFI; Node 22 and runtime-free bundles keep the plain REPL.
  const nodeFullscreen = !process.versions.bun
    && process.getBuiltinModule?.("node:sea")?.isSea()
    && !!process.getBuiltinModule?.("node:ffi");
  if (!process.versions.bun && !nodeFullscreen) {
    await runPlainRepl(session, onRestart);
    return restart;
  }

  await runFullscreenRepl(session, onRestart);
  return restart;
}

async function runFullscreenRepl(session: Session, onRestart: RestartChat): Promise<void> {
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
      // Drain finalized message writes before tearing down the session.
      await controller.dispose();
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

  controller = new Controller(session, cleanup, async (request) => {
    await onRestart(request);
    await cleanup();
  });
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
