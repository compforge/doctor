import type { ModelInference } from "@compforge/doctor-plugin";
import type { LlmFetch } from "@compforge/doctor-agent";

/** Adapt Plugin-owned inference routing to Pi's OpenAI-compatible streaming transport. */
export function createModelInferenceFetch(inference: ModelInference): LlmFetch {
  return async (input, init) => {
    const request = input instanceof Request
      ? input
      : new Request(input instanceof URL ? input.toString() : input, init);
    if (request.method !== "POST") {
      throw new Error(`Doctor chat inference only supports POST, received ${request.method}`);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await request.text()) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Doctor chat inference request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const response = await inference.invokeStream("/chat/completions", body, request.signal);
    return new Response(response.body, {
      status: response.statusCode,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
