#!/usr/bin/env python3
"""Read-only /proc scan used by Doctor to locate Python workers."""

import os


rows = []
for pid in (entry for entry in os.listdir("/proc") if entry.isdigit()):
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
        rows.append((rss, threads, fds, int(pid), ppid, comm, cmdline))
    except (OSError, ValueError):
        pass

rows.sort(reverse=True)
print(f"{'PID':>6} {'COMM':<14} {'RSS_MB':>8} {'THREADS':>8} {'FDS':>6}")
for rss, threads, fds, pid, _, comm, _ in rows[:15]:
    if rss:
        print(f"{pid:>6} {comm:<14} {rss / 1024:>8.0f} {threads:>8} {fds:>6}")

workers = [
    str(pid)
    for _, threads, _, pid, _, comm, _ in rows
    if comm.startswith("python") and threads > 4
]
print("\npython workers (threads>4):", " ".join(workers) or "(none)")

# Uvicorn worker cmdline usually no longer contains "uvicorn"; identify them by
# master PPID and multiprocessing.spawn, excluding the sibling resource tracker.
masters = [row for row in rows if "uvicorn" in row[6].lower()]
if masters:
    master_pid = min(masters, key=lambda row: row[3])[3]
    uvicorn_workers = [
        str(pid)
        for _, _, _, pid, ppid, _, cmdline in rows
        if ppid == master_pid and "multiprocessing.spawn" in cmdline
    ]
    print(
        f"uvicorn topology: master={master_pid} "
        f"workers={' '.join(uvicorn_workers) or '(none)'}"
    )
