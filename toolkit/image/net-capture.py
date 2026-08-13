#!/usr/bin/env python3
"""Bounded tcpdump session controller used by doctor net."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path("/tmp/doctor-net")
SESSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def now() -> str:
    return datetime.now(UTC).isoformat()


def session_dir(session: str) -> Path:
    if not SESSION_PATTERN.fullmatch(session):
        raise ValueError(f"invalid session id: {session!r}")
    return ROOT / session


def state_path(session: str) -> Path:
    return session_dir(session) / "state.json"


def read_state(session: str) -> dict:
    path = state_path(session)
    if not path.is_file():
        raise FileNotFoundError(f"capture session does not exist: {session}")
    return json.loads(path.read_text())


def write_state(session: str, state: dict) -> None:
    path = state_path(session)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"state.{os.getpid()}.tmp")
    temporary.write_text(f"{json.dumps(state, sort_keys=True)}\n")
    temporary.replace(path)


def process_start_ticks(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().split()
        return fields[21]
    except (FileNotFoundError, IndexError, PermissionError):
        return None


def process_matches(state: dict) -> bool:
    pid = int(state.get("pid", 0))
    expected = state.get("process_start_ticks")
    return pid > 0 and expected is not None and process_start_ticks(pid) == expected


def capture_metadata(session: str, state: dict | None = None) -> dict:
    current = dict(state or read_state(session))
    path = session_dir(session) / "capture.pcap"
    running = process_matches(current)
    current["status"] = "running" if running else current.get("status", "stopped")
    current["running"] = running
    current["capture_file"] = str(path)
    current["capture_bytes"] = path.stat().st_size if path.is_file() else 0
    if path.is_file() and not running:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        current["capture_sha256"] = digest.hexdigest()
    return current


def stop_capture(session: str, reason: str) -> dict:
    state = read_state(session)
    was_running = process_matches(state)
    if was_running:
        pid = int(state["pid"])
        os.killpg(pid, signal.SIGINT)
        deadline = time.monotonic() + 10
        while process_matches(state) and time.monotonic() < deadline:
            time.sleep(0.1)
        if process_matches(state):
            os.killpg(pid, signal.SIGTERM)
            deadline = time.monotonic() + 2
            while process_matches(state) and time.monotonic() < deadline:
                time.sleep(0.1)
        if process_matches(state):
            os.killpg(pid, signal.SIGKILL)
    state["status"] = "stopped"
    state.setdefault("stopped_at", now())
    if was_running or not state.get("stop_reason"):
        state["stop_reason"] = reason
    write_state(session, state)
    return capture_metadata(session, state)


def watch_capture(session: str) -> int:
    state = read_state(session)
    deadline = float(state["deadline_epoch"])
    max_bytes = int(state["max_bytes"])
    path = session_dir(session) / "capture.pcap"
    while process_matches(state):
        if time.time() >= deadline:
            stop_capture(session, "timeout")
            return 0
        if path.is_file() and path.stat().st_size >= max_bytes:
            stop_capture(session, "size_limit")
            return 0
        time.sleep(0.5)
    return 0


def start_capture(args: argparse.Namespace) -> dict:
    directory = session_dir(args.session)
    if directory.exists():
        existing = read_state(args.session)
        if process_matches(existing):
            raise RuntimeError(f"capture session is already running: {args.session}")
        raise RuntimeError(f"capture session already exists: {args.session}")
    directory.mkdir(parents=True, mode=0o700)
    tcpdump = shutil.which("tcpdump")
    if not tcpdump:
        raise RuntimeError("tcpdump is not installed")
    command = [
        tcpdump,
        "-i",
        "any",
        "-nn",
        "-s",
        "0",
        "-U",
        "-B",
        "4096",
        "-w",
        str(directory / "capture.pcap"),
    ]
    if args.filter:
        command.append(args.filter)
    log = (directory / "tcpdump.log").open("ab", buffering=0)
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    time.sleep(0.25)
    if process.poll() is not None:
        log.close()
        detail = (directory / "tcpdump.log").read_text(errors="replace").strip()
        raise RuntimeError(f"tcpdump exited during startup: {detail or process.returncode}")
    state = {
        "schema": "doctor.net.capture-state/v1",
        "session_id": args.session,
        "status": "running",
        "pid": process.pid,
        "process_start_ticks": process_start_ticks(process.pid),
        "started_at": now(),
        "deadline_epoch": time.time() + args.timeout_seconds,
        "timeout_seconds": args.timeout_seconds,
        "max_bytes": args.max_bytes,
        "filter": args.filter,
        "command": command,
    }
    write_state(args.session, state)
    watchdog_log = (directory / "watchdog.log").open("ab", buffering=0)
    subprocess.Popen(
        [sys.executable, __file__, "watch", "--session", args.session],
        stdin=subprocess.DEVNULL,
        stdout=watchdog_log,
        stderr=watchdog_log,
        start_new_session=True,
    )
    log.close()
    watchdog_log.close()
    return capture_metadata(args.session, state)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="net-capture")
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start")
    start.add_argument("--session", required=True)
    start.add_argument("--timeout-seconds", required=True, type=int)
    start.add_argument("--max-bytes", required=True, type=int)
    start.add_argument("--filter", default="tcp")
    for name in ("status", "metadata", "stop", "cleanup", "watch"):
        command = commands.add_parser(name)
        command.add_argument("--session", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "start":
        if args.timeout_seconds <= 0 or args.max_bytes <= 0:
            raise ValueError("timeout-seconds and max-bytes must be positive")
        result = start_capture(args)
    elif args.command == "stop":
        result = stop_capture(args.session, "doctor_stop")
    elif args.command in {"status", "metadata"}:
        result = capture_metadata(args.session)
    elif args.command == "cleanup":
        state = read_state(args.session)
        if process_matches(state):
            raise RuntimeError(f"refusing to clean a running capture: {args.session}")
        shutil.rmtree(session_dir(args.session))
        result = {"session_id": args.session, "status": "cleaned"}
    else:
        return watch_capture(args.session)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error
