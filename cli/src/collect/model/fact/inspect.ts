import type { TenantSummary } from "@compforge/doctor-plugin";
import { modelSnapshot } from "../../../model";
import type { Inspect } from "../../inspection";
import type {
  ModelCommandContext,
  ModelInspectionFacts,
  SelectedInferenceModel,
} from "../model";
import { collectedFact, failedFact, unavailableFact } from "../../protocol";

export function makeModelInspect(
  tenant: TenantSummary,
  model: SelectedInferenceModel,
): Inspect<ModelInspectionFacts, ModelCommandContext> {
  return {
    id: "model-target",
    run: async (ctx) => {
      const target: ModelInspectionFacts["target"] = collectedFact("model.target", "model-target", {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          displayName: tenant.displayName,
        },
        model: {
          ...modelSnapshot(model),
          inference: model.inference,
        },
      });
      try {
        const backend = await ctx.catalog.getBackend(model);
        if (!backend) {
          return {
            target,
            backend: unavailableFact("model.backend", "model-target", `模型目录 backend 中不包含模型 ${model.id}`),
          };
        }
        // Plugin handle 可能持有 credentials，因此只持久化规范化身份。
        ctx.backend = backend;
        return {
          target,
          backend: collectedFact("model.backend", "model-target", {
            modelId: backend.modelId,
            modelName: backend.modelName,
            model: backend.model,
            type: backend.type,
            provider: backend.provider,
          }),
        };
      } catch (error) {
        return {
          target,
          backend: failedFact("model.backend", "model-target", `读取模型目录 backend 失败：${
              error instanceof Error ? error.message : String(error)
            }`),
        };
      }
    },
  };
}
