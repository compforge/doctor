# Toolkit assets

These files are immutable inputs to `toolkit/Makefile`. Each Toolkit release records the SHA-256 of
the materialized resources in `doctor-toolkit/manifest.json`; upstream licenses remain beside the
corresponding assets.

- `regctl`: regclient 0.11.5 for Darwin/Linux and AMD64/ARM64.
- `fork-pyheap`: Doctor-maintained fork-pyheap 0.7.0+doctor.2 dumper PEX for the optional GDB-backed
  capture route.
- `pydump`: Pydump 0.2.0 Collector, static Linux `pydump-loader` executables, Pydump Analyzer 0.1.0,
  and Linux
  CPython 3.10–3.14 native Agents. Agent filenames and Toolkit IDs include the minimum target glibc
  (`min-glibc-2.17`).
  `REVISION` pins the source commit; regenerate with
  `scripts/refresh-pydump-assets.sh <pydump-source-root>`.
- `py-spy`: py-spy 0.4.2 Linux executables for AMD64/ARM64, used by the debug image and Linux slices.
- `doctor-pcap`: built from `toolkit/doctor-pcap` with `CGO_ENABLED=0` for each supported platform.
