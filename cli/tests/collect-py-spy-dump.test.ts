import { describe, expect, test } from "bun:test";
import { parseCpuPySpyDump } from "../src/collect/cpu/py-spy-dump";

const DUMP = `Process 11: python3 -m app
Python v3.11.4 (/usr/local/bin/python3.11)

Thread 11 (idle): "MainThread"
    _worker (app/worker.py:88)
    run (threading.py:975)

Thread 23 (active): "Thread-1"
    read (app/sse.py:42)
    handle (app/sse.py:120)

Thread 24 (active): "Thread-2"
    read (app/sse.py:42)
    handle (app/sse.py:120)
`;

describe("parseCpuPySpyDump", () => {
  test("解析进程、Python 版本与线程栈", () => {
    const o = parseCpuPySpyDump(DUMP)!;
    expect(o.pid).toBe(11);
    expect(o.pythonVersion).toBe("v3.11.4");
    expect(o.threads).toHaveLength(3);
    expect(o.threads[0]).toMatchObject({ tid: 11, name: "MainThread", state: "idle" });
    expect(o.threads[0]!.frames[0]).toEqual({ func: "_worker", file: "app/worker.py", line: 88 });
  });

  test("按栈顶聚类——多线程停在同一处是线程泄露的直接线索", () => {
    const o = parseCpuPySpyDump(DUMP)!;
    // sse.py:42 上有 2 个线程，排在最前
    expect(o.topFrameGroups[0]).toEqual({
      frame: { func: "read", file: "app/sse.py", line: 42 },
      threadCount: 2,
    });
    expect(o.topFrameGroups[1]!.threadCount).toBe(1);
  });

  test("无线程名 / 无状态的简化输出也能解析", () => {
    const o = parseCpuPySpyDump('Process 5: python3\nThread 5\n    main (a.py:1)\n')!;
    expect(o.threads[0]).toMatchObject({ tid: 5, frames: [{ func: "main", file: "a.py", line: 1 }] });
    expect(o.threads[0]!.name).toBeUndefined();
  });

  test("空输出或没有线程时返回 undefined——采不到就是采不到，不造空 observation", () => {
    expect(parseCpuPySpyDump("")).toBeUndefined();
    expect(parseCpuPySpyDump("Process 11: python3\n")).toBeUndefined();
  });

  test("空栈线程不参与栈顶聚类", () => {
    const o = parseCpuPySpyDump('Process 1: p\nThread 1\nThread 2\n    f (a.py:1)\n')!;
    expect(o.threads).toHaveLength(2);
    expect(o.topFrameGroups).toEqual([{ frame: { func: "f", file: "a.py", line: 1 }, threadCount: 1 }]);
  });
});
