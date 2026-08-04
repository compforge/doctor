import type {
  LocalCommandResult,
  LocalContainerEngine,
  LocalContainerEngineName,
} from "./model";

export type LocalImagePreparation =
  | { state: "already-ready" | "loaded"; engine: LocalContainerEngineName; image: string }
  | { state: "failed"; engine: LocalContainerEngineName; image: string; reason: string };

function commandFailure(result: LocalCommandResult): string {
  if (result.timedOut) return "命令超时";
  return result.stderr.trim()
    || result.stdout.trim()
    || result.errorCode
    || `exit=${result.exitCode ?? "unknown"}`;
}

export async function prepareLocalImage(
  engine: LocalContainerEngine,
  archive: string,
  sourceImage: string,
): Promise<LocalImagePreparation> {
  const inspected = await engine.run(["image", "inspect", sourceImage], { timeoutMs: 20_000 });
  if (inspected.ok) {
    return { state: "already-ready", engine: engine.name, image: sourceImage };
  }

  const loaded = await engine.run(["load", "-i", archive], { timeoutMs: 10 * 60_000 });
  if (!loaded.ok) {
    return {
      state: "failed",
      engine: engine.name,
      image: sourceImage,
      reason: commandFailure(loaded),
    };
  }
  const verified = await engine.run(["image", "inspect", sourceImage], { timeoutMs: 20_000 });
  if (!verified.ok) {
    return {
      state: "failed",
      engine: engine.name,
      image: sourceImage,
      reason: `load 完成后无法确认 image：${commandFailure(verified)}`,
    };
  }
  return { state: "loaded", engine: engine.name, image: sourceImage };
}

export async function listLocalImagesByLabel(
  engine: LocalContainerEngine,
  label: string,
): Promise<string[]> {
  const listed = await engine.run([
    "image",
    "ls",
    "--filter",
    `label=${label}`,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ], { timeoutMs: 20_000 });
  if (!listed.ok) return [];
  return [...new Set(
    listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.includes("<none>")),
  )].sort((left, right) => left.localeCompare(right));
}
