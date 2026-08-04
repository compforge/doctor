import type { RegistryAuthOpts } from "../../app/registry-auth";
import type { LocalContainerEngineName } from "../../infra/host/container-engine";
import type { ImagePlatform } from "../../infra/image";

export interface ImageCliOpts extends RegistryAuthOpts {
  tar?: string | string[];
  sourceImage?: string;
  kubeconfig?: string;
  context?: string;
  registry?: boolean;
  host?: boolean;
  yes?: boolean;
}

export interface ImagePublishSource {
  archive: string;
  sourceImage: string;
  platform?: ImagePlatform;
}

export interface ImageArchiveCandidate {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export interface ResolveImageArchiveOptions {
  directory?: string;
  interactive?: boolean;
  select?: (
    candidates: readonly ImageArchiveCandidate[],
  ) => Promise<ImageArchiveCandidate | undefined>;
}

export interface ResolveSourceImageOptions {
  interactive?: boolean;
  select?: (images: readonly string[]) => Promise<string | undefined>;
}

export interface PrepareDoctorHostImageOptions {
  assumeYes?: boolean;
  interactive?: boolean;
  confirm?: (
    engine: LocalContainerEngineName,
    sourceImage: string,
  ) => Promise<boolean>;
}
