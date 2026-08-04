"""Wait for doctor runtime assets, then replace this process with the original workload."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time


def _log(message: str) -> None:
    print(f"[DOCTOR_BOOTSTRAP] {message}", flush=True)


def _validated_manifest(runtime_dir: str):
    try:
        with open(os.path.join(runtime_dir, "READY"), encoding="utf-8") as file:
            manifest = json.load(file)
        for item in manifest.get("files", []):
            relative = item["path"]
            path = os.path.realpath(os.path.join(runtime_dir, relative))
            if os.path.commonpath([os.path.realpath(runtime_dir), path]) != os.path.realpath(runtime_dir):
                raise ValueError(f"asset path escapes runtime directory: {relative}")
            digest = hashlib.sha256()
            with open(path, "rb") as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != item["sha256"]:
                raise ValueError(f"sha256 mismatch: {relative}")
            os.chmod(path, int(item["mode"]))
        return manifest
    except (FileNotFoundError, json.JSONDecodeError, KeyError, OSError, TypeError, ValueError):
        return None


def main() -> None:
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        raise SystemExit("usage: bootstrap.py RUNTIME_DIR TIMEOUT_SECONDS -- COMMAND [ARG ...]")
    runtime_dir = sys.argv[1]
    timeout_seconds = int(sys.argv[2])
    original_argv = sys.argv[4:]
    if not original_argv:
        raise SystemExit("original workload command is empty")

    os.makedirs(runtime_dir, exist_ok=True)
    deadline = time.monotonic() + timeout_seconds
    manifest = None
    _log(f"waiting up to {timeout_seconds}s for runtime assets")
    while time.monotonic() < deadline:
        manifest = _validated_manifest(runtime_dir)
        if manifest is not None:
            break
        time.sleep(0.5)

    if manifest is None:
        _log("runtime upload timed out; starting original workload without doctor assets")
    else:
        _log("runtime assets verified; starting original workload")
    os.execvp(original_argv[0], original_argv)


if __name__ == "__main__":
    main()
