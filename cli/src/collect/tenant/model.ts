import type { CollectDataCliOpts } from "../data/model";

export interface CollectTenantCliOptions extends Omit<CollectDataCliOpts, "bizIds"> {
  directoryProvider?: string;
  tenantDirectoryService?: string;
  tenantDirectoryPort?: string;
}
