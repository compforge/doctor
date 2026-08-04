export type RegistryImageState =
  | "ready"
  | "missing"
  | "ip-forbidden"
  | "unauthorized"
  | "unreachable"
  | "tool-unavailable"
  | "registry-error";

export interface RegistryCredentials {
  registry: string;
  username: string;
  password: string;
}

export type ImageArchitecture = "amd64" | "arm64";

export interface ImagePlatform {
  os: "linux";
  architecture: ImageArchitecture;
}

export interface RegistryImagePlatformResult {
  state: RegistryImageState;
  platform?: ImagePlatform;
}

export interface RegistryTagListResult {
  state: RegistryImageState;
  tags: string[];
}

export interface ImageImportOptions {
  /** Select one named image when the archive contains multiple images or tags. */
  sourceImage?: string;
}

/** Registry image capability consumed by app/probe layers; regctl is the current infra implementation. */
export interface ImageRegistry {
  inspect(
    image: string,
    credentials?: RegistryCredentials,
    platform?: ImagePlatform,
  ): RegistryImageState;
  inspectPlatform(
    image: string,
    credentials?: RegistryCredentials,
  ): RegistryImagePlatformResult;
  listTags(repository: string, credentials?: RegistryCredentials): RegistryTagListResult;
  import(
    image: string,
    archive: string,
    credentials?: RegistryCredentials,
    options?: ImageImportOptions,
  ): boolean;
  createIndex(image: string, refs: readonly string[], credentials?: RegistryCredentials): boolean;
  verifyIndex(image: string, credentials?: RegistryCredentials): boolean;
}
