import type { ServiceDefinition } from "../service";
import type { RegisteredExtension } from "./index";
import {
  MODEL_QUERY_KIND, MODEL_BACKEND_INSPECT_KIND, MODEL_BACKEND_VALIDATE_KIND, MODEL_INVOKE_KIND, MODEL_STREAM_KIND,
  modelBackendOutput, type ModelQueryExtension, type ModelBackendInspectExtension, type ModelBackendValidateExtension,
  type ModelInvokeExtension, type ModelStreamExtension,
} from "./model";

export function adaptModelExtensions(service: ServiceDefinition): RegisteredExtension[] {
  const extensions: RegisteredExtension[] = [];
  const add = <T extends RegisteredExtension>(extension: T) => extensions.push(extension);
  const catalog = service.capabilities.modelCatalog;
  if (catalog) {
    add({ id: MODEL_QUERY_KIND, kind: MODEL_QUERY_KIND, endpoint: catalog.endpoint, access: catalog.access,
      run: async (context, input) => catalog.create(context).query(input),
    } satisfies ModelQueryExtension);
    add({ id: MODEL_BACKEND_INSPECT_KIND, kind: MODEL_BACKEND_INSPECT_KIND, endpoint: catalog.endpoint, access: catalog.access,
      run: async (context, input) => modelBackendOutput(await catalog.create(context).getBackend(input.model)),
    } satisfies ModelBackendInspectExtension);
    add({ id: MODEL_BACKEND_VALIDATE_KIND, kind: MODEL_BACKEND_VALIDATE_KIND, endpoint: catalog.endpoint, access: catalog.access,
      run: async (context, input) => {
        const backend = await catalog.create(context).getBackend(input.model);
        if (!backend) throw new Error(`${service.name}: backend unavailable for model '${input.model.id}'`);
        return backend.validate(input.timeoutMs);
      },
    } satisfies ModelBackendValidateExtension);
  }
  const inference = service.capabilities.inference;
  if (inference) {
    add({ id: MODEL_INVOKE_KIND, kind: MODEL_INVOKE_KIND, endpoint: inference.endpoint, access: inference.access,
      run: async (context, input) => (await inference.create(context, input.target, input.timeoutMs)).invoke(input.path, input.body),
    } satisfies ModelInvokeExtension);
    add({ id: MODEL_STREAM_KIND, kind: MODEL_STREAM_KIND, endpoint: inference.endpoint, access: inference.access,
      run: async (context, input) => (await inference.create(context, input.target, input.timeoutMs)).invokeStream(input.path, input.body, input.signal),
    } satisfies ModelStreamExtension);
  }
  return extensions;
}
