import type {
  Model,
  ModelCatalog,
  ModelInference,
  ServiceHttpResponse,
} from "@compforge/doctor-plugin";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finalizeResult } from "./report-fixture";
import { runModelDiagnosis } from "../src/collect/model";
import { modelCommand } from "../src/collect/model/command";
import { CommandContext, commandOutcome } from "../src/command";
import { modelSnapshot, requireInferenceModel } from "../src/model";

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
    expect(await finalizeResult(jsonContext, modelCommand,
      { ...commandOutcome(result.exitCode), artifacts: jsonContext.artifacts.list() },
      { format: "json", output: requestedOutput })).toBe(0);
    const exported = JSON.parse(readFileSync(outputPath, "utf8"));
    const readEvidence = (file: string) => JSON.parse(readFileSync(join(dirname(exported.manifest), file), "utf8"));
    expect(exported.result.evidence.facts).toEqual({ file: "raw/facts.json" });
    expect({ evidence: { facts: readEvidence(exported.result.evidence.facts.file),
      observations: readEvidence(exported.result.evidence.observations.file) } }).toMatchObject({
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
    expect(stdout).toContain(`[delivery] diagnosis.json: ${outputPath}`);
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
    expect(await finalizeResult(defaultContext, modelCommand,
      { ...commandOutcome(defaultResult.exitCode), artifacts: defaultContext.artifacts.list() },
      { output: defaultOutput })).toBe(0);
    expect(existsSync(defaultOutput)).toBe(true);
    expect(statSync(defaultOutput).mode & 0o777).toBe(0o600);
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
