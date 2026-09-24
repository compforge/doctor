/** Common registration envelope; each kind owns its invocation and output contract. */
export interface ExtensionRegistration {
  readonly id: string;
  readonly kind: string;
  readonly description?: string;
}

export interface RegisteredProvider<T extends ExtensionRegistration = ExtensionRegistration> {
  readonly owner: string;
  readonly extension: T;
}

/** Core, Plugin and local adapters share discovery without requiring a Service or target context. */
export class ExtensionRegistry<T extends ExtensionRegistration = ExtensionRegistration> {
  private readonly providers: RegisteredProvider<T>[] = [];

  register(owner: string, extensions: readonly T[]): void {
    if (!owner.trim()) throw new Error("Extension owner must be non-empty");
    for (const extension of extensions) {
      validateExtensionRegistration(extension);
      if (this.providers.some((item) => item.owner === owner && item.extension.id === extension.id)) {
        throw new Error(`${owner}: duplicate Extension id '${extension.id}'`);
      }
      this.providers.push({ owner, extension });
    }
  }

  extensions(kind: string): RegisteredProvider<T>[] {
    return this.providers.filter((item) => item.extension.kind === kind);
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
