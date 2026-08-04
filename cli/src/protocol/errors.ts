export class ServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.code = code;
  }
}

const CODE_TEXT: Record<string, string> = {
  invalid_profile: "profile 校验失败",
  llm_init_failed: "LLM 客户端无法初始化（检查 endpoint/api_key/model）",
  llm_unavailable: "LLM 调用不可用",
  workspace_init_failed: "server 初始化 workspace 失败",
  connection_not_found: "connection 已失效（server 可能重启过）",
  conversation_not_found: "conversation 在 server 上找不到",
  conversation_busy: "上一轮还在运行，请稍候",
};

export function mapErrorMessage(err: unknown): string {
  if (err instanceof ServerError) {
    const localized = CODE_TEXT[err.code];
    if (localized) return `${localized}（${err.code}）：${err.message}`;
    return `服务端错误 ${err.status} ${err.code}：${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
