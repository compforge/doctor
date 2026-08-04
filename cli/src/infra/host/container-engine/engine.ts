import { runLocalCommand } from "./command";
import type {
  LocalCommandRunner,
  LocalContainerEngine,
  LocalContainerEngineName,
} from "./model";

const ENGINE_CANDIDATES: readonly LocalContainerEngineName[] = [
  "docker",
  "podman",
  "nerdctl",
];

export async function discoverLocalContainerEngine(
  runner: LocalCommandRunner = runLocalCommand,
  candidates: readonly LocalContainerEngineName[] = ENGINE_CANDIDATES,
): Promise<LocalContainerEngine | undefined> {
  for (const name of candidates) {
    const result = await runner([name, "info"], { timeoutMs: 10_000 });
    if (result.ok) {
      return {
        name,
        run: (argv, options) => runner([name, ...argv], options),
      };
    }
  }
  return undefined;
}
