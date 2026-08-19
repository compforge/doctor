import type {
  Model,
  ModelInferenceTarget,
} from "@compforge/doctor-plugin";

/** A catalog model with the concrete inference target required by Doctor consumers. */
export interface SelectedInferenceModel extends Model {
  inference: ModelInferenceTarget;
}

/**
 * @spec Model Evidence 只持久化公共白名单字段，不能因 Plugin runtime 对象携带额外属性而泄漏凭据或私有配置
 * @see {@link ../../docs/commands/model-diagnosis.md}
 */
export function modelSnapshot(model: Model): Model {
  return {
    id: model.id,
    name: model.name,
    type: model.type,
    provider: model.provider,
    vendor: model.vendor,
    version: model.version,
    description: model.description,
    available: model.available,
    preset: model.preset,
    billing: model.billing,
    sourceModelId: model.sourceModelId,
    contextLength: model.contextLength,
    dimension: model.dimension,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
    capacities: model.capacities ? [...model.capacities] : undefined,
    features: model.features ? [...model.features] : undefined,
    pricing: model.pricing
      ? {
          input: model.pricing.input,
          output: model.pricing.output,
          unit: model.pricing.unit,
          currency: model.pricing.currency,
          type: model.pricing.type,
        }
      : undefined,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    inference: model.inference
      ? { baseUrl: model.inference.baseUrl, model: model.inference.model }
      : undefined,
  };
}

export function isMultimodalModel(model: Model): boolean {
  return new Set(model.inputModalities).size > 1;
}

export function supportsImageInput(model: Model): boolean {
  return model.inputModalities?.includes("image") ?? false;
}
