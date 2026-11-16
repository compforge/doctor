import { expect, test } from "bun:test";
import { createServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";
import { serviceHealthDataSources, serviceHealthS3DataSources } from "../src/datasource/health/services";

function service(name: string): ServiceDefinition {
  return { name, component: { name, repository: { forge: { name: "test" }, path: name } }, workloads: [],
    dataSources: [
      { id: "objects", kind: "s3", backend: "s3-compatible", environment: {
        endpoint: "ENDPOINT", bucket: "BUCKET", region: "REGION", accessKey: "AK", secretKey: "SK" } },
      { id: "search", kind: "vdb", backend: "opensearch" },
    ] };
}

for (const [select, dataSource] of [[serviceHealthS3DataSources, "objects"], [serviceHealthDataSources, "search"]] as const) {
  test(`Health selects owned and declared ${dataSource} sources in order, deduplicates references and excludes unrelated sources`, () => {
    const consumer = service("consumer");
    const storage = { ...service("storage"), aliases: ["store"] };
    consumer.dependencies = [
      { id: "self", service: "consumer", dataSource },
      { id: "objects", service: "store", dataSource: "objects" },
      { id: "search", service: "store", dataSource: "search" },
      { id: "duplicate", service: "store", dataSource },
      { id: "missing-source", service: "store", dataSource: "missing" },
      { id: "missing-service", service: "missing", dataSource },
    ];
    const plugin = { id: "test", version: "1", services: createServiceCatalog([consumer, storage, service("unrelated")]) };
    expect(select(plugin, consumer)).toEqual([
      { service: "consumer", dataSource },
      { service: "store", dataSource },
    ]);
  });
}
