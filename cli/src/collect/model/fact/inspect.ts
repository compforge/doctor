import type { TenantSummary } from "@compforge/doctor-plugin";
import type { Inspect } from "../../inspection";
import type {
  ModelInspectContext,
  ModelInspectionFacts,
  SelectedInferenceModel,
} from "../model";

export function makeModelInspect(
  tenant: TenantSummary,
  model: SelectedInferenceModel,
): Inspect<ModelInspectionFacts, ModelInspectContext> {
  return {
    id: "model-target",
    run: async (ctx) => {
      const target: ModelInspectionFacts["target"] = {
        status: "collected",
        tenant: {
          id: tenant.id,
          name: tenant.name,
          displayName: tenant.displayName,
        },
        model: {
          id: model.id,
          name: model.name,
          type: model.type,
          provider: model.provider,
          vendor: model.vendor,
          version: model.version,
          inputModalities: model.inputModalities,
          inference: model.inference,
        },
      };
      try {
        const backend = await ctx.catalog.getBackend(model);
        if (!backend) {
          return {
            target,
            backend: {
              status: "unavailable",
              reason: `模型目录 backend 中不包含模型 ${model.id}`,
            },
          };
        }
        // Plugin handle 可能持有 credentials，因此只持久化规范化身份。
        ctx.backend = backend;
        return {
          target,
          backend: {
            status: "collected",
            modelId: backend.modelId,
            modelName: backend.modelName,
            model: backend.model,
            type: backend.type,
            provider: backend.provider,
          },
        };
      } catch (error) {
        return {
          target,
          backend: {
            status: "failed",
            reason: `读取模型目录 backend 失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
    },
  };
}
