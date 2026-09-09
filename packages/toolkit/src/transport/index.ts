export interface Endpoint { host: string; port: number; servername?: string }

export interface TcpTransport {
  readonly kind: "tcp";
  readonly name: string;
  connect(endpoint: Endpoint): Promise<Endpoint>;
}

export class DirectTransport implements TcpTransport {
  readonly kind = "tcp";
  readonly name = "direct";
  async connect(endpoint: Endpoint): Promise<Endpoint> { return endpoint; }
}

/** The supplied forwarder owns port allocation and cleanup; external endpoints may stay direct. */
export class PortForwardTransport implements TcpTransport {
  readonly kind = "tcp";
  readonly name = "port-forward";
  constructor(private readonly forward: (endpoint: Endpoint) => Promise<Endpoint>) {}
  connect(endpoint: Endpoint): Promise<Endpoint> { return this.forward(endpoint); }
}

export interface PodRunOptions { stdin: string; timeoutMs: number }
export type PodRunner = (command: readonly string[], options: PodRunOptions) => Promise<string>;

/** A Python-capable Pod path. Protocol code supplies the script; the host enforces access. */
export class PodPythonTransport {
  readonly kind = "python";
  readonly name = "pod-python";
  constructor(private readonly exec: PodRunner, private readonly python = "python") {}
  run(script: string, input: unknown, timeoutMs: number): Promise<string> {
    return this.exec([this.python, "-c", script], { stdin: JSON.stringify(input), timeoutMs });
  }
}

export type Transport = TcpTransport | PodPythonTransport;

/** Only failure to establish a connection permits a route change; never replay protocol operations. */
export function isConnectionNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
    "EADDRNOTAVAIL", "ENOTFOUND", "EAI_AGAIN"].includes(String(error.code));
}
