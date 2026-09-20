import { validateExtension, type RegisteredExtension } from "./extension";
import { serviceExtensions } from "./extension/service-extensions";
import type {
  ServiceCapabilityName,
  ServiceCapabilities,
  ServiceContributionName,
  ServiceContributions,
  ServiceDefinition,
} from "./service";

export type ServiceWithCapability<
  T extends ServiceDefinition,
  K extends ServiceCapabilityName,
> = T & {
  capabilities: T["capabilities"] & Required<Pick<ServiceCapabilities, K>>;
};

export type ServiceWithContribution<
  T extends ServiceDefinition,
  K extends ServiceContributionName,
> = T & {
  contributions: ServiceContributions & Required<Pick<ServiceContributions, K>>;
};

/** 只负责 Service 身份和通用 capability 查询；具体 capability 语义由其消费方拥有。 */
export class ServiceCatalog<T extends ServiceDefinition = ServiceDefinition> {
  private readonly identities = new Map<string, T>();

  constructor(readonly services: readonly T[]) {
    const names = services.map((service) => service.name);
    if (new Set(names).size !== names.length) throw new Error("Service Catalog 包含重复名称");
    for (const service of services) this.identities.set(service.name, service);
    for (const service of services) {
      if (service.aliases !== undefined && !Array.isArray(service.aliases)) {
        throw new Error(`Service '${service.name}'.aliases must be an array`);
      }
      for (const alias of service.aliases ?? []) {
        if (typeof alias !== "string" || !alias || /[\s,]/.test(alias)) {
          throw new Error(`Service '${service.name}'.aliases must contain non-empty names without whitespace or commas`);
        }
        const owner = this.identities.get(alias);
        if (owner) throw new Error(`Service alias '${alias}' for '${service.name}' conflicts with '${owner.name}'`);
        this.identities.set(alias, service);
      }
      if (service.extensions !== undefined && !Array.isArray(service.extensions)) throw new Error(`${service.name}.extensions must be an array`);
      const extensionIds = new Set<string>();
      for (const extension of serviceExtensions(service)) {
        validateExtension(extension);
        if (extensionIds.has(extension.id)) throw new Error(`${service.name}: duplicate Extension id '${extension.id}'`);
        extensionIds.add(extension.id);
      }
      const workloads = service.workloads.map((workload) => workload.name);
      for (const source of service.capabilities.dataSources ?? []) {
        if ((source.kind === "s3" || source.kind === "redis") && !!source.source === !!source.environment) {
          throw new Error(`${service.name}/${source.id}: source 与 environment 配置映射必须且只能声明一个`);
        }
        if (source.kind === "vdb" && source.source && (source.inspectTarget || source.configuration)) {
          throw new Error(`${service.name}/${source.id}: source 不能同时声明其它配置解析入口`);
        }
      }
      if (new Set(workloads).size !== workloads.length) {
        throw new Error(`Service '${service.name}' 包含重复 Workload 名称`);
      }
    }
  }

  /** Open discovery; the consumer owns domain validation and multi-provider selection. */
  extensions(kind: string): { service: T; extension: RegisteredExtension }[] {
    return this.services.flatMap(service => serviceExtensions(service)
      .filter(extension => extension.kind === kind)
      .map(extension => ({ service, extension })));
  }

  find(name: string): T | undefined {
    return this.identities.get(name);
  }

  /** Resolve input synonyms and deduplicate by canonical identity before scheduling or recording evidence. */
  resolveNames(names: readonly string[]): string[] {
    return [...new Set(names.map(name => {
      const service = this.find(name);
      if (!service) throw new Error(`Unknown Service '${name}'`);
      return service.name;
    }))];
  }

  findWith<K extends ServiceCapabilityName>(
    name: string,
    capability: K,
  ): ServiceWithCapability<T, K> | undefined {
    const service = this.find(name);
    return service?.capabilities[capability] !== undefined
      ? service as ServiceWithCapability<T, K>
      : undefined;
  }

  servicesWith<K extends ServiceCapabilityName>(
    capability: K,
  ): ServiceWithCapability<T, K>[] {
    return this.services.filter(
      (service): service is ServiceWithCapability<T, K> =>
        service.capabilities[capability] !== undefined,
    );
  }

  findWithContribution<K extends ServiceContributionName>(
    name: string,
    contribution: K,
  ): ServiceWithContribution<T, K> | undefined {
    const service = this.find(name);
    return service?.contributions?.[contribution] !== undefined
      ? service as ServiceWithContribution<T, K>
      : undefined;
  }

  servicesWithContribution<K extends ServiceContributionName>(
    contribution: K,
  ): ServiceWithContribution<T, K>[] {
    return this.services.filter(
      (service): service is ServiceWithContribution<T, K> =>
        service.contributions?.[contribution] !== undefined,
    );
  }
}

/**
 * @spec 构造保留 Service 原始类型的 Catalog，标准名和 aliases 共享无歧义的命名空间
 * @case id=unique_service_names,desc=`注册重名 Service`,input=`两个相同 name 的 Service`,expect=`构造失败`,forbid=`静默覆盖已有 Service`
 * @see {@link packages/plugin/tests/service.test.ts}
 * @rule Service name 是 Plugin 内稳定身份，不能用数组顺序消解冲突
 */
export function createServiceCatalog<const T extends readonly ServiceDefinition[]>(
  services: T,
): ServiceCatalog<T[number]> {
  return new ServiceCatalog(services);
}
