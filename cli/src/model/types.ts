import type {
  Model,
  ModelInferenceTarget,
} from "@compforge/doctor-plugin";

/** A catalog model with the concrete inference target required by Doctor consumers. */
export interface SelectedInferenceModel extends Model {
  inference: ModelInferenceTarget;
}
