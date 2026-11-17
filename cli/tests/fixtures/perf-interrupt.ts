import { SSEOperation } from "@compforge/harness-common";
import { createServiceCatalog } from "@compforge/doctor-plugin";
import { runCommand } from "../../src/app/command";
import { perfCommand } from "../../src/perf/command";

const operation = new SSEOperation({ name: "chat", serviceName: "fixture", method: "POST", path: "/chat" });
const plugin = { id: "fixture", version: "1", services: createServiceCatalog([{
  name: "fixture", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture/perf" } },
  workloads: [], operations: [operation], cases: [{ id: "fixture.cases", operation: operation.id(),
    load: () => [{ caseset: "fixture", cases: [{ id: "natural", input: {} }] }],
  }],
}]) };
await runCommand(perfCommand, { config: process.argv[2], output: process.argv[3], format: "bundle", yes: true },
  { qps: "0", hold: "60", caseset: "fixture", cases: "natural" }, { plugin, printProfile: false });
