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
          apiBase: model.metaData.apiBase,
          endpointId: model.metaData.endpointId,
        },
      };
      try {
        const backend = await ctx.catalog.getBackend(model.id);
        if (!backend) {
          return {
            target,
            backend: {
              status: "unavailable",
              reason: `模型目录 backend 中不包含模型 ${model.id}`,
            },
          };
        }
        // validation 需要 credentials，但它不应进入可持久化 Facts。
        ctx.backend = backend;
        return {
          target,
          backend: {
            status: "collected",
            modelId: backend.ModelID,
            modelName: backend.ModelName,
            model: backend.Model,
            type: backend.Type,
            provider: backend.Provider,
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
