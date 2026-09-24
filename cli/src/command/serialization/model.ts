import type { ResultRef, StoredFile } from "../manifest";

export interface SerializedOutput {
  readonly files: Readonly<Record<string, StoredFile>>;
  readonly children?: readonly ResultRef[];
}
