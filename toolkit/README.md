# Doctor Toolkit

Doctor Toolkit is the independently versioned distribution of diagnostic executables, debug
images, and offline system packages consumed by Doctor Core.

Platform means the place where a resource executes, not the platform of the Doctor CLI. A Doctor
running on Darwin/ARM64 may therefore use the Darwin/ARM64 slice for Host processes and the
Linux/AMD64 slice for a Kubernetes Target in the same command.

Each archive contains a `doctor.toolkit/v3` manifest and one or more platform directories. A
standalone resource is selected by `os`, `architecture`, kind, id, version, and declared execution
requirements. OS/architecture are common probes; kernel, libraries, and CPU identity/features are
probed only when platform-compatible candidates declare them. The normative contract and resource
addition checklist are in [SPEC.md](./SPEC.md).

Components that must evolve together are declared as a versioned bundle with a protocol and exact
resource-version pins.
Core selects every component of such a bundle from one archive, then verifies each SHA-256 before
materializing it; it never combines components from different Toolkit releases.

For example, a `pydump.capture/v1` bundle binds Collector, `pydump-loader`, and one Agent variant to the
same release. Its compatibility describes the CPython minor and minimum libc version. Adding a new
Agent variant therefore changes Toolkit metadata and assets without requiring a Doctor Core
release.

Linux slices include matching multi-version offline system packages in addition to Host and Target
executables. Debug images are opt-in (`INCLUDE_DEBUG_IMAGE=true`) because one image represents only
one declared compatibility variant. Darwin slices contain Host-process tools only.
