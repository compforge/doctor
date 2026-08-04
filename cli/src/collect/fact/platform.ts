export interface ContainerPlatformFacts {
  machine?: string;
  kernelVersion?: string;
  glibcVersion?: string;
  osRelease?: {
    id?: string;
    versionId?: string;
    prettyName?: string;
  };
}

interface ContainerPlatformFactsWire {
  machine?: string;
  kernel_version?: string;
  glibc_version?: string | null;
  os_release?: {
    id?: string;
    version_id?: string;
    pretty_name?: string;
  };
}

const PLATFORM_FACTS_SCRIPT = String.raw`
import json
import os
import shlex

release = {}
try:
    with open("/etc/os-release", encoding="utf-8") as file:
        for line in file:
            key, separator, value = line.rstrip("\n").partition("=")
            if not separator:
                continue
            parsed = shlex.split(value, posix=True)
            release[key] = parsed[0] if parsed else ""
except (OSError, ValueError):
    pass

try:
    libc_name, libc_version = os.confstr("CS_GNU_LIBC_VERSION").split(None, 1)
except (AttributeError, OSError, TypeError, ValueError):
    libc_name, libc_version = "", ""

uname = os.uname()
print(json.dumps({
    "machine": uname.machine,
    "kernel_version": uname.release,
    "glibc_version": libc_version if libc_name == "glibc" else None,
    "os_release": {
        "id": release.get("ID"),
        "version_id": release.get("VERSION_ID"),
        "pretty_name": release.get("PRETTY_NAME"),
    },
}))
`;

export function platformFactsCmd(): string[] {
  return ["python3", "-c", PLATFORM_FACTS_SCRIPT];
}

export function parsePlatformFacts(raw: string): ContainerPlatformFacts | undefined {
  if (!raw.trim()) return undefined;
  const value = JSON.parse(raw) as ContainerPlatformFactsWire;
  const osRelease = value.os_release
    ? {
      id: value.os_release.id?.trim() || undefined,
      versionId: value.os_release.version_id?.trim() || undefined,
      prettyName: value.os_release.pretty_name?.trim() || undefined,
    }
    : undefined;
  return {
    machine: value.machine?.trim() || undefined,
    kernelVersion: value.kernel_version?.trim() || undefined,
    glibcVersion: value.glibc_version?.trim() || undefined,
    osRelease: osRelease && Object.values(osRelease).some(Boolean) ? osRelease : undefined,
  };
}
