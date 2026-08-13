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

export interface ToolkitPlatformManifest extends ToolkitPlatform {
  readonly tools: readonly ToolkitResource[];
  readonly images: readonly ToolkitResource[];
  readonly packages: readonly ToolkitResource[];
}

export interface ToolkitManifest {
  readonly schema: "doctor.toolkit/v1";
  readonly version: string;
  readonly platforms: readonly ToolkitPlatformManifest[];
}

export interface ToolkitArchive {
  readonly path: string;
  readonly manifest: ToolkitManifest;
}

export type ToolkitResourceKind = "tool" | "image" | "package";

export interface ResolvedToolkitResource {
  readonly archive: ToolkitArchive;
  readonly platform: ToolkitPlatform;
  readonly kind: ToolkitResourceKind;
  readonly resource: ToolkitResource;
  readonly path: string;
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
