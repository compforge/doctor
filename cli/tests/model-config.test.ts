import { describe, expect, test } from "bun:test";
import {
  buildModelTestRequest,
  makeModelInferenceProbe,
} from "../src/collect/model";
import {
  isMultimodalModel,
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
  test("derives multimodal and image support from catalog modalities", () => {
    expect(isMultimodalModel(textModel)).toBe(false);
    expect(isMultimodalModel(imageModel)).toBe(true);
    expect(supportsImageInput(textModel)).toBe(false);
    expect(supportsImageInput(imageModel)).toBe(true);
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
        enabled: true,
      }],
    }];
    expect(makeModelInferenceProbe(textModel).evaluate({} as never, {} as never, progress))
      .toMatchObject({ runnable: false, status: "unnecessary" });
    expect(makeModelInferenceProbe(imageModel).evaluate({} as never, {} as never, progress))
      .toEqual({ runnable: true });
  });
});
