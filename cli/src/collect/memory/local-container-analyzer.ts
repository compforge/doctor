import { resolve } from "node:path";
import {
  listLocalImagesByLabel,
  type LocalContainerEngine,
} from "../../infra/host/container-engine";

const DOCTOR_DEBUG_IMAGE_LABEL = "org.opencontainers.image.title=doctor debug image";
const PYDUMP_ANALYZER_PATH = "/opt/doctor/bin/pydump_analyzer";

function hostArchitecture(): string {
  return process.arch === "x64" ? "amd64" : process.arch;
}

function debugImageScore(image: string, preferredVersion?: string): number {
  let score = 0;
  if (preferredVersion && image.includes(`:${preferredVersion}`)) score += 100;
  if (image.includes(`linux-${hostArchitecture()}`)) score += 10;
  return score;
}

export async function findLocalDoctorDebugImages(
  engine: LocalContainerEngine,
  preferredVersion?: string,
): Promise<string[]> {
  const images = await listLocalImagesByLabel(engine, DOCTOR_DEBUG_IMAGE_LABEL);
  return images.sort((left, right) => {
    const score = debugImageScore(right, preferredVersion) - debugImageScore(left, preferredVersion);
    return score || left.localeCompare(right);
  });
}

export async function supportsPydumpAnalyzer(
  engine: LocalContainerEngine,
  image: string,
): Promise<boolean> {
  const result = await engine.run([
    "run",
    "--rm",
    "--network",
    "none",
    image,
    PYDUMP_ANALYZER_PATH,
    "retained-heap",
    "--help",
  ], { timeoutMs: 60_000 });
  return result.ok;
}

export function localContainerPydumpAnalyzerArgv(
  engine: LocalContainerEngine,
  image: string,
  heapPath: string,
  topN = 100,
): string[] {
  const absoluteHeap = resolve(heapPath);
  const containerHeap = "/doctor-input/input.pyheap";
  return [
    engine.name,
    "run",
    "--rm",
    "--network",
    "none",
    "--volume",
    `${absoluteHeap}:${containerHeap}:ro`,
    "--env",
    "PYHEAP_CACHE_DIR=/tmp/doctor-pydump/cache",
    image,
    PYDUMP_ANALYZER_PATH,
    "retained-heap",
    "--file",
    containerHeap,
    "--top-n",
    String(topN),
    "--format",
    "json",
  ];
}
