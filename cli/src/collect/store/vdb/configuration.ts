import type { ExecResult, ExecTarget, Executor } from "../../../infra/k8s/executor";
import { loadDeclaredContainerConfig } from "../../../infra/k8s/container-config";
import { parseOpenSearchEndpoint } from "../../../infra/search/opensearch";

interface VdbConnectionBase {
  store: string;
  configSource: "kubernetes-config" | "container-runtime";
  configurationKind: "environment";
}

export interface OpenSearchVdbConnection extends VdbConnectionBase {
  type: "opensearch";
  endpoint?: string;
  username?: string;
  password?: string;
}

export interface UnsupportedVdbConnection extends VdbConnectionBase {
  type: "unsupported";
  backend: string;
}

export type VdbConnection = OpenSearchVdbConnection | UnsupportedVdbConnection;

export interface VdbTargetConfirmation {
  connection?: VdbConnection;
  captures: ExecResult[];
  environmentCapture?: ExecResult;
  reason?: string;
}

function parseEnvironment(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function firstEnvironment(values: Map<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = values.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function parseVdbConnection(
  rawEnvironment: string,
  selectedStore?: string,
  configSource: VdbConnectionBase["configSource"] = "container-runtime",
): VdbConnection {
  const environment = parseEnvironment(rawEnvironment);
  const endpoint = firstEnvironment(environment, [
    "OPENSEARCH_URL",
    "OPENSEARCH_ENDPOINT",
    "OPENSEARCH_ENDPOINTS",
    "OS_ENDPOINT",
  ]);
  const username = firstEnvironment(environment, [
    "OPENSEARCH_USERNAME",
    "OPENSEARCH_USER",
    "OS_USERNAME",
    "OS_USER",
  ]);
  const password = firstEnvironment(environment, [
    "OPENSEARCH_PASSWORD",
    "OPENSEARCH_PASS",
    "OS_PASSWORD",
    "OS_PASS",
  ]);
  if (endpoint || username || password) {
    const parsedEndpoint = endpoint ? parseOpenSearchEndpoint(endpoint) : undefined;
    return {
      type: "opensearch",
      store: selectedStore ?? "opensearch",
      endpoint: parsedEndpoint?.safeEndpoint,
      username: username ?? parsedEndpoint?.username,
      password: password ?? parsedEndpoint?.password,
      configSource,
      configurationKind: "environment",
    };
  }
  throw new Error("目标 Container 中未发现 OPENSEARCH_* 运行时配置");
}

/**
 * 运行时配置是目标现场 Fact。只在内存中保留凭据，Evidence 由调用方写脱敏投影。
 */
export async function confirmVdbTarget(
  executor: Executor,
  target: ExecTarget,
  selectedStore?: string,
): Promise<VdbTargetConfirmation> {
  const declared = await loadDeclaredContainerConfig(executor, target);
  const declaredEnvironment = [...declared.environment]
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  try {
    if (declaredEnvironment) {
      return {
        connection: parseVdbConnection(
          declaredEnvironment,
          selectedStore,
          "kubernetes-config",
        ),
        captures: declared.captures,
      };
    }
  } catch {
    // 声明配置不完整时继续读取 Container 运行态，避免把静态快照误当最终事实。
  }

  const environmentCapture = await executor.exec(target, ["env"], { timeoutMs: 20_000 });
  if (!environmentCapture.ok) {
    return {
      captures: [...declared.captures, environmentCapture],
      environmentCapture,
      reason: `读取 Container env 失败：${environmentCapture.stderr.trim() || `exit=${environmentCapture.exitCode}`}`,
    };
  }
  try {
    return {
      connection: parseVdbConnection(
        environmentCapture.stdout,
        selectedStore,
        "container-runtime",
      ),
      captures: [...declared.captures, environmentCapture],
      environmentCapture,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      captures: [...declared.captures, environmentCapture],
      environmentCapture,
      reason,
    };
  }
}

export function sanitizeVdbConnection(connection: VdbConnection): Record<string, unknown> {
  return {
    type: connection.type,
    store: connection.store,
    backend: connection.type === "unsupported" ? connection.backend : undefined,
    endpoint: connection.type === "opensearch" ? connection.endpoint : undefined,
    username: connection.type === "opensearch" ? connection.username : undefined,
    credentials: connection.type === "opensearch"
      ? connection.username && connection.password ? "configured" : "anonymous-or-incomplete"
      : undefined,
    config_source: connection.configSource,
    configuration_kind: connection.configurationKind,
  };
}
