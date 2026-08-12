#!/usr/bin/env python3
"""Read-only /proc scan used by Doctor to locate Python workers."""

import os


rows = []
probe_pid = os.getpid()
for pid in (entry for entry in os.listdir("/proc") if entry.isdigit()):
    if int(pid) == probe_pid:
        continue
    try:
        comm = open(f"/proc/{pid}/comm").read().strip()
        status = open(f"/proc/{pid}/status").read()
        values = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
        rss = int(values.get("VmRSS", "0 kB").split()[0] or 0)
        threads = int(values.get("Threads", "0").strip() or 0)
        ppid = int(values.get("PPid", "0").strip() or 0)
        try:
            fds = len(os.listdir(f"/proc/{pid}/fd"))
        except OSError:
            fds = -1
        cmdline = (
            open(f"/proc/{pid}/cmdline", "rb")
            .read()
            .replace(b"\0", b" ")
            .decode(errors="replace")
        )
        try:
            executable = os.path.basename(os.readlink(f"/proc/{pid}/exe")).lower()
        except OSError:
            executable = ""
        is_python = executable.startswith("python") or comm.lower().startswith("python")
        rows.append((rss, threads, fds, int(pid), ppid, comm, cmdline, is_python))
    except (OSError, ValueError):
        pass

rows.sort(reverse=True)
print(f"{'PID':>6} {'COMM':<14} {'RSS_MB':>8} {'THREADS':>8} {'FDS':>6}")
for rss, threads, fds, pid, _, comm, _, _ in rows[:15]:
    if rss:
        print(f"{pid:>6} {comm:<14} {rss / 1024:>8.0f} {threads:>8} {fds:>6}")

python_processes = [
    str(pid)
    for _, _, _, pid, _, _, cmdline, is_python in rows
    if is_python and "multiprocessing.resource_tracker" not in cmdline
]
print("\npython processes:", " ".join(python_processes) or "(none)")

workers = [
    str(pid)
    for _, threads, _, pid, _, _, cmdline, is_python in rows
    if is_python
    and threads > 4
    and "multiprocessing.resource_tracker" not in cmdline
]
print("\npython workers (threads>4):", " ".join(workers) or "(none)")

# `--workers 1` does not create a supervisor: the launcher itself serves traffic.
# Multi-worker children usually lose "uvicorn" from cmdline, so parentage and the
# Python executable are more stable facts than process titles.
uvicorn_launchers = [
    row for row in rows
    if row[7] and ("uvicorn" in row[6].lower() or row[5].lower() == "uvicorn")
]
supervised = []
for launcher in uvicorn_launchers:
    launcher_pid = launcher[3]
    children = [
        row for row in rows
        if row[4] == launcher_pid
        and row[7]
        and ("multiprocessing.spawn" in row[6] or "spawn_main" in row[6])
        and "multiprocessing.resource_tracker" not in row[6]
    ]
    if children:
        supervised.append((launcher, children))

if supervised:
    supervisor, children = max(supervised, key=lambda item: len(item[1]))
    print(
        f"uvicorn topology: mode=multiprocess supervisor={supervisor[3]} "
        f"workers={' '.join(str(row[3]) for row in children)}"
    )
elif uvicorn_launchers:
    worker = max(uvicorn_launchers, key=lambda row: (row[1], row[0]))
    print(f"uvicorn topology: mode=standalone workers={worker[3]}")
