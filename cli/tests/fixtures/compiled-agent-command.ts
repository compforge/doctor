import { join } from "node:path";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { prepareAgentCommands } from "../../src/app/agent-commands";

if (process.argv.includes("--distribution")) {
  process.stdout.write(JSON.stringify(process.argv.slice(2)));
} else {
  const prepared = prepareAgentCommands({
    samplectl: { name: "samplectl", plugin: "sample@1.0.0" },
  }, { id: "sample", version: "1.0.0", services: createServiceCatalog([]) } satisfies PluginDefinition, {
    profileName: "chosen", configPath: "/tmp/doctor-config.yaml",
  });
  try {
    const command = join(prepared.shellEnv.PATH!.split(":")[0]!, "samplectl");
    const result = Bun.spawnSync({ cmd: [command, "version"], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode ?? 1;
    } else {
      process.stdout.write(result.stdout);
    }
  } finally {
    prepared.dispose();
  }
}
