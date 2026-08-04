// kubectl port-forward 生命周期管理：让 collect domain 从运维机访问集群内服务。
// ClusterIP 通常不可从集群外直达，而 kubeconfig 是现场已有的最小凭据面，
// 所以沿用「kubectl 是传输层」的 collect 约定，不要求现场额外开网络。
import { buildKubectlArgs, type KubectlOptions } from "./executor";
import { sleep, spawnProcess, type RuntimeProcess } from "../host/process";

export interface PortForward {
  target: PortForwardTarget;
  localPort: number;
  /** 完整 argv，进 evidence manifest 供审计复现 */
  command: string[];
  stop(): void;
}

export interface PortForwardTarget {
  kind: "service" | "pod";
  name: string;
}

export interface PortForwardResult {
  ok: boolean;
  value?: PortForward;
  reason?: string;
}

export type StartPortForward = typeof startPortForward;

/**
 * 起 `kubectl port-forward svc/<service> 0:<remotePort>` 并等待就绪。
 * 本地端口让 kubectl 自选（0:），从 stdout 的 "Forwarding from 127.0.0.1:<port>" 解析，
 * 避免固定端口在运维机上撞占用。调用方负责在采集结束后 stop()。
 */
export async function startPortForward(
  opts: KubectlOptions & {
    service?: string;
    target?: PortForwardTarget;
    remotePort: number;
    timeoutMs?: number;
  },
): Promise<PortForwardResult> {
  const target = opts.target ?? (opts.service ? { kind: "service", name: opts.service } : undefined);
  if (!target) return { ok: false, reason: "port-forward 缺少 Service/Pod 目标" };
  const argv = buildKubectlArgs(opts, [
    "port-forward",
    `${target.kind === "service" ? "svc" : "pod"}/${target.name}`,
    `0:${opts.remotePort}`,
    "--address",
    "127.0.0.1",
  ]);
  let proc: RuntimeProcess;
  try {
    proc = spawnProcess(argv);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const stderrPromise = new Response(proc.stderr as ReadableStream).text();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let out = "";

  for (;;) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    const chunk = await Promise.race([
      reader.read(),
      sleep(remain).then(() => "timeout" as const),
      proc.exited.then(() => "exited" as const).catch((error: unknown) => ({ error })),
    ]);
    if (chunk === "timeout") break;
    if (typeof chunk === "object" && "error" in chunk) {
      proc.kill();
      return { ok: false, reason: chunk.error instanceof Error ? chunk.error.message : String(chunk.error) };
    }
    // 进程退出（RBAC 拒绝 / svc 不存在等）或流关闭：跳出后统一取 stderr 作原因
    if (chunk === "exited" || chunk.done) break;
    out += decoder.decode(chunk.value);
    const m = out.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (m) {
      return {
        ok: true,
        value: { target, localPort: Number(m[1]), command: argv, stop: () => proc.kill() },
      };
    }
  }

  proc.kill();
  const stderr = await stderrPromise.catch(() => "");
  const reason = stderr.trim().split("\n")[0] || `port-forward 未就绪（${timeoutMs}ms 超时）`;
  return { ok: false, reason };
}

/** 同一次诊断可能按拓扑建立多个 forward；scope 保证异常路径也能一次性回收。 */
export class PortForwardScope {
  readonly #forwards: PortForward[] = [];
  readonly #stopOnExit = () => this.stop();

  constructor(private readonly starter: StartPortForward = startPortForward) {}

  get active(): readonly PortForward[] {
    return this.#forwards;
  }

  async start(
    opts: KubectlOptions & { target: PortForwardTarget; remotePort: number; timeoutMs?: number },
  ): Promise<PortForwardResult> {
    const result = await this.starter(opts);
    if (result.value) {
      if (this.#forwards.length === 0) process.once("exit", this.#stopOnExit);
      this.#forwards.push(result.value);
    }
    return result;
  }

  stop(): void {
    process.off("exit", this.#stopOnExit);
    for (const forward of this.#forwards.splice(0).reverse()) forward.stop();
  }
}
