import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import { createDoctorExtensionRegistry } from "../../plugin/extension-registry";
import { DATASOURCE_HEALTH_KIND, type DataSourceHealthExtension, type DataSourceHealthResult } from "./extension";

/** @spec A command reuses one snapshot per prepared client; credentials, endpoints and lifetimes are never globally cached. */
export class DataSourceHealthSession {
  private readonly snapshots = new WeakMap<SearchEngine, Promise<DataSourceHealthResult>>();
  probe(search: SearchEngine, signal?: AbortSignal): Promise<DataSourceHealthResult> {
    let result = this.snapshots.get(search);
    if (!result) {
      const providers = createDoctorExtensionRegistry().extensions(DATASOURCE_HEALTH_KIND, "core");
      const extension = providers.map(provider => provider.extension as DataSourceHealthExtension)
        .find(provider => provider.backend === "opensearch");
      if (!extension) throw new Error("Core 缺少 OpenSearch 健康探测 Extension");
      result = extension.run({ search, signal });
      this.snapshots.set(search, result);
    }
    return result;
  }
}
