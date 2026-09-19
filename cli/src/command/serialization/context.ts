import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { CommandArtifact } from "../artifacts";
import type { CommandResult } from "../result";
import type { CommandInput, CommandSpec } from "../spec";
import type { CommandManifest, SerializedOutput, StoredFile, StoredResultRef } from "./model";

interface Node {
  id: string;
  command: string;
  path: string;
  result: CommandResult<unknown>;
  files: Record<string, StoredFile>;
  children: StoredResultRef[];
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

  annotate(metadata: Record<string, unknown>): void {
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
  async serialize<Input extends CommandInput, Output>(spec: Pick<CommandSpec<Input, Output>, "name" | "serialize">, result: CommandResult<Output>): Promise<StoredResultRef> {
    let node = this.session.results.get(result)?.get(spec);
    if (node && this.ancestors.has(node)) throw new Error(`Cyclic command result: ${spec.name}`);
    if (!node) {
      node = SerializeContext.node(this.session, spec, result);
      const child = new SerializeContext(this.session, node, new Set([...this.ancestors, node]));
      node.pending = child.run(spec, result);
    }
    await node.pending;
    const reference = { executionId: node.id, command: node.command,
      manifest: posix.relative(this.node.path, posix.join(node.path, "manifest.json")) };
    if (!this.node.children.some(child => child.executionId === node.id)) this.node.children.push(reference);
    return reference;
  }

  private async run<Input extends CommandInput, Output>(spec: Pick<CommandSpec<Input, Output>, "name" | "serialize">, result: CommandResult<Output>): Promise<Node> {
    let output: SerializedOutput = { files: {} };
    try {
      if (!spec.serialize) {
        if (result.artifacts.length || result.output !== undefined) throw new Error(`${spec.name} has no serialize implementation`);
      } else output = await spec.serialize(this, result);
    } catch (error) {
      this.failure(error);
    }
    const files = { ...output.files };
    const indexed = new Set(Object.values(files).map(file => file.path));
    for (const [key, file] of Object.entries(this.node.files)) if (!indexed.has(file.path)) files[key] = file;
    const { metadata, ...entries } = output;
    const manifest: CommandManifest = { ...metadata, ...entries, files, children: this.node.children,
      schemaVersion: 1, executionId: this.node.id, command: this.node.command,
      status: result.status, reason: "reason" in result ? result.reason : undefined,
      serialization: { status: this.node.errors.length ? "failed" : "ok", errors: this.node.errors } };
    // Publish the inventory only after all successfully written files and child manifests exist.
    this.writeJson("manifest.json", manifest);
    return this.node;
  }

  /** Include only local render outputs, after render has completed; raw and result metadata stay unchanged. */
  indexReports(): void {
    for (const node of this.session.nodes) {
      const path = join(this.root, node.path, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as CommandManifest;
      const context = new SerializeContext(this.session, node, new Set([node]));
      const files = { ...manifest.files };
      const index = (directory: string, prefix = "") => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.name === "artifacts") continue; // Descendants own their execution inventories.
          const file = posix.join(prefix, entry.name);
          if (entry.isDirectory()) index(join(directory, entry.name), file);
          else if (entry.isFile() && (file.endsWith(".html") || file === "AGENTS.md")) {
            const key = file === "report.html" ? "report"
              : Object.entries(files).find(([, value]) => value.path === file)?.[0] ?? file;
            // Imported reports and newly rendered reports share one public file key.
            for (const [alias, entry] of Object.entries(files)) if (entry.path === file && alias !== key) delete files[alias];
            files[key] = context.register(file);
          }
        }
      };
      index(context.directory);
      context.writeJson("manifest.json", { ...manifest, files });
    }
  }
}
