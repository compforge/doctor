import { expect, test } from "bun:test";
import { validateCollectWindow, type CollectWindowFact } from "../src";

const identity = { kind: "run_id", value: "run-a" };
const from = "2026-11-04T09:00:00Z", to = "2026-11-04T09:01:00Z";

test("CollectWindow accepts single bounds and per-business padding through the public SDK", () => {
  const fact: CollectWindowFact = { factType: "record", kind: "collect.window", schemaVersion: 1,
    recordKey: "run-a", record: { identity, from, to, timePadding: "30s" } };
  expect(validateCollectWindow(fact.record)).toEqual(fact.record);
  expect(validateCollectWindow({ identity, from })).toEqual({ identity, from });
  expect(validateCollectWindow({ identity, to })).toEqual({ identity, to });
});

test("invalid window payloads fail explicitly without accepting ambiguous timestamps", () => {
  for (const value of [null, [], {}, { identity }, { identity: { kind: "run_id", value: "" }, from },
    { identity, from: "2026-11-04" }, { identity, from: "yesterday" }, { identity, from: to, to: from },
    { identity, from, to: null }, { identity, from, timePadding: "bad" }, { identity, from, timePadding: "0s" },
    { identity, from, timePadding: -1 },
    { identity, from: "2026-11-04T09:00:00.000000002Z", to: "2026-11-04T09:00:00.000000001Z" },
  ]) expect(() => validateCollectWindow(value)).toThrow("collect.window");
});
