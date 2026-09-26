/** Common registration envelope; each kind owns its invocation and output contract. */
export interface ExtensionRegistration {
  readonly id: string;
  readonly kind: string;
  readonly description?: string;
}

export interface RegisteredProvider<T extends ExtensionRegistration = ExtensionRegistration> {
  readonly namespace: string;
  readonly extension: T;
}

// Namespace paths are identifiers, not filesystem paths or access scopes.
const NAMESPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Join identifier segments without allowing a Plugin/Service name to inject another path level. */
export function extensionNamespace(...segments: readonly string[]): string {
  if (!segments.length || segments.some(segment => typeof segment !== "string" || NAMESPACE_SEGMENT.exec(segment)?.[0] !== segment)) {
    throw new Error("Extension namespace segments must start with an ASCII letter or digit and contain only letters, digits, '.', '_' or '-'");
  }
  return segments.join("/");
}

/** Validate without trimming or rewriting: namespace identity is exact and case-sensitive. */
export function validateExtensionNamespace(namespace: string): void {
  if (typeof namespace !== "string") throw new Error("Extension namespace must be a string");
  extensionNamespace(...namespace.split("/"));
}

/**
 * Core, Plugin and local adapters share discovery without requiring a Service or target context.
 * @spec namespace + id uniquely identifies an implementation, independently of kind
 * @spec namespace selection is exact; path prefixes never imply inheritance or access
 */
export class ExtensionRegistry<T extends ExtensionRegistration = ExtensionRegistration> {
  private readonly providers: RegisteredProvider<T>[] = [];

  register(namespace: string, extensions: readonly T[]): void {
    validateExtensionNamespace(namespace);
    for (const extension of extensions) {
      validateExtensionRegistration(extension);
      if (this.providers.some((item) => item.namespace === namespace && item.extension.id === extension.id)) {
        throw new Error(`${namespace}: duplicate Extension id '${extension.id}'`);
      }
      this.providers.push({ namespace, extension });
    }
  }

  extensions(kind: string, namespace?: string): RegisteredProvider<T>[] {
    if (namespace !== undefined) validateExtensionNamespace(namespace);
    return this.providers.filter((item) => item.extension.kind === kind
      && (namespace === undefined || item.namespace === namespace));
  }
}

export function validateExtensionRegistration(value: unknown): asserts value is ExtensionRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Extension must be an object");
  const item = value as Record<string, unknown>;
  for (const field of ["id", "kind"] as const) {
    if (typeof item[field] !== "string" || !(item[field] as string).trim()) throw new Error(`Extension.${field} must be a non-empty string`);
  }
  if (item.description !== undefined && (typeof item.description !== "string" || !item.description.trim())) {
    throw new Error("Extension.description must be a non-empty string");
  }
}
