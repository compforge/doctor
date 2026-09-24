import type { KubernetesCommandConfig } from "./kubernetes-target";
import type { CommandStatus } from "./status";

export interface StoredFile {
  readonly path: string;
  readonly format: string;
  readonly bytes: number;
}

export interface ResultSource {
  readonly command: string;
  readonly profile?: string;
  readonly plugin?: string;
  readonly targets?: readonly KubernetesCommandConfig["kubernetes"][];
}

export interface ExecutionStatus {
  readonly status: CommandStatus;
  readonly reason?: string;
}

export interface ResultRef {
  readonly id: string;
  readonly manifest: string;
}

/** Portable inventory only. Domain values and collection metadata live in indexed files. */
export interface Manifest {
  readonly files: Readonly<Record<string, StoredFile>>;
  readonly schemaVersion: 2;
  readonly kind: "command" | "artifact";
  readonly id: string;
  readonly title: string;
  readonly source: ResultSource;
  readonly execution: ExecutionStatus;
  readonly serialization: { readonly status: "ok" | "failed"; readonly errors: readonly string[] };
  readonly children: readonly ResultRef[];
  readonly render?: { readonly status: "ok" | "failed"; readonly errors: readonly { command: string; reason: string }[] };
  readonly delivery?: { readonly status: "ok" | "failed"; readonly errors: readonly string[];
    readonly exitCode: number; readonly location: { readonly directory: string; readonly manifest: string } };
}
