import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandStatus } from "../command/status";
import { SerializeContext } from "../command/serialization/context";
import type { DeliveryPlan } from "./delivery-plan";
import { deliverSerialized } from "./delivery";
import { renderBundleAgents } from "./bundle-agents";

export async function deliverPreparationFailure(command: string, reason: string, plan: DeliveryPlan): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), "doctor-result-"));
  const result = await SerializeContext.create(directory, { name: command }, { status: CommandStatus.Failed, reason, artifacts: [] });
  result.writeText("AGENTS.md", renderBundleAgents());
  result.indexReports();
  await deliverSerialized({ directory, plan, code: 1 });
  return 1;
}
