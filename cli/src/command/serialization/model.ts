import type { CommandStatus } from "../status";

export interface StoredFile {
  readonly path: string;
  readonly format: string;
  readonly bytes: number;
}

export interface StoredResultRef {
  readonly executionId: string;
  readonly command: string;
  readonly manifest: string;
}

/** A domain serializer declares files and direct child results, never another copy of their bodies. */
export interface SerializedOutput {
  readonly files: Readonly<Record<string, StoredFile>>;
  readonly children?: readonly StoredResultRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CommandManifest extends SerializedOutput {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly command: string;
  readonly status: CommandStatus;
  readonly reason?: string;
  readonly serialization: { readonly status: "ok" | "failed"; readonly errors: readonly string[] };
}
