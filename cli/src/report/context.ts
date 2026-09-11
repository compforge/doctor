import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CommandArtifact } from "../command/artifacts";
import type { CommandResult } from "../command/result";
import type { CommandInput, CommandSpec } from "../command/spec";
import type { Report, ReportPage } from "./model";

/** Local evidence only: renderers cannot acquire infra clients or execute commands through this context. */
export class RenderContext {
  readonly #artifacts: Map<string, CommandArtifact>;
  readonly #results = new WeakMap<object, Map<object, Promise<Report>>>();
  readonly #pages = new Map<string, Promise<void>>();
  readonly failures: { command: string; error: unknown }[] = [];

  constructor(artifacts: readonly CommandArtifact[], readonly profileName: string,
    private readonly onError?: (error: unknown, command: string) => void) {
    this.#artifacts = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  }

  artifact(id: string): CommandArtifact {
    const artifact = this.#artifacts.get(id);
    if (!artifact) throw new Error(`报告引用了未登记的 Artifact: ${id}`);
    return artifact;
  }

  path(artifact: CommandArtifact, file: string): string {
    const root = this.artifact(artifact.id).path;
    const path = resolve(root, file);
    const rel = relative(root, path);
    if (isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`无效报告文件: ${file}`);
    return path;
  }

  read(artifact: CommandArtifact, file: string): string { return readFileSync(this.path(artifact, file), "utf8"); }
  json<T>(artifact: CommandArtifact, file: string): T { return JSON.parse(this.read(artifact, file)) as T; }

  page(artifact: CommandArtifact, page: Omit<ReportPage, "id" | "source">, file = "report.html"): ReportPage {
    this.path(artifact, file);
    return { ...page, id: `${artifact.id}:${file}`, source: { artifactId: artifact.id, file } };
  }

  write(artifact: CommandArtifact, html: string, file = "report.html"): void {
    writeFileSync(this.path(artifact, file), html, { mode: 0o600 });
  }

  /** Several subjects may refer to one physical view; materialize it once without dropping either reference. */
  materialize(artifact: CommandArtifact, render: () => void | Promise<void>, file = "report.html"): Promise<void> {
    const key = `${artifact.id}:${file}`;
    let pending = this.#pages.get(key);
    if (!pending) { pending = Promise.resolve().then(render); this.#pages.set(key, pending); }
    return pending;
  }

  failed(command: string, error: unknown): void {
    this.failures.push({ command, error });
    this.onError?.(error, command);
  }

  /** Concurrent parents share one render of the same result; failure stays visible beside other reports. */
  render<Input extends CommandInput, Output>(spec: CommandSpec<Input, Output>, result: CommandResult<Output>): Promise<Report> {
    let renders = this.#results.get(result);
    if (!renders) { renders = new Map(); this.#results.set(result, renders); }
    let rendering = renders.get(spec);
    if (!rendering) {
      rendering = Promise.resolve().then(() => spec.render ? spec.render(this, result) : { title: spec.name, sections: [] })
        .catch(error => {
          this.failed(spec.name, error);
          return failureReport(spec.name, result, error instanceof Error ? error.message : String(error));
        });
      renders.set(spec, rendering);
    }
    return rendering;
  }
}

export function failureReport(title: string, result: CommandResult<unknown>, reason?: string): Report {
  const status = result.status;
  return { title, sections: [{ id: title.replace(/^doctor /, ""), title: title.replace(/^doctor /, ""), status,
    pages: [{ id: `${title}:unavailable`, title, status, renderError: reason, reason: ("reason" in result ? result.reason : undefined) ?? "未形成可用结果" }] }] };
}
