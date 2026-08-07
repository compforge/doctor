import { expect, test } from "bun:test";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";

import { openModelAccess } from "../src/model";

test("model access rejects an inference Service without a port", async () => {
  const plugin = {
    id: "test",
    version: "0.0.1",
    model: {
      tenantDirectoryService: "tenant-directory",
      catalogService: "model-catalog",
      inferenceService: "inference",
    },
    services: createServiceCatalog([{
      name: "tenant-directory",
      port: 8080,
      capabilities: {
        tenantDirectory: {
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        },
      },
    }, {
      name: "model-catalog",
      port: 8081,
      capabilities: {
        modelCatalog: {
          access: {},
          create: () => ({
            listAvailable: async () => [],
            getBackend: async () => undefined,
          }),
        },
      },
    }, {
      name: "inference",
      capabilities: {
        inference: {
          access: {},
          create: async () => {
            throw new Error("inference factory must not run");
          },
        },
      },
    }]),
  } satisfies PluginDefinition;

  await expect(openModelAccess({
    command: "doctor chat",
    plugin,
  })).rejects.toThrow("推理 Service 'inference' 未声明端口");
});
