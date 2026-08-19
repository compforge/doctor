import { resolve } from "node:path";

export interface CommandArtifact {
  readonly command: string;
  readonly path: string;
}

/** Files or directories produced during one top-level command invocation. */
export class CommandArtifacts {
  readonly #artifacts: CommandArtifact[] = [];
  #reportName: string | undefined;

  /** Domain scope may name the aggregate, while finalize remains the sole owner of delivery paths. */
  setReportName(reportName: string): void {
    if (this.#reportName && this.#reportName !== reportName) {
      throw new Error(`command report name 已设置为 '${this.#reportName}'，不能改为 '${reportName}'`);
    }
    this.#reportName = reportName;
  }

  reportName(): string | undefined {
    return this.#reportName;
  }

  add(command: string, path: string): void {
    const absolutePath = resolve(path);
    if (!this.#artifacts.some((artifact) => artifact.path === absolutePath)) {
      this.#artifacts.push({ command, path: absolutePath });
    }
  }

  list(): readonly CommandArtifact[] {
    return [...this.#artifacts];
  }
}
