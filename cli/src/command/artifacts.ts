import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

export interface CommandArtifact {
  readonly command: string;
  readonly path: string;
}

interface ArtifactScope {
  artifacts: CommandArtifact[];
  reportName?: string;
}

/** Each invocation owns a scope; parents explicitly include the artifacts they compose. */
export class CommandArtifacts {
  readonly #root: ArtifactScope = { artifacts: [] };
  readonly #scopes = new AsyncLocalStorage<ArtifactScope>();

  #scope(): ArtifactScope { return this.#scopes.getStore() ?? this.#root; }

  setReportName(reportName: string): void {
    const scope = this.#scope();
    if (scope.reportName && scope.reportName !== reportName) {
      throw new Error(`command report name 已设置为 '${scope.reportName}'，不能改为 '${reportName}'`);
    }
    scope.reportName = reportName;
  }

  reportName(): string | undefined { return this.#scope().reportName; }

  add(command: string, path: string): void {
    const absolutePath = resolve(path);
    const scope = this.#scope();
    if (!scope.artifacts.some((artifact) => artifact.path === absolutePath)) {
      scope.artifacts.push({ command, path: absolutePath });
    }
  }

  include(artifacts: readonly CommandArtifact[]): void {
    for (const artifact of artifacts) this.add(artifact.command, artifact.path);
  }

  list(): readonly CommandArtifact[] { return [...this.#scope().artifacts]; }

  /** Async-local ownership keeps concurrent/repeated calls independent without cloning shared context. */
  async capture<T>(work: () => Promise<T>): Promise<{
    value: T; artifacts: readonly CommandArtifact[]; reportName?: string;
  }> {
    const scope: ArtifactScope = { artifacts: [] };
    try {
      return await this.#scopes.run(scope, async () => ({
        value: await work(), artifacts: this.list(), reportName: scope.reportName,
      }));
    } catch (error) {
      // Without a returned child result, preserve its staged evidence on the failing parent.
      this.include(scope.artifacts);
      throw error;
    }
  }
}
