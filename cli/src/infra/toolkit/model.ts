export type ToolkitOs = "darwin" | "linux";
export type ToolkitArchitecture = "amd64" | "arm64";

export interface ToolkitPlatform {
  readonly os: ToolkitOs;
  readonly architecture: ToolkitArchitecture;
}

export interface ToolkitResource {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export type ToolkitResourceKind = "tool" | "image" | "package";

export interface ToolkitBundleComponent {
  readonly role: string;
  readonly kind: ToolkitResourceKind;
  readonly resourceId: string;
}

export interface ToolkitBundleCompatibility {
  readonly runtime?: {
    readonly name: string;
    readonly version: string;
  };
  readonly libc?: {
    readonly family: string;
    readonly minimumVersion: string;
  };
}

/** A coherent set of resources that must be selected from one Toolkit release. */
export interface ToolkitBundle {
  readonly id: string;
  readonly protocol: string;
  readonly version: string;
  readonly compatibility?: ToolkitBundleCompatibility;
  readonly components: readonly ToolkitBundleComponent[];
}

export interface ToolkitPlatformManifest extends ToolkitPlatform {
  readonly tools: readonly ToolkitResource[];
  readonly images: readonly ToolkitResource[];
  readonly packages: readonly ToolkitResource[];
  readonly bundles: readonly ToolkitBundle[];
}

export interface ToolkitManifest {
  readonly schema: "doctor.toolkit/v1" | "doctor.toolkit/v2";
  readonly version: string;
  readonly platforms: readonly ToolkitPlatformManifest[];
}

export interface ToolkitArchive {
  readonly path: string;
  readonly manifest: ToolkitManifest;
}

export interface ResolvedToolkitResource {
  readonly archive: ToolkitArchive;
  readonly platform: ToolkitPlatform;
  readonly kind: ToolkitResourceKind;
  readonly resource: ToolkitResource;
  readonly path: string;
}

export interface ToolkitBundleRequest {
  readonly id: string;
  readonly protocol: string;
  readonly runtime?: {
    readonly name: string;
    readonly version: string;
  };
  readonly libc?: {
    readonly family: string;
    readonly version: string;
  };
}

export interface ResolvedToolkitBundle {
  readonly archive: ToolkitArchive;
  readonly platform: ToolkitPlatform;
  readonly bundle: ToolkitBundle;
  readonly components: Readonly<Record<string, ResolvedToolkitResource>>;
}

export type ToolkitChannel =
  | { readonly kind: "host-process"; readonly platform: ToolkitPlatform }
  | { readonly kind: "host-container"; readonly platform: ToolkitPlatform }
  | {
    readonly kind: "kubernetes-container";
    readonly platform: ToolkitPlatform;
    readonly pod: string;
    readonly container: string;
  };
