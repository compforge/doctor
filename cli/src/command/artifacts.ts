import { resolve } from "node:path";

export interface CommandArtifact {
  readonly command: string;
  readonly path: string;
}

/** Files or directories produced during one top-level command invocation. */
export class CommandArtifacts {
  readonly #artifacts: CommandArtifact[] = [];

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
