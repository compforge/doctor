import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { parseDistributionManifest, type DistributionManifest } from "./distribution";

export interface AgentCommandTarget {
  profileName: string;
  configPath: string;
  kubeconfig?: string;
  context?: string;
  namespace?: string;
}

export interface PreparedAgentCommands {
  shellEnv: Record<string, string>;
  dispose(): void;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function currentDoctorCommand(): string[] {
  const entry = process.argv[1];
  // Bun exposes the bundled source under /$bunfs/; only a real JS/TS entry needs the runtime.
  return entry && !entry.startsWith("/$bunfs/") && /\.(?:[cm]?js|tsx?)$/.test(entry) && resolve(entry) !== resolve(process.execPath)
    ? [process.execPath, resolve(entry)]
    : [process.execPath];
}

/** Prepare one PATH entry for every Bash invocation in this local Agent session. */
export function prepareAgentCommands(
  commands: Readonly<Record<string, DistributionManifest>>,
  plugin: PluginDefinition | undefined,
  target: AgentCommandTarget,
  doctorCommand = currentDoctorCommand(),
): PreparedAgentCommands {
  const entries = Object.entries(commands);
  if (entries.length === 0) return { shellEnv: {}, dispose() {} };
  const root = mkdtempSync(join(tmpdir(), "doctor-agent-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o700 });
    for (const [name, input] of entries) {
      if (name !== basename(name) || !/^[a-z][a-z0-9-]*$/.test(name)) {
        throw new Error(`Invalid Agent command name: ${name}`);
      }
      const manifest = parseDistributionManifest(input);
      if (manifest.name !== name) throw new Error(`Agent command ${name} must use the same Distribution name`);
      const actualPlugin = plugin && `${plugin.id}@${plugin.version}`;
      if (manifest.plugin !== actualPlugin) {
        throw new Error(`Agent command ${name} requires the current Plugin ${actualPlugin ?? "none"}`);
      }
      const json = join(root, `${name}.json`);
      writeFileSync(json, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      const args = [
        ...doctorCommand,
        "--distribution", json,
        "--config", target.configPath,
        ...(target.kubeconfig ? ["--kubeconfig", target.kubeconfig] : []),
        ...(target.context ? ["--context", target.context] : []),
        ...(target.namespace ? ["--namespace", target.namespace] : []),
      ];
      // Keep per-call arguments last so an Agent can target another env without switching its Chat profile.
      writeFileSync(join(bin, name), [
        "#!/bin/sh",
        `exec ${args.map(shellWord).join(" ")} "$@"`,
        "",
      ].join("\n"), { mode: 0o700 });
    }
    return {
      shellEnv: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOCTOR_PROFILE: target.profileName,
      },
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
