# Doctor Toolkit resource specification

`doctor.toolkit/v3` is a catalog of versioned diagnostic resources. Its selection unit is:

`kind + id + version + execution platform + requirements`

The execution platform is where the resource runs. It is not necessarily the Doctor Host platform
or the business image platform.

## Resource declaration

Every tool, image, and package resource must declare:

- `id` and `version`: the logical tool identity and independently selectable implementation version;
- `path`, `sha256`, and `size`: immutable delivery identity;
- `requirements`: software and hardware facts required in the execution environment.

Supported requirements are intentionally structured instead of being arbitrary expressions:

- `software.os`: optional distribution IDs and version range (the OS family remains part of the
  platform key);
- `software.kernel`: optional `minInclusive` and `maxExclusive` versions;
- `software.libraries[]`: a named library, optional family, and optional version range;
- `hardware.cpu`: optional vendor, family, model-id, and required feature allowlists.

An empty declared dependency such as `kernel: {}` or `cpu: {}` means that the fact must be probed
and retained as compatibility evidence, even though this version does not yet impose a static
range. An absent dependency is not probed for that resource.

OS distribution/version and architecture are common platform facts and are always probed. Doctor
derives the remaining probe set from all platform-compatible candidates, probes only those facts,
then rejects candidates whose required fact is missing or does not match.

Bundles pin each component by both `resourceId` and `resourceVersion`. This prevents a bundle from
silently changing when multiple versions of one tool are present in the same Toolkit release.

## Packages and functional validation

A `doctor-package-set/v1` resource may contain multiple package variants. Each embedded
`doctor-packages/v2` manifest declares its own requirements. Static declarations narrow the
candidates; a tool-specific disposable functional probe remains authoritative where OS/kernel/CPU
interactions cannot be represented reliably as a version range.

The GDB package set therefore carries both 13.1 and 17.2. Neither is labelled “old kernel” or “new
kernel” without evidence. Doctor records kernel, glibc, and CPU identity from their declarations and
uses an inferior-call probe before attaching to a business process.

## Images

Images are ordinary versioned resources with requirements, not universal compatibility envelopes.
Toolkit builds do not include a debug image by default. Set `INCLUDE_DEBUG_IMAGE=true` only when a
consumer explicitly needs that declared image variant.

## Adding a resource

An addition is incomplete until it has:

1. an immutable asset and version;
2. a complete `requirements` declaration, using `{}` when there are no extra probes;
3. every required architecture/platform variant, or an explicit absence from that platform;
4. a bundle component pin when it participates in a multi-resource protocol;
5. parser, compatibility-selection, and materialization tests.
