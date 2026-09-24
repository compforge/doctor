import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { CommandArtifact } from "../artifacts";
import type { CommandResult } from "../result";
import type { CommandInput, CommandSpec } from "../spec";
import type { Manifest, StoredFile, ResultRef } from "../manifest";
import type { SerializedOutput } from "./model";

import { summaryNavigation } from "./navigation";
import { projectSummary, renderSummary, summaryText } from "../summary";

interface Node {
  id: string;
  command: string;
  path: string;
  result: CommandResult<unknown>;
  files: Record<string, StoredFile>;
  children: ResultRef[];
  errors: string[];
  pending?: Promise<Node>;
}
interface Session {
  root: string;
  results: WeakMap<object, Map<object, Node>>;
  nodes: Node[];
  sources: Map<string, CommandArtifact>;
  onError?: (error: unknown, command: string) => void;
}

/** Local-only writer. Each child gets its own directory; only the session owns result identity. */
export class SerializeContext {
  private constructor(private readonly session: Session, private readonly node: Node,
    private readonly ancestors: ReadonlySet<Node>) {}

  static async create<Input extends CommandInput, Output>(root: string, spec: Pick<CommandSpec<Input, Output>, "name" | "serialize">,
    result: CommandResult<Output>, onError?: Session["onError"]): Promise<SerializeContext> {
    const session: Session = { root, results: new WeakMap(), nodes: [], sources: new Map(), onError };
    const node = SerializeContext.node(session, spec, result, ".");
    const context = new SerializeContext(session, node, new Set([node]));
    node.pending = context.run(spec, result);
    await node.pending;
    return context;
  }

  private static node<Input extends CommandInput, Output>(session: Session, spec: Pick<CommandSpec<Input, Output>, "name" | "serialize">,
    result: CommandResult<Output>, path?: string): Node {
    const id = randomUUID();
    const command = spec.name.replace(/^doctor\s+/, "");
    const node: Node = { id, command, path: path ?? `artifacts/${id}-${command.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      result, files: {}, children: [], errors: [] };
    let bySpec = session.results.get(result);
    if (!bySpec) { bySpec = new Map(); session.results.set(result, bySpec); }
    bySpec.set(spec, node);
    session.nodes.push(node);
    mkdirSync(join(session.root, node.path), { recursive: true, mode: 0o700 });
    return node;
  }

  get directory(): string { return join(this.session.root, this.node.path); }
  get root(): string { return this.session.root; }
  get failed(): boolean { return this.session.nodes.some(node => node.errors.length > 0); }
  get artifacts(): readonly CommandArtifact[] { return [...this.session.sources.values()]; }

  /** Bind an existing evidence identity to its serialized location for local rendering. */
  bind(artifact: CommandArtifact, directory: string): void {
    this.session.sources.set(artifact.id, { ...artifact, path: this.path(directory) });
  }

  path(file: string): string {
    const path = resolve(this.directory, file);
    const rel = relative(this.directory, path);
    if (isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Invalid serialized file path: ${file}`);
    return path;
  }

  /** Record one unavailable source and let the domain continue serializing independent evidence. */
  failure(error: unknown): void {
    this.node.errors.push(error instanceof Error ? error.message : String(error));
    this.session.onError?.(error, this.node.command);
  }

  annotate(metadata: Pick<Manifest, "source" | "render">): void {
    const manifest = JSON.parse(readFileSync(this.path("manifest.json"), "utf8"));
    this.writeJson("manifest.json", { ...manifest, ...metadata });
  }

  private register(file: string): StoredFile {
    chmodSync(this.path(file), 0o600);
    const descriptor = { path: file, format: extname(file).slice(1) || "binary", bytes: statSync(this.path(file)).size };
    this.node.files[file] = descriptor;
    return descriptor;
  }

  writeJson(file: string, value: unknown): StoredFile {
    const text = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "function" || typeof entry === "symbol" || entry instanceof Map || entry instanceof Set) {
        throw new Error(`Non-serializable value in ${file}`);
      }
      return entry;
    }, 2);
    if (text === undefined) throw new Error(`Missing JSON value for ${file}`);
    return this.writeText(file, `${text}\n`);
  }

  writeText(file: string, text: string): StoredFile {
    const path = this.path(file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const pending = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(pending, text, { mode: 0o600 });
      renameSync(pending, path);
    } finally { rmSync(pending, { force: true }); }
    return this.register(file);
  }

  async writeJsonl(file: string, records: Iterable<unknown> | AsyncIterable<unknown>): Promise<StoredFile> {
    const { open } = await import("node:fs/promises");
    const path = this.path(file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const pending = `${path}.${randomUUID()}.tmp`;
    const handle = await open(pending, "wx", 0o600);
    try {
      for await (const record of records) {
        const line = JSON.stringify(record);
        if (line === undefined) throw new Error(`Missing JSONL record for ${file}`);
        await handle.writeFile(`${line}\n`);
      }
      await handle.close();
      renameSync(pending, path);
    } finally { await handle.close(); rmSync(pending, { force: true }); }
    return this.register(file);
  }

  includeFile(file: string, source: string): StoredFile {
    if (!lstatSync(source).isFile()) throw new Error(`Evidence source must be a regular file: ${source}`);
    const destination = this.path(file);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    return this.register(file);
  }

  /** @spec Shared result objects are serialized once; explicit child links preserve intermediate aggregates. */
  async serialize<Input extends CommandInput, Output>(spec: Pick<CommandSpec<Input, Output>, "name" | "serialize">, result: CommandResult<Output>): Promise<ResultRef> {
    let node = this.session.results.get(result)?.get(spec);
    if (node && this.ancestors.has(node)) throw new Error(`Cyclic command result: ${spec.name}`);
    if (!node) {
      node = SerializeContext.node(this.session, spec, result);
      const child = new SerializeContext(this.session, node, new Set([...this.ancestors, node]));
      node.pending = child.run(spec, result);
    }
    await node.pending;
    const reference = { id: node.id,
      manifest: posix.relative(this.node.path, posix.join(node.path, "manifest.json")) };
    if (!this.node.children.some(child => child.id === node.id)) this.node.children.push(reference);
    return reference;
  }

  private async run<Input extends CommandInput, Output>(spec: Pick<CommandSpec<Input, Output>, "name" | "serialize">, result: CommandResult<Output>): Promise<Node> {
    let output: SerializedOutput = { files: {} };
    try {
      if (!spec.serialize) {
        if (result.artifacts.length || (result.output !== undefined && !result.summary)) throw new Error(`${spec.name} has no serialize implementation`);
      } else output = await spec.serialize(this, result);
    } catch (error) {
      this.failure(error);
    }
    const files = { ...output.files };
    const indexed = new Set(Object.values(files).map(file => file.path));
    for (const [key, file] of Object.entries(this.node.files)) if (!indexed.has(file.path)) files[key] = file;
    const children = [...new Map([...this.node.children, ...(output.children ?? [])].map(ref => [ref.id, ref])).values()];
    const reason = "reason" in result ? result.reason : undefined;
    const manifest: Manifest = { files, children,
      schemaVersion: 2, kind: "command", id: this.node.id, title: result.summary?.title ?? this.node.command,
      source: { command: this.node.command }, execution: { status: result.status, reason },
      serialization: { status: this.node.errors.length ? "failed" : "ok", errors: this.node.errors } };
    const summaryFile = files.summary ?? files["summary.md"];
    let body: string;
    try {
      if (result.summary) {
        files.summarySpec = this.writeJson("summary.json", { summary: result.summary, data: { file: "output.json" } });
        // Commands explicitly choose serializable output; live Extension resources are never persisted here.
        files.output = this.writeJson("output.json", result.output ?? null);
        files.summaryProjection = this.writeJson("summary-projection.json", projectSummary(result.summary, result.output));
        body = renderSummary(result.summary, result.output);
      } else body = summaryFile ? readFileSync(this.path(summaryFile.path), "utf8") : `# ${summaryText(manifest.title)}\n`;
    } catch (error) {
      this.failure(error);
      body = `# ${summaryText(this.node.command)}\n`;
    }
    body += `\n采集状态：${result.status}\n${reason ? `原因：${summaryText(reason)}\n` : ""}`;
    body += this.node.errors.map(error => `序列化缺口：${summaryText(error)}\n`).join("");
    const navigation = summaryNavigation(this.directory, files, children);
    for (const [key, file] of Object.entries(files)) if (file.path === "summary.md") delete files[key];
    files.summary = this.writeText("summary.md", `${body.trimEnd()}${navigation.length ? "\n" + navigation.join("\n") : "\n"}`);
    // Publish the inventory only after all successfully written files and child manifests exist.
    this.writeJson("manifest.json", { ...manifest, serialization: { status: this.node.errors.length ? "failed" : "ok", errors: this.node.errors } });
    return this.node;
  }

  /** Index each manifest's local reports; nested results retain their own inventories. */
  indexReports(): void {
    const visit = (directory: string): void => {
      const path = join(directory, "manifest.json");
      let manifest: Manifest | undefined;
      try { manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const files = { ...manifest?.files };
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(directory, entry.name));
        else if (manifest && entry.isFile() && (entry.name.endsWith(".html") || entry.name === "AGENTS.md")) {
          const file = entry.name;
          const key = file === "report.html" ? "report" : file;
          for (const [alias, value] of Object.entries(files)) if (value.path === file && alias !== key) delete files[alias];
          chmodSync(join(directory, file), 0o600);
          files[key] = { path: file, format: extname(file).slice(1), bytes: statSync(join(directory, file)).size };
        }
      }
      if (manifest) this.writeJson(relative(this.directory, path), { ...manifest, files });
    };
    visit(this.root);
  }
}
