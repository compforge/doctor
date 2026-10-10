import { expect, test } from "bun:test";
import { freezeTimeWindow, resolveTimeWindow } from "../src/collect/time-window";
import { resolveLogTimeWindow, validateLogTimeWindow } from "../src/collect/log/config";
import { parseKubernetesEvents, selectLifecycleEvents } from "../src/infra/k8s/workload-events";

const now = new Date("2026-10-10T10:00:00Z");
test("explicit windows freeze once, prioritize absolute start and preserve unset defaults", () => {
  expect(resolveTimeWindow({}, now)).toBeUndefined();
  expect(resolveTimeWindow({ since: "30m" }, now)).toEqual({ from: "2026-10-10T09:30:00.000Z", to: now.toISOString() });
  const input = freezeTimeWindow({ since: "invalid", sinceTime: "2026-10-10T17:00:00+08:00", untilTime: now.toISOString() }, now);
  expect(input).toEqual({ since: undefined, sinceTime: "2026-10-10T17:00:00+08:00", untilTime: now.toISOString() });
  expect(freezeTimeWindow(input, new Date("2030-01-01"))).toEqual(input);
  expect(resolveTimeWindow({ untilTime: now.toISOString() }, now)).toEqual({ to: now.toISOString() });
  expect(resolveTimeWindow({ sinceTime: now.toISOString(), untilTime: now.toISOString() }, now)).toEqual({ from: now.toISOString(), to: now.toISOString() });
});
test("bad windows fail before collection and log keeps its default policy", () => {
  for (const input of [{ sinceTime: "bad" }, { since: "bad" }, { untilTime: "bad" },
    { sinceTime: "2026-10-10T10:00:00.000000002Z", untilTime: "2026-10-10T10:00:00.000000001Z" }]) {
    expect(() => validateLogTimeWindow(input)).toThrow();
  }
  expect(resolveLogTimeWindow({ now })).toEqual({ since: "6h" });
  expect(resolveLogTimeWindow({ id: "019a0000-0000-7000-8000-000000000000", now })).toEqual({ since: "6h" });
});
test("Workload events retain startup Normal and overlapping series with inclusive bounds", () => {
  const events = parseKubernetesEvents(JSON.stringify({ items: [
    { involvedObject: { name: "pod" }, type: "Normal", reason: "Pulling", firstTimestamp: "2026-10-10T08:00:00Z", eventTime: "2026-10-10T08:00:00Z", series: { lastObservedTime: "2026-10-10T11:00:00Z", count: 3 } },
    { involvedObject: { name: "pod" }, type: "Normal", reason: "Pulled", firstTimestamp: "2026-10-10T10:00:00Z", lastTimestamp: "2026-10-10T10:00:00Z" },
    { involvedObject: { name: "pod" }, type: "Warning", reason: "Old", firstTimestamp: "2026-10-10T08:00:00Z", lastTimestamp: "2026-10-10T08:00:00Z" },
    { involvedObject: { name: "other" }, type: "Warning", reason: "Other" },
  ] }), "test");
  const selected = selectLifecycleEvents(events, new Set(["pod"]), 200, { from: "2026-10-10T09:00:00Z", to: "2026-10-10T10:00:00Z" });
  expect(selected.map(event => event.reason)).toEqual(["Pulled", "Pulling"]);
  expect(selected[1]).toMatchObject({ lastAt: "2026-10-10T11:00:00Z", firstAt: "2026-10-10T08:00:00Z", count: 3 });
});

test("historical log end anchors the default lookback without changing no-window defaults", () => {
  expect(resolveLogTimeWindow({ untilTime: "2020-01-01T10:00:00Z" })).toEqual({ sinceTime: "2020-01-01T04:00:00.000Z" });
  expect(resolveLogTimeWindow({ since: "2h", untilTime: "2020-01-01T10:00:00Z" })).toEqual({ sinceTime: "2020-01-01T08:00:00.000Z" });
  expect(resolveLogTimeWindow({ since: "2h" })).toEqual({ since: "2h" });
});
