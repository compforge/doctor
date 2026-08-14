export { pyheapBackend, resolveKubernetesPyHeapDumper } from "./pyheap";
export {
  compressFileCmd,
  fileMetadataCmd,
  parseFileMetadata,
  type FileMetadata,
} from "./file";
export {
  localPydumpRetainedArgv,
  PYDUMP_ANALYSIS_VERSION,
  resolveHostPydumpAnalyzer,
} from "./analysis-tool";
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

import { pyheapBackend } from "./pyheap";
export interface HeapDumpBackendMetadata {
  readonly kind: "pyheap";
  readonly displayName: string;
  readonly toolDir: string;
  readonly version: string;
  readonly cleanupCommand: () => string[];
}

export function heapDumpBackendMetadata(): HeapDumpBackendMetadata {
  const backend = pyheapBackend;
  return {
    kind: backend.kind,
    displayName: backend.displayName,
    toolDir: backend.toolDir,
    version: backend.version,
    cleanupCommand: backend.cleanupCommand,
  };
}
