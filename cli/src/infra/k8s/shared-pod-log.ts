import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@compforge/doctor-toolkit/client";
import { dataSourceKey } from "@compforge/doctor-toolkit/datasource";
import { ConcurrencyPool } from "@compforge/doctor-toolkit/concurrency";
import { LogCaptureFile } from "./log-capture-file";
import { logTimestampNanos } from "./log-timestamp";
import { DEFAULT_POD_LOG_CAPTURE_POLICY, PodLogByteBudget, runPodLogCapturePlan, type PodLogCapturePolicy } from "./log-capture-plan";
import type { KubernetesPodLogAccess, PodLogRequest, PodLogResult } from "./pod-log";

interface CaptureSource {
  file: LogCaptureFile;
  result: Promise<PodLogResult | undefined>;
}

export interface PodLogSourceScope {
  kubeconfig?: string;
  context?: string;
  namespace: string;
  /** Pod UID and runtime container ID, including the previous instance when selected. */
  instance?: string;
}

/**
 * @spec One root execution reads an identical source/window once; each consumer owns its filtering and raw copy.
 * Network capacity and byte reservations apply before transport, never to local replay.
 */
export class SharedPodLogCaptures implements Client {
  readonly #sources = new Map<string, CaptureSource>();
  readonly #consumers = new Set<Promise<unknown>>();
  readonly #budget: PodLogByteBudget;
  #directory?: string;
  #disposal?: Promise<void>;

  constructor(
    private readonly pool: ConcurrencyPool,
    private readonly signal: AbortSignal,
    private readonly policy: PodLogCapturePolicy = { ...DEFAULT_POD_LOG_CAPTURE_POLICY, concurrency: pool.concurrency },
  ) { this.#budget = new PodLogByteBudget(policy.maxTotalBytes); }

  async initialize(): Promise<void> {
    this.signal.throwIfAborted();
    this.#directory ??= mkdtempSync(join(tmpdir(), "doctor-log-sources-"));
  }

  capture(
    access: KubernetesPodLogAccess, scope: PodLogSourceScope, request: PodLogRequest, onReuse?: () => void,
  ): Promise<PodLogResult | undefined> {
    this.signal.throwIfAborted();
    if (!this.#directory || this.#disposal) throw new Error("Log capture session is not active");
    // Relative windows move with time. Missing instance identity must never reuse another Pod's evidence.
    const key = scope.instance && request.sinceTime ? dataSourceKey("pod-log", {
      scope,
      pod: request.pod, container: request.container, previous: !!request.previous,
      allContainers: !!request.allContainers, prefix: !!request.prefix, tail: request.tail,
      sinceTime: logTimestampNanos(request.sinceTime)?.toString(),
      untilTime: request.untilTime ? logTimestampNanos(request.untilTime)?.toString() : undefined,
      limitBytes: request.limitBytes,
    }) : randomUUID();
    let source = this.#sources.get(key);
    const reused = source !== undefined;
    if (!source) {
      const file = new LogCaptureFile(join(this.#directory, `${randomUUID()}.log`));
      const result = Promise.resolve().then(async () => {
        try {
          const captures = await runPodLogCapturePlan(access, [{ target: undefined, request: {
            ...request, rawFilePath: undefined, collectStdout: false, onLine: line => file.append(line),
          } }], this.policy, this.pool, this.signal, this.#budget);
          const capture = captures[0]?.capture;
          return capture;
        } finally { file.finish(); }
      });
      // The consumer follows the spool before awaiting the result; observe early rejection in the meantime.
      void result.catch(() => {});
      source = { file, result };
      this.#sources.set(key, source);
    } else onReuse?.();
    const pending = this.#consume(source, request, reused);
    this.#consumers.add(pending);
    void pending.then(() => this.#consumers.delete(pending), () => this.#consumers.delete(pending));
    return pending;
  }

  async #consume(source: CaptureSource, request: PodLogRequest, reused: boolean): Promise<PodLogResult | undefined> {
    const started = Date.now();
    await source.file.follow(request.onLine ?? (() => {}));
    // Each result remains self-contained after root cleanup and independently deliverable on partial failure.
    if (request.rawFilePath) copyFileSync(source.file.path, request.rawFilePath);
    const result = await source.result;
    return result && { ...result, durationMs: Date.now() - started, bytesRead: reused ? 0 : result.bytesRead, reused };
  }

  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      await Promise.allSettled([...this.#sources.values()].map(source => source.result));
      await Promise.allSettled(this.#consumers);
      for (const source of this.#sources.values()) source.file.close();
      this.#sources.clear();
      if (this.#directory) rmSync(this.#directory, { recursive: true, force: true });
    })();
  }
}
