# Toolkit assets

These files are immutable inputs to `toolkit/Makefile`. Each Toolkit release records the SHA-256 of
the materialized resources in `doctor-toolkit/manifest.json`; upstream licenses remain beside the
corresponding assets.

- `regctl`: regclient 0.11.5 for Darwin/Linux and AMD64/ARM64.
- `pyheap`: Doctor PyHeap 0.7.0+doctor.2 dumper and analyzer PEX files.
- `py-spy`: py-spy 0.4.2 Linux executables for AMD64/ARM64, used by the debug image and Linux slices.
- `doctor-pcap`: built from `toolkit/doctor-pcap` with `CGO_ENABLED=0` for each supported platform.
