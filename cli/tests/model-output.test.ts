import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelCatalog,
  ModelInference,
  ServiceHttpResponse,
} from "@compforge/doctor-plugin";
import { runModelDiagnosis } from "../src/collect/model";
import { requireInferenceModel } from "../src/model";
import { CommandContext } from "../src/command";

const response = (text: string): ServiceHttpResponse => ({
  ok: true,
  statusCode: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  text,
  durationMs: 10,
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
    inference: { baseUrl: "http://inference.invalid/v1", model: "model-1" },
  });
  const catalog: ModelCatalog = {
    listAvailable: async () => [model],
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
    const result = await runModelDiagnosis({
      command: new CommandContext({}),
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
    expect(result.outputPath).toBe(outputPath);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      evidence: {
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
    expect(stdout).toContain(`[model] 诊断 JSON：${outputPath}`);
    expect(stdout).not.toContain("MODEL_RESPONSE_BODY");

    const defaultOutput = join(root, "bundle.tar.gz");
    const defaultResult = await runModelDiagnosis({
      command: new CommandContext({}),
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
    expect(existsSync(defaultOutput)).toBe(true);
    expect(statSync(defaultOutput).mode & 0o777).toBe(0o600);
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
