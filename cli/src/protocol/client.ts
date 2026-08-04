import type {
  AgentEventBase,
  CreateConnectionResponse,
  ProfileUpload,
  ServerErrorBody,
} from "./types";
import { ServerError } from "./errors";
import { parseSseStream } from "./sse";

export interface MessageRequest {
  text: string;
  conversation_id?: string;
}

export class DoctorClient {
  private readonly base: string;

  constructor(serverBase: string) {
    this.base = serverBase.startsWith("http") ? serverBase : `http://${serverBase}`;
  }

  async healthz(): Promise<boolean> {
    const res = await fetch(`${this.base}/healthz`);
    return res.ok;
  }

  async createConnection(profile: ProfileUpload): Promise<string> {
    const res = await fetch(`${this.base}/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (!res.ok) await this.throwServerError(res);
    const data = (await res.json()) as CreateConnectionResponse;
    return data.connection_id;
  }

  async deleteConnection(cid: string): Promise<void> {
    const res = await fetch(`${this.base}/connections/${cid}`, { method: "DELETE" });
    // 204 no content = success; 404 means already gone — both are fine.
    if (!res.ok && res.status !== 404) {
      await this.throwServerError(res);
    }
  }

  async *streamMessage(
    cid: string,
    req: MessageRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEventBase> {
    const res = await fetch(`${this.base}/connections/${cid}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok || !res.body) await this.throwServerError(res);
    yield* parseSseStream(res.body!, signal);
  }

  private async throwServerError(res: Response): Promise<never> {
    let code = "unknown";
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ServerErrorBody;
      if (body.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // not JSON, keep defaults
    }
    throw new ServerError(res.status, code, message);
  }
}
