import { createServiceCatalog } from "@compforge/doctor-plugin";
import { startDoctor } from "doctor-cli/embed";

// Simulate a real terminal: redirecting stdin alone must not be what prevents questions.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
startDoctor({
  name: "samplectl", optionDefaults: { config: "", yes: true },
  commandDefaults: { inspect: { format: "manifest" }, db: { format: "manifest" } },
  plugin: { id: "sample", version: "1.0.0", services: createServiceCatalog([]) },
});
