import { WORKLOAD_PROBE_KIND, requireWorkloadProbeExtension, type ServiceCatalog } from "@compforge/doctor-plugin";
import { validateObservationSchema } from "./observation";

/** Several named probes may share a kind; each retains its own workload, schema and access. */
export function workloadProbeProviders(catalog: ServiceCatalog, serviceName?: string) {
  const canonical = serviceName === undefined ? undefined : catalog.find(serviceName)?.name;
  return catalog.extensions(WORKLOAD_PROBE_KIND)
    .filter(({ service }) => serviceName === undefined || service.name === canonical)
    .map(({ service, extension }) => {
      const probe = requireWorkloadProbeExtension(extension);
      if (!service.workloads.some(workload => workload.name === probe.workload)) {
        throw new Error(`${service.name}/${probe.id}: unknown Workload '${probe.workload}'`);
      }
      validateObservationSchema(probe.produces.schema, `${service.name}/${probe.id}.produces.schema`);
      return { service, extension: probe };
    });
}
