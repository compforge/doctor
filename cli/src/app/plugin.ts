import { terminalStdout } from "../terminal/output";
import { installPlugin, uninstallPlugin } from "../plugin";

export async function runPluginInstall(archive: string): Promise<void> {
  const result = await installPlugin(archive);
  terminalStdout.success(
    `plugin: ${result.ref} (${result.installed ? "installed and loaded" : "already installed; loaded"})\n`,
  );
}

export function runPluginUninstall(ref: string): void {
  uninstallPlugin(ref);
  terminalStdout.success(`plugin: ${ref} (unloaded and uninstalled)\n`);
}
