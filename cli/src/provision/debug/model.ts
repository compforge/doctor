import type {
  KubernetesCommandInput,
} from "../../command/kubernetes-target";
import type { Executor } from "../../infra/k8s/executor";
import type { ImagePlatform } from "../../infra/image";
import type { CommandContext } from "../../command";

export interface DebugCliOpts extends KubernetesCommandInput {
  pod?: string;
  container?: string;
  image?: string;
  services?: string;
  capabilities?: string;
  yes?: boolean;
}

export interface PreparedDebugImage {
  code: number;
  image?: string;
  source?: "debug-image" | "target-image";
  command?: string[];
  imagePullPolicy?: "IfNotPresent" | "Never";
}

export interface BatchDebugImageResolution {
  prepared: PreparedDebugImage;
  reused: boolean;
}

export interface DebugTarget {
  executor: Executor;
  context: CommandContext;
  namespace: string;
  pod: string;
  container: string;
  containerImage: string;
  containerImageId?: string;
  imagePlatform?: ImagePlatform;
  platformReason?: string;
  podJson: string;
}

export type DebugPlatformSource = "node" | "image-manifest";
