import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export interface CommandArtifact {
  readonly id: string;
  readonly command: string;
  readonly path: string;
}

export type CommandArtifactInput = Omit<CommandArtifact, "id"> & { readonly id?: string };

interface ArtifactScope {
  artifacts: Map<string, CommandArtifact>;
  reportName?: string;
}

/** Each invocation selects artifact references; identity belongs to the whole command tree. */
export class CommandArtifacts {
  readonly #root: ArtifactScope = { artifacts: new Map() };
  readonly #scopes = new AsyncLocalStorage<ArtifactScope>();
  readonly #byId = new Map<string, CommandArtifact>();
  readonly #byPath = new Map<string, CommandArtifact>();

  #scope(): ArtifactScope { return this.#scopes.getStore() ?? this.#root; }

  setReportName(reportName: string): void {
    const scope = this.#scope();
    if (scope.reportName && scope.reportName !== reportName) {
      throw new Error(`command report name 已设置为 '${scope.reportName}'，不能改为 '${reportName}'`);
    }
    scope.reportName = reportName;
  }

  reportName(): string | undefined { return this.#scope().reportName; }

  /** @rule Adding an existing reference preserves its ID, including across idempotent command results. */
  add(artifact: CommandArtifactInput): CommandArtifact;
  add(artifacts: readonly CommandArtifactInput[]): readonly CommandArtifact[];
  add(input: CommandArtifactInput | readonly CommandArtifactInput[]): CommandArtifact | readonly CommandArtifact[] {
    if ("command" in input) return this.#add(input);
    return input.map(artifact => this.#add(artifact));
  }

  #add(input: CommandArtifactInput): CommandArtifact {
    const path = resolve(input.path);
    const byId = input.id === undefined ? undefined : this.#byId.get(input.id);
    const byPath = this.#byPath.get(path);
    const existing = byId ?? byPath;
    if (existing && (existing.path !== path || existing.command !== input.command
      || (input.id !== undefined && existing.id !== input.id))) {
      throw new Error(`Artifact identity conflict: ${input.id ?? existing.id} (${input.command})`);
    }
    const artifact = existing ?? Object.freeze({ id: input.id ?? randomUUID(), command: input.command, path });
    this.#byId.set(artifact.id, artifact);
    this.#byPath.set(path, artifact);
    this.#scope().artifacts.set(artifact.id, artifact);
    return artifact;
  }

  list(): readonly CommandArtifact[] { return [...this.#scope().artifacts.values()]; }

  /** Async-local selection keeps concurrent calls independent without cloning the shared context. */
  async capture<T>(work: () => Promise<T>): Promise<{
    value: T; artifacts: readonly CommandArtifact[]; reportName?: string;
  }> {
    const scope: ArtifactScope = { artifacts: new Map() };
    try {
      return await this.#scopes.run(scope, async () => ({
        value: await work(), artifacts: this.list(), reportName: scope.reportName,
      }));
    } catch (error) {
      // Without a returned child result, preserve its staged evidence on the failing parent.
      this.add([...scope.artifacts.values()]);
      throw error;
    }
  }
}
