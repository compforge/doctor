import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RECENT_VERSION = 1;

export interface KubernetesRecentTarget {
  kubeconfig: string;
  context: string;
  namespace: string;
  service?: string;
  pod?: string;
  container?: string;
  last_used_at: string;
  use_count: number;
}

export interface ImageRecentTarget {
  kubeconfig: string;
  context: string;
  registry: string;
  namespace: string;
  last_used_at: string;
  use_count: number;
}

export interface RecentDocument {
  version: number;
  kubernetes: {
    targets: KubernetesRecentTarget[];
  };
  images: {
    targets: ImageRecentTarget[];
  };
  [key: string]: unknown;
}

export const DEFAULT_RECENT_PATH = join(homedir(), ".doctor", "recent.json");

function emptyDocument(): RecentDocument {
  return {
    version: RECENT_VERSION,
    kubernetes: { targets: [] },
    images: { targets: [] },
  };
}

export class RecentStore {
  constructor(readonly path = DEFAULT_RECENT_PATH) {}

  read(): RecentDocument {
    if (!existsSync(this.path)) return emptyDocument();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RecentDocument>;
      return {
        ...parsed,
        version: RECENT_VERSION,
        kubernetes: {
          targets: Array.isArray(parsed.kubernetes?.targets)
            ? parsed.kubernetes.targets
            : [],
        },
        images: {
          targets: Array.isArray(parsed.images?.targets)
            ? parsed.images.targets
            : [],
        },
      };
    } catch {
      return emptyDocument();
    }
  }

  update(mutator: (document: RecentDocument) => void): void {
    const document = this.read();
    mutator(document);
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
    } catch {
      // A history write failure must not turn a diagnostic command into a failure.
    }
  }
}
