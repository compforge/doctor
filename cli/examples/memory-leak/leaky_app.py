"""Deliberately retain Python objects and publish cooperative heap snapshots for doctor mem."""

from __future__ import annotations

import gc
import json
import os
import time
from collections import Counter
from datetime import datetime, timezone


SNAPSHOT_PATH = "/tmp/doctor-python-heap.json"
SAMPLE_INTERVAL_SECONDS = 5
LEAKS_PER_SECOND = 8
PAYLOAD_BYTES = 256 * 1024


class LeakyPayload:
    def __init__(self, sequence: int) -> None:
        self.sequence = sequence
        self.payload = bytearray(PAYLOAD_BYTES)


retained: list[LeakyPayload] = []
samples: list[dict[str, object]] = []


def capture_type_counts() -> None:
    counts = Counter(
        f"{type(obj).__module__}.{type(obj).__qualname__}"
        for obj in gc.get_objects()
    )
    samples.append(
        {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "types": [
                {"type": type_name, "count": count}
                for type_name, count in sorted(counts.items())
            ],
        }
    )
    del samples[:-2]
    payload = {"schema_version": 1, "samples": samples}
    temporary = f"{SNAPSHOT_PATH}.tmp"
    with open(temporary, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False)
    os.replace(temporary, SNAPSHOT_PATH)


def main() -> None:
    capture_type_counts()
    last_sample = time.monotonic()
    while True:
        for _ in range(LEAKS_PER_SECOND):
            retained.append(LeakyPayload(len(retained)))
        now = time.monotonic()
        if now - last_sample >= SAMPLE_INTERVAL_SECONDS:
            capture_type_counts()
            last_sample = now
            print(
                f"retained={len(retained)} approximate_mib={len(retained) * PAYLOAD_BYTES / 1024 ** 2:.1f}",
                flush=True,
            )
        time.sleep(1)


if __name__ == "__main__":
    main()
