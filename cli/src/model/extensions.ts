import { scopedModelStream } from "./stream";
import {
  MODEL_QUERY_KIND, MODEL_BACKEND_INSPECT_KIND, MODEL_BACKEND_VALIDATE_KIND, MODEL_INVOKE_KIND, MODEL_STREAM_KIND,
  requireModelQueryExtension, requireModelBackendInspectExtension, requireModelBackendValidateExtension,
  requireModelInvokeExtension, requireModelStreamExtension,
  modelQueryOutput, modelBackendOutput, modelResponseOutput, modelStreamOutput,
  type Extension, type ServiceCatalog, type ServiceDefinition, type ServiceEndpoint,
  type ModelCatalog, type ModelInference, type ModelInferenceTarget,
} from "@compforge/doctor-plugin";
import { invokeExtension } from "../plugin/extension";
import type { ManagedPluginContext } from "../plugin/context";

function operations(catalog: ServiceCatalog, name: string) {
  const service = catalog.find(name);
  if (!service) throw new Error(`Unknown Service '${name}'`);
  return { service, find(kind: string) {
    const matches = catalog.extensions(kind).filter(item => item.service === service);
    if (matches.length > 1) throw new Error(`${service.name}: ambiguous ${kind} Extension`);
    return matches[0]?.extension;
  } };
}

export function modelCatalogExtensions(catalog: ServiceCatalog, name: string) {
  const { service, find } = operations(catalog, name);
  const query = find(MODEL_QUERY_KIND);
  if (!query) throw new Error(`${service.name}: missing ${MODEL_QUERY_KIND} Extension`);
  const inspect = find(MODEL_BACKEND_INSPECT_KIND);
  const validate = find(MODEL_BACKEND_VALIDATE_KIND);
  return { service, query: requireModelQueryExtension(query),
    inspect: inspect ? requireModelBackendInspectExtension(inspect) : undefined,
    validate: validate ? requireModelBackendValidateExtension(validate) : undefined };
}

export function modelInferenceExtensions(catalog: ServiceCatalog, name: string) {
  const { service, find } = operations(catalog, name);
  const invoke = find(MODEL_INVOKE_KIND);
  const stream = find(MODEL_STREAM_KIND);
  if (!invoke && !stream) throw new Error(`${service.name}: missing model.invoke or model.stream Extension`);
  return { service, invoke: invoke ? requireModelInvokeExtension(invoke) : undefined,
    stream: stream ? requireModelStreamExtension(stream) : undefined };
}

export type ModelExtensionContext = (
  service: ServiceDefinition, extension: Extension<never, unknown> & { endpoint: ServiceEndpoint },
) => Promise<ManagedPluginContext>;

async function call<Input, Output>(service: ServiceDefinition, extension: Extension<Input, Output> & { endpoint: ServiceEndpoint },
  input: Input, contextFor: ModelExtensionContext): Promise<Output> {
  const context = await contextFor(service, extension);
  try { return await invokeExtension(extension, context, input); }
  finally { await context.dispose(); }
}

/** Command-local facade: catalog results contain data, and active validation has its own access boundary. */
export function extensionModelCatalog(provider: ReturnType<typeof modelCatalogExtensions>, contextFor: ModelExtensionContext): ModelCatalog {
  const { service, query, inspect, validate } = provider;
  return {
    query: async input => modelQueryOutput(await call(service, query, input, contextFor)),
    getBackend: async model => {
      if (!inspect) return undefined;
      const backend = modelBackendOutput(await call(service, inspect, { model }, contextFor));
      if (!backend) return undefined;
      return { ...backend, validate: async timeoutMs => {
        if (!validate) throw new Error(`${service.name}: missing ${MODEL_BACKEND_VALIDATE_KIND} Extension`);
        return modelResponseOutput(await call(service, validate, { model, timeoutMs }, contextFor));
      } };
    },
  };
}

export function extensionModelInference(provider: ReturnType<typeof modelInferenceExtensions>,
  target: ModelInferenceTarget, timeoutMs: number, contextFor: ModelExtensionContext): ModelInference {
  const { service, invoke, stream } = provider;
  return {
    invoke: async (path, body) => {
      if (!invoke) throw new Error(`${service.name}: missing ${MODEL_INVOKE_KIND} Extension`);
      return modelResponseOutput(await call(service, invoke, { target, timeoutMs, path, body }, contextFor));
    },
    invokeStream: async (path, body, requestSignal) => {
      if (!stream) throw new Error(`${service.name}: missing ${MODEL_STREAM_KIND} Extension`);
      requestSignal.throwIfAborted();
      const context = await contextFor(service, stream);
      const signal = AbortSignal.any([requestSignal, context.signal]);
      try {
        signal.throwIfAborted();
        const response = modelStreamOutput(await invokeExtension(stream, context, { target, timeoutMs, path, body, signal }));
        if (!response.body) { await context.dispose(); return response; }
        return { ...response, body: scopedModelStream(response.body, context, signal, service.name) };
      } catch (error) {
        await context.dispose();
        throw error;
      }
    },
  };
}
