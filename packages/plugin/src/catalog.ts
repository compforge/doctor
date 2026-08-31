import type {
  ServiceCapabilityName,
  ServiceCapabilities,
  ServiceDefinition,
} from "./service";

export type ServiceWithCapability<
  T extends ServiceDefinition,
  K extends ServiceCapabilityName,
> = T & {
  capabilities: T["capabilities"] & Required<Pick<ServiceCapabilities, K>>;
};

/** 只负责 Service 身份和通用 capability 查询；具体 capability 语义由其消费方拥有。 */
export class ServiceCatalog<T extends ServiceDefinition = ServiceDefinition> {
  constructor(readonly services: readonly T[]) {
    const names = services.map((service) => service.name);
    if (new Set(names).size !== names.length) throw new Error("Service Catalog 包含重复名称");
    for (const service of services) {
      const workloads = service.workloads.map((workload) => workload.name);
      if (new Set(workloads).size !== workloads.length) {
        throw new Error(`Service '${service.name}' 包含重复 Workload 名称`);
      }
    }
  }

  find(name: string): T | undefined {
    return this.services.find((service) => service.name === name);
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
}

/**
 * @spec 构造保留 Service 原始类型的 Catalog，并拒绝重复的 Service name
 * @case id=unique_service_names,desc=`注册重名 Service`,input=`两个相同 name 的 Service`,expect=`构造失败`,forbid=`静默覆盖已有 Service`
 * @see {@link packages/plugin/tests/service.test.ts}
 * @rule Service name 是 Plugin 内稳定身份，不能用数组顺序消解冲突
 */
export function createServiceCatalog<const T extends readonly ServiceDefinition[]>(
  services: T,
): ServiceCatalog<T[number]> {
  return new ServiceCatalog(services);
}
