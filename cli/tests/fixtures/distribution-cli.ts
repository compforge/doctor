import { createServiceCatalog } from "@compforge/doctor-plugin";
import { startDoctor, type Distribution } from "doctor-cli/embed";

const distribution = {
  name: "samplectl",
  version: "2.3.4",
  description: "Sample service diagnostics powered by Doctor",
  commands: "inspect,data,plugin",
  plugin: { id: "sample", version: "1.0.0", services: createServiceCatalog([]) },
} satisfies Distribution;

startDoctor(distribution);
