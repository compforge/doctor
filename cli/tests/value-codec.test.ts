import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServiceCatalog, defineObservation, defineWorkloadProbeExtension, type JsonObject, type Summary, type Value, type ValueCodec } from "@compforge/doctor-plugin";
import { encodeObservationValue, restoreObservationValue, type StoredValueObservation } from "../src/plugin/value";
import { workloadProbeProviders } from "../src/plugin/workload-extensions";

class Settings implements Value {
  constructor(readonly entries: Record<string, { enabled: boolean; ports: number[] }>) {}
  summary(): Summary { return { title: "Settings", text: `${Object.keys(this.entries).length} entries`, fields: [{ label: "Entries", path: ["entries"] }] }; }
}
const codec: ValueCodec<Settings> = {
  encode: value => ({ entries: value.entries }),
  decode: json => {
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Settings must be an object");
    const entries = (json as Record<string, unknown>).entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("entries must be an object");
    for (const entry of Object.values(entries)) {
      if (!entry || typeof entry !== "object" || typeof entry.enabled !== "boolean"
        || !Array.isArray(entry.ports) || !entry.ports.every((port: unknown) => typeof port === "number" && Number.isFinite(port))) {
        throw new Error("invalid Settings entry");
      }
    }
    return new Settings(entries as Settings["entries"]);
  },
};
const definition = defineObservation({ kind: "settings", schemaVersion: 1, codec });
const probe = defineWorkloadProbeExtension({ id: "settings", kind: "workload.probe", workload: "main", access: {}, produces: definition,
  run: async () => new Settings({ "custom.key": { enabled: true, ports: [443, 9200] } }),
});
const catalog = createServiceCatalog([{ name: "app", component: { name: "app", repository: { forge: { name: "github" }, path: "test/app" } },
  workloads: [{ name: "main", platform: "kubernetes", location: { kind: "service", name: "app" } }], extensions: [probe],
}]);

/** @case A Probe Value survives JSON persistence with nested maps, booleans, arrays, and producer methods restored. */
test("Value codec preserves data and summary across a persisted Observation", async () => {
  expect(workloadProbeProviders(catalog)).toHaveLength(1);
  const result = await probe.run({} as never, {} as never);
  expect(result.data).toBeInstanceOf(Settings);
  expect(result.summary).toEqual(result.data.summary());
  const snapshot = encodeObservationValue(definition, result.data, "settings");
  expect(Object.isFrozen(snapshot.value)).toBe(true);
  const observation: StoredValueObservation = { service: "app", probe: "settings", observationKind: "settings", observationSchemaVersion: 1, ...snapshot };
  const directory = mkdtempSync(join(tmpdir(), "doctor-value-codec-"));
  try {
    writeFileSync(join(directory, "observation.json"), JSON.stringify(observation));
    const saved = JSON.parse(readFileSync(join(directory, "observation.json"), "utf8"));
    const restored = restoreObservationValue(saved, definition);
    expect(restored.status).toBe("decoded");
    if (restored.status !== "decoded") throw new Error(restored.reason);
    expect(restored.value).toBeInstanceOf(Settings);
    expect(restored.summary).toEqual(result.summary);
    expect(codec.encode(restored.value as Settings)).toEqual(snapshot.value);
    expect(restoreObservationValue(saved)).toMatchObject({ status: "unavailable", summary: snapshot.summary });
    expect(saved.value).toEqual(snapshot.value);
    expect(restoreObservationValue({ ...saved, observationSchemaVersion: 2 }, definition)).toMatchObject({ status: "unavailable" });
    // Restoration requires the data contract, not a current Service/Probe registration.
    expect(restoreObservationValue({ ...saved, service: "retired" }, definition).status).toBe("decoded");
    const changed = { ...definition, codec: { ...codec, decode: (json: unknown) => {
      const value = codec.decode(json);
      value.summary = () => { throw new Error("history must not recompute summary"); };
      return value;
    } } };
    expect(restoreObservationValue(saved, changed)).toMatchObject({ status: "decoded", summary: saved.summary });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Codec rejects invalid producer data and Core rejects lossy encoded JSON", () => {
  expect(() => encodeObservationValue(definition, new Settings({ bad: { enabled: "yes" as never, ports: [] } }), "settings")).toThrow("invalid Settings entry");
  const lossy = defineObservation({ kind: "settings", schemaVersion: 1, codec: { ...codec,
    encode: () => ({ items: [undefined] }) as unknown as JsonObject,
  } });
  expect(() => encodeObservationValue(lossy, new Settings({}), "settings")).toThrow("unsupported JSON value");
  const invalid = restoreObservationValue({ service: "app", probe: "settings", observationKind: "settings", observationSchemaVersion: 1,
    value: { entries: { bad: { enabled: "secret", ports: [] } } }, summary: { title: "Saved", fields: [] } }, definition);
  expect(invalid).toMatchObject({ status: "unavailable", summary: { title: "Saved" } });
  expect(JSON.stringify(invalid)).not.toContain("secret");
});

test("Codec method contract is checked before scheduling", () => {
  const invalid = createServiceCatalog([{ ...catalog.services[0]!, extensions: [{ ...probe,
    produces: { ...definition, codec: { encode: codec.encode } },
  }] }]);
  expect(() => workloadProbeProviders(invalid)).toThrow("invalid Observation definition");
});

test("Observation persistence accepts root arrays, with saved summary paths into the encoding", () => {
  class Rows { constructor(readonly rows: readonly { count: number }[]) {}
    summary(): Summary { return { title: "Rows", fields: [{ label: "First", path: ["0", "count"] }] }; }
  }
  const definition = defineObservation({ kind: "rows", schemaVersion: 1, codec: {
    encode: (value: Rows) => value.rows,
    decode: (json: unknown) => {
      if (!Array.isArray(json) || json.some(row => typeof row?.count !== "number")) throw new Error("invalid rows");
      return new Rows(json);
    },
  } });
  expect(encodeObservationValue(definition, new Rows([{ count: 3 }]), "rows")).toEqual({
    value: [{ count: 3 }], summary: { title: "Rows", fields: [{ label: "First", path: ["0", "count"] }] },
  });
});
