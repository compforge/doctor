// py-spy dump 输出解析。典型形态：
//
//   Process 11: python3 -m app
//   Python v3.11.4 (/usr/local/bin/python3.11)
//
//   Thread 11 (idle): "MainThread"
//       _worker (app/worker.py:88)
//       run (threading.py:975)
//
//   Thread 23 (active): "Thread-1"
//       read (app/sse.py:42)
//
// 解析成 Observation 是为了让线程栈进入 Evidence 与报告——detector 可以以后再写
// （见 docs 的"Observation 不必立刻有 detector 读"）。当前已知的候选规则：maps 报出
// N 个 8MB 线程栈段，而这里 N 个线程停在同一处 → 线程泄露且定位到代码行；两者单独
// 都只能说"疑似"。

import type { ObservationMeta } from "../protocol";

export interface CpuPySpyFrame {
  /** 函数名；py-spy 对 native 帧可能给不出，用 "?" 占位 */
  func: string;
  file: string;
  line: number;
}

export interface CpuPySpyThread {
  tid: number;
  name?: string;
  /** py-spy 的 active/idle 标注；--nonblocking 下不总有 */
  state?: string;
  frames: CpuPySpyFrame[];
}

export interface CpuPySpyObservation extends ObservationMeta {
  id: "py-spy";
  kind: "py-spy";
  /** 采到栈的进程 pid；解析不出时缺省 */
  pid?: number;
  pythonVersion?: string;
  threads: CpuPySpyThread[];
  /** 栈顶完全相同的线程分组，多线程停在同一处是线程泄露/锁竞争的直接线索 */
  topFrameGroups: Array<{ frame: CpuPySpyFrame; threadCount: number }>;
}

const PROCESS_RE = /^Process\s+(\d+):/;
const PYTHON_RE = /^Python\s+(v[\d.]+)/;
// Thread 23 (active): "Thread-1"  /  Thread 23: "MainThread"  /  Thread 23
const THREAD_RE = /^Thread\s+(\d+)\s*(?:\(([^)]*)\))?\s*(?::\s*"([^"]*)")?/;
// 缩进帧：  func (file.py:42)
const FRAME_RE = /^\s+(.+?)\s+\(([^:]+):(\d+)\)\s*$/;

export function parseCpuPySpyDump(output: string): CpuPySpyObservation | undefined {
  if (!output.trim()) return undefined;

  let pid: number | undefined;
  let pythonVersion: string | undefined;
  const threads: CpuPySpyThread[] = [];
  let current: CpuPySpyThread | undefined;

  for (const line of output.split(/\r?\n/)) {
    const process = PROCESS_RE.exec(line);
    if (process) {
      pid = Number(process[1]);
      continue;
    }
    const python = PYTHON_RE.exec(line);
    if (python) {
      pythonVersion = python[1];
      continue;
    }
    // 帧必须先于 Thread 判断：帧带缩进，Thread 顶格，但两者都可能含 "Thread" 字样
    const frame = FRAME_RE.exec(line);
    if (frame && current) {
      current.frames.push({ func: frame[1]!.trim(), file: frame[2]!, line: Number(frame[3]) });
      continue;
    }
    const thread = THREAD_RE.exec(line);
    if (thread) {
      current = {
        tid: Number(thread[1]),
        state: thread[2]?.trim() || undefined,
        name: thread[3] || undefined,
        frames: [],
      };
      threads.push(current);
    }
  }

  if (!threads.length) return undefined;
  return {
    id: "py-spy",
    kind: "py-spy",
    schemaVersion: 1,
    producer: { origin: "core", id: "py-spy" },
    pid,
    pythonVersion,
    threads,
    topFrameGroups: groupTopFrames(threads),
  };
}

/** 按栈顶帧聚类。只统计有栈的线程——空栈线程聚在一起没有诊断意义。 */
function groupTopFrames(threads: CpuPySpyThread[]): CpuPySpyObservation["topFrameGroups"] {
  const groups = new Map<string, { frame: CpuPySpyFrame; threadCount: number }>();
  for (const thread of threads) {
    const top = thread.frames[0];
    if (!top) continue;
    const key = `${top.file}:${top.line}:${top.func}`;
    const existing = groups.get(key);
    if (existing) existing.threadCount += 1;
    else groups.set(key, { frame: top, threadCount: 1 });
  }
  return [...groups.values()].sort((a, b) => b.threadCount - a.threadCount);
}
