import { regctlImageRegistry } from "./regctl";
import type { ImageRegistry } from "./registry";

export type {
  ImageArchitecture,
  ImageImportOptions,
  ImagePlatform,
  ImageRegistry,
  RegistryCredentials,
  RegistryImagePlatformResult,
  RegistryImageState,
  RegistryTagListResult,
} from "./registry";
export {
  inspectImageArchive,
  type ImageArchiveEntry,
  type ImageArchiveInfo,
} from "./archive";

/** CLI-facing image capability; regctl is hidden behind the stable registry contract. */
export const imageRegistry: ImageRegistry = regctlImageRegistry;
