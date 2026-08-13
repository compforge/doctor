import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { ChatShell } from "chat-tui";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";

import { CHAT_COMMANDS, Controller, Session } from "../chat";
import type { CliFlags } from "../protocol";
import { mapErrorMessage } from "../protocol";
import { bootstrap } from "./bootstrap";
import { reportError } from "./error-log";

export async function runRepl(
  flags: CliFlags,
  plugin?: PluginDefinition,
  commandContext?: CommandContext,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "doctor chat 仅支持交互式终端（非交互采集请用 doctor cpu / doctor mem / doctor trace）\n",
    );
    process.exitCode = 2;
    return;
  }

  let boot;
  try {
    boot = await bootstrap(flags, plugin, commandContext);
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
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    autoFocus: false,
  });
  const root = createRoot(renderer);

  let finished = false;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  let controller: Controller;
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
      renderer.destroy();
      resolveExit();
    }
  };

  controller = new Controller(session, cleanup);
  const onSignal = () => { void cleanup(); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  root.render(<ChatShell protocol={controller} commands={CHAT_COMMANDS} />);

  await exited;
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
}
