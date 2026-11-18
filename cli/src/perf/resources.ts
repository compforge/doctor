import { serviceId, type Service, type Workload } from "@compforge/harness-common";
import type { PrometheusProbe, WindowQuery } from "@compforge/perf-harness";

const quote = JSON.stringify;
const podLabels = "namespace,pod";
const containerLabels = "namespace,pod,container";

function kubeLabel(name: string): string {
  return "label_" + name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Resolve membership at each sample timestamp, so scaling and replacement Pods follow the workload. */
function containers(workload: Workload, namespace: string): string {
  const scope = `namespace=${quote(namespace)}`;
  const location = workload.location;
  const all = `kube_pod_container_info{${scope}${workload.container ? ",container=" + quote(workload.container) : ""}}`;
  let pods: string;
  switch (location.kind) {
    case "service": {
      const slices = `kube_endpointslice_labels{${scope},label_kubernetes_io_service_name=${quote(location.name)}}`;
      const endpoints = `kube_endpointslice_endpoints{${scope},targetref_kind="Pod",targetref_name!=""} and on(namespace,endpointslice) ${slices}`;
      pods = `label_replace((${endpoints}),"pod","$1","targetref_name","(.+)")`;
      break;
    }
    case "labels": {
      const match = Object.entries(location.labels).map(([k, v]) => `${kubeLabel(k)}=${quote(v)}`);
      if (!match.length) throw new Error("Resource observation requires a nonempty Pod selector");
      pods = `kube_pod_labels{${scope},${match.join(",")}}`;
      break;
    }
    case "resource": {
      const kind = location.resource_kind;
      if (kind === "Pod") {
        pods = `kube_pod_info{${scope},pod=${quote(location.name)}}`;
      } else if (kind === "Deployment") {
        const replicas = `kube_replicaset_owner{${scope},owner_kind="Deployment",owner_name=${quote(location.name)},owner_is_controller="true"}`;
        pods = `label_replace(kube_pod_owner{${scope},owner_kind="ReplicaSet",owner_is_controller="true"},"replicaset","$1","owner_name","(.+)") and on(namespace,replicaset) ${replicas}`;
      } else {
        pods = `kube_pod_owner{${scope},owner_kind=${quote(kind)},owner_name=${quote(location.name)},owner_is_controller="true"}`;
      }
    }
  }
  return `group by (${containerLabels}) (${all} and on(${podLabels}) (${pods}))`;
}

export function serviceResourceProbes(
  services: readonly Pick<Service, "name" | "workloads">[],
  namespace?: string,
): PrometheusProbe[] {
  const probes: PrometheusProbe[] = [];
  for (const service of services) {
    const members: string[] = [];
    const namespaces = new Set<string>();
    for (const workload of service.workloads) {
      const ns = workload.namespace || namespace;
      if (!ns) throw new Error(`Missing namespace for ${service.name}/${workload.name}`);
      members.push(containers(workload, ns));
      namespaces.add(ns);
    }
    if (!members.length) continue;
    // Union by physical container before summing; overlapping workload declarations cannot double count it.
    const membership = `(${[...new Set(members)].join(" or ")})`;
    const nsSelector =
      namespaces.size === 1
        ? "namespace=" + quote([...namespaces][0])
        : "namespace=~" +
          quote(
            [...namespaces]
              .sort()
              .map((ns) => ns.replaceAll(".", "\\."))
              .join("|"),
          );
    const summaries: WindowQuery[] = [];
    const target = serviceId(service.name);
    for (const resource of ["cpu", "mem"] as const) {
      for (const measure of ["usage", "request", "limit"] as const) {
        const cpu = resource === "cpu";
        const ksm = `kube_pod_container_resource_${measure}s{${nsSelector},resource="${cpu ? "cpu" : "memory"}",unit="${cpu ? "core" : "byte"}"}`;
        const usage = cpu
          ? `rate(container_cpu_usage_seconds_total{${nsSelector},container!="",container!="POD",cpu=~"total|"}[2m])`
          : `container_memory_working_set_bytes{${nsSelector},container!="",container!="POD"}`;
        const values = `max by (${containerLabels}) (${measure === "usage" ? usage : ksm})`;
        // A missing request/limit or sample on any member leaves the Service total unknown.
        const total = `sum(${values} and on(${containerLabels}) ${membership}) unless (count(${membership} unless on(${containerLabels}) ${values}) > 0)`;
        summaries.push({
          name: `${target}.${resource}_${measure}`,
          promql: cpu ? total : `(${total}) / 1048576`,
          unit: cpu ? "cores" : "MiB",
          category: `resource:${resource}`,
        });
      }
    }
    probes.push({ scope: "service", target, service: service.name, summaries, metrics: {} });
  }
  return probes;
}
