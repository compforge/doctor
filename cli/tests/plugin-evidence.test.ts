import { expect, test } from "bun:test";
import type { Fact as PluginFact } from "@compforge/doctor-plugin";
import {
  immutableServiceProbeFacts,
  projectPluginServiceEvidenceFact,
  projectPluginServiceEvidenceObservation,
  projectServiceEvidenceFact,
  projectServiceEvidenceObservation,
} from "../src/plugin/evidence";
import { collectedFact } from "../src/collect/protocol";

test("Core Service Evidence 投影保留持久化 Fact identity，领域只补 scope 与 value", () => {
  const source = collectedFact("inspect.service-targets", "service-targets", {
    services: { api: { ready: true } },
  });

  const projected = projectServiceEvidenceFact({
    factPath: "serviceTargets",
    services: ["api"],
    source,
    value: source,
  });

  expect(projected).toEqual({
    factPath: "serviceTargets",
    services: ["api"],
    kind: source.kind,
    schemaVersion: source.schemaVersion,
    producer: source.producer,
    value: source,
  });
});

test("Plugin Service Evidence 投影统一规范化本地 Fact 与 Observation identity", () => {
  const fact: PluginFact = {
    factType: "value",
    kind: "health",
    schemaVersion: 2,
    value: { ready: true },
  };
  const projectedFact = projectPluginServiceEvidenceFact({
    plugin: "example",
    service: "api",
    producerId: "inspect",
    factPath: "capabilityResults.0.result.facts.0",
    fact,
    query: { kind: "biz_id", value: "biz-1" },
    value: fact,
  });
  const projectedObservation = projectPluginServiceEvidenceObservation({
    id: "plugin-workload-api-main-health-api-0",
    plugin: "example",
    service: "api",
    producerId: "health",
    probe: "health",
    kind: "health",
    schemaVersion: 2,
    workload: "main",
    value: { ready: true },
  });

  expect(projectedFact).toMatchObject({
    kind: "plugin/example/api/health",
    schemaVersion: 2,
    producer: { origin: "plugin", plugin: "example", service: "api", id: "inspect" },
    services: ["api"],
    query: { kind: "biz_id", value: "biz-1" },
  });
  expect(projectedObservation).toMatchObject({
    id: "plugin-workload-api-main-health-api-0",
    kind: "plugin/example/api/health",
    schemaVersion: 2,
    producer: { origin: "plugin", plugin: "example", service: "api", id: "health" },
    services: ["api"],
  });
});

test("Core Observation 投影保留 id、schema identity 与 producer", () => {
  const source = {
    id: "observation-1",
    kind: "environment-config",
    schemaVersion: 3,
    producer: { origin: "core" as const, id: "environment-config" },
  };

  expect(projectServiceEvidenceObservation({
    services: ["api"],
    probe: "environment-config",
    source,
    value: { deployment: "api" },
  })).toEqual({
    id: source.id,
    services: ["api"],
    probe: "environment-config",
    kind: source.kind,
    schemaVersion: source.schemaVersion,
    producer: source.producer,
    value: { deployment: "api" },
  });
});

test("Service Probe Facts 只在跨边界时 JSON 化并深冻结", () => {
  const source = collectedFact("inspect.service-targets", "service-targets", {
    services: { api: { ready: true } },
  });
  const facts = immutableServiceProbeFacts([projectServiceEvidenceFact({
    factPath: "serviceTargets",
    services: ["api"],
    source,
    value: source,
  })]);

  expect(Object.isFrozen(facts)).toBe(true);
  expect(Object.isFrozen(facts[0])).toBe(true);
  expect(Object.isFrozen(facts[0]?.value)).toBe(true);
  expect(Object.isFrozen(source)).toBe(false);
});
