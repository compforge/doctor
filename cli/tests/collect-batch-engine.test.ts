import { expect, test } from "bun:test";
import { runCollectBatch } from "../src/collect/engine";
import { collectedFact, type CollectedFact, type Evidence } from "../src/collect/protocol";

type Facts = { records: CollectedFact<{ id: string }, "record">[] };
const evidence = (observations: readonly never[], facts: Facts): Evidence<never, Facts> => ({ observations, facts });

for (const ids of [["a"], ["a", "bad", "b"]]) test(`batch engine freezes once and isolates projections: ${ids}`, async () => {
  const events: string[] = [];
  const result = await runCollectBatch({
    ctx: undefined,
    inspects: [{ id: "source", run: async () => {
      events.push("inspect");
      return { records: ids.map(id => collectedFact("record", "source", { id })) };
    } }],
    checkpointFacts: facts => {
      expect(Object.isFrozen(facts.records)).toBeTrue();
      events.push("checkpoint");
    },
    items: ids.map(id => ({ ctx: undefined, config: id, projectFacts: (facts: Readonly<Facts>) => {
      if (id === "bad") throw new Error("invalid projection");
      return { records: facts.records.filter(record => record.id === id) };
    } })),
    planProbes: (facts, id) => {
      expect(events.slice(0, 2)).toEqual(["inspect", "checkpoint"]);
      expect(Object.isFrozen(facts)).toBeTrue();
      expect(Object.isFrozen(facts.records)).toBeTrue();
      expect(facts.records.map(record => record.id)).toEqual([id]);
      events.push(id);
      return [];
    },
    log: () => {}, buildEvidence: evidence, detectors: [], buildCoverage: () => [],
  });
  expect(events.filter(event => event === "inspect")).toHaveLength(1);
  expect(result.items.map(item => item.status)).toEqual(ids.map(id => id === "bad" ? "rejected" : "fulfilled"));
  expect(result.facts.records.map(record => record.id)).toEqual(ids);
});

test("queued cancellation yields an outcome for every item without starting its probes", async () => {
  const controller = new AbortController();
  const planned: string[] = [];
  const result = await runCollectBatch({
    ctx: undefined, signal: controller.signal, concurrency: 1,
    inspects: [{ id: "source", run: async () => ({ records: [] }) }],
    items: ["a", "b", "c"].map(id => ({ ctx: undefined, config: id })),
    planProbes: (_facts, id) => { planned.push(id); controller.abort(new Error("cancelled")); return []; },
    log: () => {}, buildEvidence: evidence, detectors: [], buildCoverage: () => [],
  });
  expect(planned).toEqual(["a"]);
  expect(result.items.map(item => item.status)).toEqual(["fulfilled", "rejected", "rejected"]);
});
