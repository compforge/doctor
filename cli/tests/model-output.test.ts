import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Model,
  ModelCatalog,
  ModelInference,
  ServiceHttpResponse,
} from "@compforge/doctor-plugin";
import { runModelDiagnosis } from "../src/collect/model";
import { modelSnapshot, requireInferenceModel } from "../src/model";
import { CommandContext } from "../src/command";
import { deliverCommandArtifacts } from "../src/app/delivery";

const response = (text: string): ServiceHttpResponse => ({
  ok: true,
  statusCode: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  text,
  durationMs: 10,
});

test("model Evidence snapshot keeps public inventory fields and drops Plugin-private data", () => {
  const model = {
    id: "model-1",
    name: "Model 1",
    type: "embedding",
    provider: "test",
    description: "Embedding model",
    available: true,
    dimension: 1024,
    capacities: ["embedding_vision"],
    apiKey: "must-not-leak",
    extraHeaders: { Authorization: "must-not-leak" },
  } satisfies Model & { apiKey: string; extraHeaders: Record<string, string> };

  expect(modelSnapshot(model)).toMatchObject({
    id: "model-1",
    description: "Embedding model",
    available: true,
    dimension: 1024,
    capacities: ["embedding_vision"],
  });
  expect(modelSnapshot(model)).not.toHaveProperty("apiKey");
  expect(modelSnapshot(model)).not.toHaveProperty("extraHeaders");
});

test("doctor model JSON writes the diagnosis to a file without printing the response body", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-model-json-output-"));
  const requestedOutput = join(root, "diagnosis");
  const outputPath = `${requestedOutput}.json`;
  const responseBody = '{"answer":"MODEL_RESPONSE_BODY"}';
  const model = requireInferenceModel({
    id: "model-1",
    name: "Model 1",
    type: "llm",
    provider: "test",
    capacities: ["reason", "tool_use"],
    inference: { baseUrl: "http://inference.invalid/v1", model: "model-1" },
  });
  const catalog: ModelCatalog = {
    query: async () => [model],
    getBackend: async () => ({
      modelId: model.id,
      modelName: model.name,
      model: model.inference.model,
      type: model.type,
      provider: model.provider,
      validate: async () => response('{"parameters":null}'),
    }),
  };
  const inference: ModelInference = {
    invoke: async () => response(responseBody),
    invokeStream: async () => { throw new Error("unexpected streaming inference"); },
  };
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    const jsonContext = new CommandContext({});
    const result = await runModelDiagnosis({
      command: jsonContext,
      tenant: { id: "tenant-1", name: "tenant-1", displayName: "Tenant 1" },
      model,
      catalog,
      inference,
      performance: false,
      repeat: 1,
      timeoutMs: 1_000,
      maxOutputTokens: 32,
      format: "json",
      output: requestedOutput,
      profileName: "test",
    });

    expect(result.exitCode).toBe(0);
    expect(await deliverCommandArtifacts(
      jsonContext,
      { format: "json", output: requestedOutput },
      result.exitCode,
      "doctor model",
    )).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      evidence: {
        facts: {
          target: { model: { capacities: ["reason", "tool_use"] } },
        },
        observations: [{ kind: "model-validation" }, {
          kind: "model-performance-decision",
          enabled: false,
        }, {
          kind: "model-inference",
          response: { text: responseBody },
        }],
      },
    });
    const stdout = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain(`[delivery] JSON 报告: ${outputPath}`);
    expect(stdout).not.toContain("MODEL_RESPONSE_BODY");

    const defaultOutput = join(root, "bundle.tar.gz");
    const defaultContext = new CommandContext({});
    const defaultResult = await runModelDiagnosis({
      command: defaultContext,
      tenant: { id: "tenant-1", name: "tenant-1", displayName: "Tenant 1" },
      model,
      catalog,
      inference,
      performance: false,
      repeat: 1,
      timeoutMs: 1_000,
      maxOutputTokens: 32,
      format: "default",
      output: defaultOutput,
      profileName: "test",
    });
    expect(defaultResult.exitCode).toBe(0);
    expect(await deliverCommandArtifacts(
      defaultContext,
      { output: defaultOutput },
      defaultResult.exitCode,
      "doctor model",
    )).toBe(true);
    expect(existsSync(defaultOutput)).toBe(true);
    expect(statSync(defaultOutput).mode & 0o777).toBe(0o600);
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
