export {
  choosePydumpLoader,
  pydumpBackend,
  resolveHostPydumpAnalyzer,
  resolveKubernetesPydumpCaptureTools,
} from "./pydump";
export { pyheapBackend, resolveKubernetesPyHeapDumper } from "./pyheap";
export {
  compressFileCmd,
  fileMetadataCmd,
  localPydumpRetainedArgv,
  parseFileMetadata,
  parsePydumpPrereqs,
  parsePydumpTargetLibc,
  parseTargetPythonMinor,
  pydumpAgentInventoryCmd,
  pydumpPrereqCmd,
  runPydumpDumpCmd,
  selectPydumpAgentFromInventory,
  targetLibcCmd,
  targetPythonMinorCmd,
  type FileMetadata,
  type PydumpPrereqs,
  type PydumpTargetLibc,
} from "./pydump-tool";
export {
  parsePyheapPrereqs,
  pyheapPrereqCmd,
  runPyheapDumpCmd,
  type PyheapPrereqs,
} from "./pyheap-tool";
export type {
  HeapDumpBackend,
  HeapDumpBackendContext,
  HeapDumpBackendKind,
  HeapDumpBackendObservation,
  HeapDumpBackendResult,
  HeapDumpExecution,
  HeapDumpRuntime,
  HeapDumpStrategy,
  PreparedHeapDump,
} from "./model";

import { pydumpBackend } from "./pydump";
import { pyheapBackend } from "./pyheap";
import type { HeapDumpBackendKind } from "./model";

export interface HeapDumpBackendMetadata {
  readonly kind: HeapDumpBackendKind;
  readonly displayName: string;
  readonly toolDir: string;
  readonly version: string;
  readonly cleanupCommand: () => string[];
}

export function heapDumpBackendMetadata(kind: HeapDumpBackendKind): HeapDumpBackendMetadata {
  const backend = kind === "pydump" ? pydumpBackend : pyheapBackend;
  return {
    kind: backend.kind,
    displayName: backend.displayName,
    toolDir: backend.toolDir,
    version: backend.version,
    cleanupCommand: backend.cleanupCommand,
  };
}
