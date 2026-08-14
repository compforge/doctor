export interface TargetVersionRange {
  readonly minInclusive?: string;
  readonly maxExclusive?: string;
}

export interface TargetLibraryRequirement {
  readonly name: string;
  readonly family?: string;
  readonly version?: TargetVersionRange;
}

export interface TargetOsRequirement {
  readonly ids?: readonly string[];
  readonly version?: TargetVersionRange;
}

export interface TargetCpuRequirement {
  readonly vendors?: readonly string[];
  readonly families?: readonly string[];
  readonly models?: readonly string[];
  readonly features?: readonly string[];
}

/**
 * Execution-environment dependencies declared by one Toolkit resource.
 *
 * Presence also controls probing: `kernel: {}` and `cpu: {}` request facts for
 * compatibility evidence even when a release has no static allow/deny range yet.
 */
export interface TargetRequirements {
  readonly software?: {
    readonly os?: TargetOsRequirement;
    readonly kernel?: TargetVersionRange;
    readonly libraries?: readonly TargetLibraryRequirement[];
  };
  readonly hardware?: {
    readonly cpu?: TargetCpuRequirement;
  };
}

export interface TargetLibraryFact {
  readonly family?: string;
  readonly version?: string;
  readonly raw?: string;
}

export interface TargetCpuFact {
  readonly vendor?: string;
  readonly family?: string;
  readonly modelId?: string;
  readonly model?: string;
  readonly features?: readonly string[];
}

export interface TargetEnvironmentFact {
  readonly osId?: string;
  readonly osVersionId?: string;
  readonly architecture?: string;
  readonly kernelVersion?: string;
  readonly libraries?: Readonly<Record<string, TargetLibraryFact>>;
  readonly cpu?: TargetCpuFact;
}

export interface TargetProbeRequest {
  readonly kernel: boolean;
  readonly libraries: readonly string[];
  readonly cpu: boolean;
}

export function requiredTargetProbes(
  requirements: readonly (TargetRequirements | undefined)[],
): TargetProbeRequest {
  const libraries = new Set<string>();
  let kernel = false;
  let cpu = false;
  for (const requirement of requirements) {
    if (!requirement) continue;
    if (requirement.software?.kernel !== undefined) kernel = true;
    for (const library of requirement.software?.libraries ?? []) libraries.add(library.name);
    if (requirement.hardware?.cpu !== undefined) cpu = true;
  }
  return { kernel, libraries: [...libraries].sort(), cpu };
}

export function compareTargetVersions(left: string, right: string): number {
  const parse = (value: string) => value
    .split(/[._+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function versionMatches(actual: string | undefined, range: TargetVersionRange | undefined): boolean {
  if (!range) return true;
  if (!actual) return false;
  if (range.minInclusive && compareTargetVersions(actual, range.minInclusive) < 0) return false;
  if (range.maxExclusive && compareTargetVersions(actual, range.maxExclusive) >= 0) return false;
  return true;
}

function includesNormalized(values: readonly string[] | undefined, actual: string | undefined): boolean {
  if (!values?.length) return true;
  if (!actual) return false;
  return values.some((value) => value.toLowerCase() === actual.toLowerCase());
}

export function targetRequirementsMatch(
  requirements: TargetRequirements | undefined,
  target: TargetEnvironmentFact,
): boolean {
  if (!requirements) return true;
  const expectedOs = requirements.software?.os;
  if (expectedOs) {
    if (!includesNormalized(expectedOs.ids, target.osId)) return false;
    if (!versionMatches(target.osVersionId, expectedOs.version)) return false;
  }
  if (!versionMatches(target.kernelVersion, requirements.software?.kernel)) return false;
  for (const expected of requirements.software?.libraries ?? []) {
    const actual = target.libraries?.[expected.name];
    if (!actual) return false;
    if (expected.family && expected.family.toLowerCase() !== actual.family?.toLowerCase()) return false;
    if (!versionMatches(actual.version, expected.version)) return false;
  }
  const expectedCpu = requirements.hardware?.cpu;
  if (!expectedCpu) return true;
  const actualCpu = target.cpu;
  if (!actualCpu) return false;
  if (!includesNormalized(expectedCpu.vendors, actualCpu.vendor)) return false;
  if (!includesNormalized(expectedCpu.families, actualCpu.family)) return false;
  if (!includesNormalized(expectedCpu.models, actualCpu.modelId)) return false;
  const features = new Set(actualCpu.features?.map((feature) => feature.toLowerCase()) ?? []);
  return (expectedCpu.features ?? []).every((feature) => features.has(feature.toLowerCase()));
}
