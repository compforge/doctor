import type { PluginDefinition, ServiceLivenessCapability } from "@compforge/doctor-plugin";
import type { ExecResult, ExecTarget, Executor } from "../../infra/k8s/executor";
import type { KubernetesService } from "../../infra/k8s/service";
import type { ContainerInfo, TargetPod } from "../../infra/k8s/target";

const PROXY_ROOT = "/tmp/doctor-pydump";

export interface LivenessProxyIntent {
  service: string;
  podIP: string;
  port: number;
  path: string;
  userAgent: string;
  userAgentExact: boolean;
  response: { statusCode: number; body: string };
}

export interface ActiveLivenessProxy {
  target: ExecTarget;
  pid: number;
  guardPath: string;
  service: string;
}

export type LivenessProxyResolution =
  | { intent: LivenessProxyIntent; reason?: undefined }
  | { intent?: undefined; reason: string };

function serviceSelectsPod(service: KubernetesService, pod: TargetPod): boolean {
  const selector = Object.entries(service.selector);
  return service.namespace === pod.namespace
    && selector.length > 0
    && selector.every(([name, value]) => pod.labels[name] === value);
}

function probePort(container: ContainerInfo, value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535) return value;
  if (typeof value !== "string") return undefined;
  return container.ports?.find((port) => port.name === value)?.containerPort;
}

function proxyContract(
  plugin: PluginDefinition | undefined,
  services: readonly KubernetesService[],
  pod: TargetPod,
): { service: string; capability: ServiceLivenessCapability } | undefined {
  if (!plugin) return undefined;
  const candidates = services
    .filter((service) => serviceSelectsPod(service, pod))
    .flatMap((service) => {
      const declared = plugin.services.findWith(service.name, "liveness")?.capabilities.liveness;
      return declared?.heapDumpProxy ? [{ service: service.name, capability: declared }] : [];
    });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Match the live Pod probe to one explicit Plugin opt-in; no match means no traffic interception. */
export function resolveLivenessProxyIntent(input: {
  plugin?: PluginDefinition;
  services: readonly KubernetesService[];
  pod: TargetPod;
  container: ContainerInfo;
}): LivenessProxyResolution {
  const probe = input.container.livenessProbe?.httpGet;
  if (!probe) return { reason: "目标 Container 没有 HTTP livenessProbe" };
  const contract = proxyContract(input.plugin, input.services, input.pod);
  if (!contract) return { reason: "未唯一匹配到显式允许 heap dump 代理的 Plugin Service" };
  if (input.pod.hostNetwork) return { reason: "hostNetwork Pod 不允许修改共享的 Node 网络规则" };
  if (!input.pod.podIP) return { reason: "Pod 尚未报告 podIP" };
  if (probe.host?.trim()) return { reason: "显式覆盖 host 的 HTTP livenessProbe 暂不代理" };
  if ((probe.scheme ?? "HTTP").toUpperCase() !== "HTTP") {
    return { reason: "HTTPS livenessProbe 无法安全识别并合成响应" };
  }
  const port = probePort(input.container, probe.port);
  if (!port) return { reason: "无法把 livenessProbe port 解析为目标 Container 端口" };
  const path = probe.path?.trim() || "/";
  if (path !== contract.capability.httpGet.path || port !== contract.capability.httpGet.port) {
    return {
      reason: `Pod liveness ${path}:${port} 与 Plugin 声明 `
        + `${contract.capability.httpGet.path}:${contract.capability.httpGet.port} 不一致`,
    };
  }
  const configuredUserAgent = probe.httpHeaders?.find(
    (header) => header.name?.trim().toLowerCase() === "user-agent",
  );
  if (configuredUserAgent && !configuredUserAgent.value) {
    return { reason: "livenessProbe 移除了 User-Agent，无法与普通业务请求可靠区分" };
  }
  const response = contract.capability.heapDumpProxy!;
  return {
    intent: {
      service: contract.service,
      podIP: input.pod.podIP,
      port,
      path,
      userAgent: configuredUserAgent?.value ?? "kube-probe/",
      userAgentExact: configuredUserAgent !== undefined,
      response: { statusCode: response.statusCode, body: response.body ?? "" },
    },
  };
}

const PROXY_CONTROLLER = String.raw`
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

config = json.loads(sys.argv[1])
stopping = False
server = socket.socket(socket.AF_INET6 if ":" in config["pod_ip"] else socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("::" if ":" in config["pod_ip"] else "0.0.0.0", 0))
server.listen(32)
server.settimeout(0.5)
proxy_port = server.getsockname()[1]
iptables = "ip6tables" if ":" in config["pod_ip"] else "iptables"
rule = [
    iptables, "-w", "5", "-t", "nat", "PREROUTING", "-d", config["pod_ip"],
    "-p", "tcp", "--dport", str(config["port"]), "-m", "comment", "--comment", config["token"],
    "-j", "REDIRECT", "--to-ports", str(proxy_port),
]
insert = rule[:5] + ["-I"] + rule[5:6] + ["1"] + rule[6:]
delete = rule[:5] + ["-D"] + rule[5:]
check = rule[:5] + ["-C"] + rule[5:]

def cleanup_rule():
    deleted = subprocess.run(delete, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if deleted.returncode == 0:
        return True
    # iptables -C returns 1 when the exact rule is already absent. Other return
    # codes mean the state is unknown, so preserve the guard for Doctor to retry.
    checked = subprocess.run(check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return checked.returncode == 1

def stop(*_):
    global stopping
    stopping = True

def copy_stream(source, destination):
    try:
        while data := source.recv(65536):
            destination.sendall(data)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def handle(client):
    client.settimeout(2)
    request = b""
    try:
        while b"\r\n\r\n" not in request and len(request) < 16384:
            chunk = client.recv(4096)
            if not chunk:
                break
            request += chunk
        head = request.split(b"\r\n\r\n", 1)[0].decode("iso-8859-1", "replace")
        lines = head.split("\r\n")
        request_line = lines[0].split(" ") if lines else []
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        user_agent = headers.get("user-agent", "")
        agent_matches = user_agent == config["user_agent"] if config["user_agent_exact"] else user_agent.startswith(config["user_agent"])
        if len(request_line) >= 2 and request_line[0] == "GET" and request_line[1] == config["path"] and agent_matches:
            body = config["body"].encode()
            status = config["status"]
            response = (
                f"HTTP/1.1 {status} Doctor temporary liveness\r\n"
                f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
                "Connection: close\r\n\r\n"
            ).encode() + body
            client.sendall(response)
            return
        upstream = socket.create_connection((config["pod_ip"], config["port"]), timeout=2)
        upstream.sendall(request)
        client.settimeout(None)
        upstream.settimeout(None)
        reverse = threading.Thread(target=copy_stream, args=(upstream, client), daemon=True)
        reverse.start()
        copy_stream(client, upstream)
        reverse.join(timeout=2)
        upstream.close()
    except OSError:
        pass
    finally:
        client.close()

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    subprocess.run(insert, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    temporary = config["guard"] + ".tmp"
    with open(temporary, "w") as output:
        json.dump({"pid": os.getpid(), "proxy_port": proxy_port, "delete": delete, "check": check}, output)
    os.replace(temporary, config["guard"])
    deadline = time.monotonic() + config["ttl_seconds"]
    while not stopping and time.monotonic() < deadline:
        try:
            client, _ = server.accept()
        except socket.timeout:
            continue
        threading.Thread(target=handle, args=(client,), daemon=True).start()
finally:
    if cleanup_rule():
        try:
            os.unlink(config["guard"])
        except FileNotFoundError:
            pass
    server.close()
`;

const PROXY_LAUNCHER = String.raw`
import os
import subprocess
import sys

os.makedirs(sys.argv[3], mode=0o700, exist_ok=True)
log = open(sys.argv[4], "ab", buffering=0)
process = subprocess.Popen(
    [sys.executable, "-c", sys.argv[1], sys.argv[2]],
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    close_fds=True,
    start_new_session=True,
)
print(process.pid)
`;

const WAIT_FOR_GUARD = String.raw`
import json
import os
import sys
import time

path, expected_pid = sys.argv[1], int(sys.argv[2])
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    try:
        with open(path) as source:
            guard = json.load(source)
        if guard.get("pid") == expected_pid:
            print(json.dumps(guard, separators=(",", ":")))
            raise SystemExit(0)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    try:
        os.kill(expected_pid, 0)
    except ProcessLookupError:
        raise SystemExit("temporary liveness proxy exited before becoming ready")
    time.sleep(0.1)
raise SystemExit("temporary liveness proxy did not become ready within 10s")
`;

const STOP_PROXY = String.raw`
import json
import os
import signal
import subprocess
import sys
import time

path, expected_pid = sys.argv[1], int(sys.argv[2])
try:
    os.kill(expected_pid, signal.SIGTERM)
except ProcessLookupError:
    pass
deadline = time.monotonic() + 5
while time.monotonic() < deadline and os.path.exists(path):
    time.sleep(0.1)
try:
    with open(path) as source:
        guard = json.load(source)
    delete = guard.get("delete", [])
    deleted = subprocess.run(delete, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check = guard.get("check", [])
    absent = check and subprocess.run(
        check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode == 1
    if deleted.returncode == 0 or absent:
        os.unlink(path)
except (FileNotFoundError, json.JSONDecodeError):
    pass
`;

export function livenessProxyPrereqCmd(podIP: string): string[] {
  const iptables = podIP.includes(":") ? "ip6tables" : "iptables";
  return ["sh", "-c", `command -v python3 >/dev/null && command -v ${iptables} >/dev/null`];
}

export function startLivenessProxyCmd(
  intent: LivenessProxyIntent,
  token: string,
  ttlSeconds: number,
): { command: string[]; guardPath: string } {
  const guardPath = `${PROXY_ROOT}/liveness-${token}.json`;
  const logPath = `${PROXY_ROOT}/liveness-${token}.log`;
  const config = JSON.stringify({
    pod_ip: intent.podIP,
    port: intent.port,
    path: intent.path,
    user_agent: intent.userAgent,
    user_agent_exact: intent.userAgentExact,
    status: intent.response.statusCode,
    body: intent.response.body,
    token: `doctor-mem-${token}`,
    ttl_seconds: ttlSeconds,
    guard: guardPath,
  });
  return {
    guardPath,
    command: ["python3", "-c", PROXY_LAUNCHER, PROXY_CONTROLLER, config, PROXY_ROOT, logPath],
  };
}

export function waitLivenessProxyCmd(guardPath: string, pid: number): string[] {
  return ["python3", "-c", WAIT_FOR_GUARD, guardPath, String(pid)];
}

export function stopLivenessProxyCmd(proxy: ActiveLivenessProxy): string[] {
  return ["python3", "-c", STOP_PROXY, proxy.guardPath, String(proxy.pid)];
}

export function parseDetachedPid(result: ExecResult): number | undefined {
  const pid = Number(result.stdout.trim().split("\n").at(-1));
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

export async function startTemporaryLivenessProxy(input: {
  executor: Executor;
  target: ExecTarget;
  intent: LivenessProxyIntent;
  token: string;
  ttlSeconds: number;
}): Promise<{ proxy?: ActiveLivenessProxy; results: ExecResult[]; reason?: string }> {
  const prerequisites = await input.executor.exec(
    input.target,
    livenessProxyPrereqCmd(input.intent.podIP),
    { timeoutMs: 10_000 },
  );
  if (!prerequisites.ok) {
    return { results: [prerequisites], reason: "debug container 缺少 Python 或 iptables" };
  }
  const launch = startLivenessProxyCmd(input.intent, input.token, input.ttlSeconds);
  const started = await input.executor.exec(input.target, launch.command, { timeoutMs: 10_000 });
  const pid = started.ok ? parseDetachedPid(started) : undefined;
  if (!pid) return { results: [prerequisites, started], reason: "无法启动临时 liveness proxy" };
  const ready = await input.executor.exec(
    input.target,
    waitLivenessProxyCmd(launch.guardPath, pid),
    { timeoutMs: 15_000 },
  );
  if (!ready.ok) {
    await input.executor.exec(
      input.target,
      stopLivenessProxyCmd({ target: input.target, pid, guardPath: launch.guardPath, service: input.intent.service }),
      { timeoutMs: 10_000 },
    );
    return { results: [prerequisites, started, ready], reason: "临时 liveness proxy 未就绪" };
  }
  return {
    results: [prerequisites, started, ready],
    proxy: { target: input.target, pid, guardPath: launch.guardPath, service: input.intent.service },
  };
}
