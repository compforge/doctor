import { describe, expect, test } from "bun:test";
import {
  buildModelTestRequest,
  makeModelInferenceProbe,
  parseModelOutputFormat,
  resolveModelDiagnosisOutput,
} from "../src/collect/model";
import {
  isMultimodalModel,
  modelChoiceTone,
  requireInferenceModel,
  supportsImageInput,
} from "../src/model";

const textModel = requireInferenceModel({
  id: "text-model",
  name: "text-model",
  type: "llm",
  provider: "test",
  inputModalities: ["text"],
  inference: { baseUrl: "http://inference/v1", model: "text-model" },
});

const imageModel = requireInferenceModel({
  ...textModel,
  id: "image-model",
  name: "image-model",
  inputModalities: ["text", "image"],
  inference: { ...textModel.inference, model: "image-model" },
});

describe("doctor model multimodal inference", () => {
  test("defaults to dual delivery and keeps explicit JSON/HTML", () => {
    expect(parseModelOutputFormat(undefined)).toBe("default");
    expect(parseModelOutputFormat("html")).toBe("html");
    expect(() => parseModelOutputFormat("terminal")).toThrow("--format 只支持 bundle、json 或 html");

    const now = new Date(2026, 7, 18, 9, 8, 7);
    expect(resolveModelDiagnosisOutput(undefined, "json", now))
      .toMatch(/doctor-model-20260818090807\.json$/);
    expect(resolveModelDiagnosisOutput("model-report", "html", now)).toMatch(/model-report\.html$/);
  });

  test("derives multimodal and image support from catalog modalities", () => {
    expect(isMultimodalModel(textModel)).toBe(false);
    expect(isMultimodalModel(imageModel)).toBe(true);
    expect(supportsImageInput(textModel)).toBe(false);
    expect(supportsImageInput(imageModel)).toBe(true);
  });

  test("assigns distinct terminal tones to model categories", () => {
    expect(modelChoiceTone(textModel)).toBe("info");
    expect(modelChoiceTone({ ...textModel, type: "embedding" })).toBe("blue");
    expect(modelChoiceTone({ ...textModel, type: "rerank" })).toBe("warning");
    expect(modelChoiceTone(imageModel)).toBe("magenta");
  });

  test("uses a built-in PNG for image-capable LLMs", () => {
    const request = buildModelTestRequest(imageModel);
    expect(request.path).toBe("/chat/completions");
    expect(request.body).toMatchObject({
      model: "image-model",
      messages: [{
        role: "user",
        content: [{ type: "text" }, {
          type: "image_url",
          image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
        }],
      }],
      stream: false,
    });
  });

  test("keeps the existing text-only connectivity request", () => {
    expect(buildModelTestRequest(textModel).body).toMatchObject({
      messages: [{ role: "user", content: "Reply with OK only." }],
    });
  });

  test("still runs the image probe when text performance sampling is enabled", () => {
    const progress = [{
      probeId: "model-performance-decision",
      status: "ok" as const,
      observations: [{
        id: "model-performance-decision" as const,
        kind: "model-performance-decision" as const,
        schemaVersion: 1,
        producer: { origin: "core" as const, id: "model-performance-decision" },
        enabled: true,
      }],
    }];
    expect(makeModelInferenceProbe(textModel).evaluate({} as never, {} as never, progress))
      .toMatchObject({ runnable: false, status: "unnecessary" });
    expect(makeModelInferenceProbe(imageModel).evaluate({} as never, {} as never, progress))
      .toEqual({ runnable: true });
  });
});
