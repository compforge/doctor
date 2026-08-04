import type { PickResult } from "../../infra/k8s/target";
import processProbeSource from "./process_probe.py" with { type: "text" };

export const PROCESS_SCAN_SOURCE: string = processProbeSource;

export function processScanCmd(): string[] {
  // 保留既有 argv 形状，避免依赖 process scan 契约的其它 collect command 发生无关变化；
  // 精简后的探针只读取 /proc，不再解释这些历史位置参数。
  return ["python3", "-", "procscan", "--local"];
}

export interface ProcRow {
  pid: number;
  comm: string;
  rssMb: number;
  threads: number;
  fds: number;
}

export interface ProcScan {
  rows: ProcRow[];
  /** 优先为 Uvicorn worker；无法识别拓扑时回退为 threads>4 的 Python worker。 */
  workers: number[];
  uvicorn?: {
    masterPid: number;
    workerPids: number[];
  };
}

const ROW_RE = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s*$/;

export function parseProcscan(out: string): ProcScan {
  const rows: ProcRow[] = [];
  let workers: number[] = [];
  let uvicorn: ProcScan["uvicorn"];
  for (const line of out.split("\n")) {
    const match = ROW_RE.exec(line);
    if (match) {
      rows.push({
        pid: Number(match[1]),
        comm: match[2]!,
        rssMb: Number(match[3]),
        threads: Number(match[4]),
        fds: Number(match[5]),
      });
      continue;
    }
    const workerLine = line.match(/^python workers \(threads>4\):\s*(.*)$/);
    if (workerLine) {
      workers = (workerLine[1] ?? "")
        .split(/\s+/)
        .filter((value) => /^\d+$/.test(value))
        .map(Number);
      continue;
    }
    const uvicornLine = line.match(/^uvicorn topology: master=(\d+) workers=(.*)$/);
    if (uvicornLine) {
      uvicorn = {
        masterPid: Number(uvicornLine[1]),
        workerPids: (uvicornLine[2] ?? "")
          .split(/\s+/)
          .filter((value) => /^\d+$/.test(value))
          .map(Number),
      };
    }
  }
  return { rows, workers: uvicorn?.workerPids.length ? uvicorn.workerPids : workers, uvicorn };
}

/** 返回代表业务执行面的进程集合；Uvicorn 多 worker 不能收敛成一个 RSS 最大 PID。 */
export function diagnosticPids(scan: ProcScan): PickResult<number[]> {
  if (scan.uvicorn) {
    const pids = scan.uvicorn.workerPids.length > 0
      ? scan.uvicorn.workerPids
      : [scan.uvicorn.masterPid];
    return { ok: true, value: pids };
  }
  const picked = pickPid(scan);
  return picked.ok
    ? { ok: true, value: [picked.value], note: picked.note }
    : picked;
}

export function pickPid(scan: ProcScan, flag?: string): PickResult<number> {
  if (flag) {
    if (!/^\d+$/.test(flag)) return { ok: false, reason: `--pid 需要数字: '${flag}'` };
    return { ok: true, value: Number(flag) };
  }
  const byRss = (pids: number[]) => pids
    .map((pid) => scan.rows.find((row) => row.pid === pid))
    .filter((row): row is ProcRow => !!row)
    .sort((left, right) => right.rssMb - left.rssMb);

  if (scan.workers.length > 0) {
    const top = byRss(scan.workers)[0] ?? { pid: scan.workers[0]!, rssMb: Number.NaN };
    const note = scan.workers.length > 1
      ? `worker 多于一个（${scan.workers.join(", ")}），自动选 RSS 最大的 pid=${top.pid}；可用 --pid 覆盖`
      : undefined;
    return { ok: true, value: top.pid, note };
  }
  const pythons = scan.rows
    .filter((row) => row.comm.startsWith("python"))
    .sort((left, right) => right.rssMb - left.rssMb);
  if (pythons.length > 0) {
    const note = pythons.length > 1
      ? `无 threads>4 的 worker，自动选 RSS 最大的 python 进程 pid=${pythons[0]!.pid}；可用 --pid 覆盖`
      : undefined;
    return { ok: true, value: pythons[0]!.pid, note };
  }
  return { ok: false, reason: "procscan 未发现 python 进程；请用 --pid 显式指定目标进程" };
}
