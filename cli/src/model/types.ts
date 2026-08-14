import type {
  Model,
  ModelInferenceTarget,
} from "@compforge/doctor-plugin";

/** A catalog model with the concrete inference target required by Doctor consumers. */
export interface SelectedInferenceModel extends Model {
  inference: ModelInferenceTarget;
}

export function isMultimodalModel(model: Model): boolean {
  return new Set(model.inputModalities).size > 1;
}

export function supportsImageInput(model: Model): boolean {
  return model.inputModalities?.includes("image") ?? false;
}
