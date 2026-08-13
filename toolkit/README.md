# Doctor Toolkit

Doctor Toolkit is the independently versioned distribution of diagnostic executables, debug
images, and offline system packages consumed by Doctor Core.

Platform means the place where a resource executes, not the platform of the Doctor CLI. A Doctor
running on Darwin/ARM64 may therefore use the Darwin/ARM64 slice for Host processes and the
Linux/AMD64 slice for a Kubernetes Target in the same command.

Each archive contains `doctor-toolkit/manifest.json` and one or more platform directories. Core
selects resources by `os`, `architecture`, resource kind, and resource id, and verifies SHA-256
before materializing them.

Linux slices include the debug image and matching offline system packages in addition to Host and
Target executables. Darwin slices contain Host-process tools only.
