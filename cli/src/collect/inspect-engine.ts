import type { Inspect } from "./inspection";

function validateInspects<Facts extends object, Ctx>(
  inspects: readonly Inspect<Facts, Ctx>[],
): void {
  const ids = new Set<string>();
  for (const inspect of inspects) {
    if (ids.has(inspect.id)) throw new Error(`duplicate inspect id: ${inspect.id}`);
    ids.add(inspect.id);
  }

  for (const inspect of inspects) {
    const dependencies = new Set<string>();
    for (const dependencyId of inspect.dependsOn ?? []) {
      if (dependencies.has(dependencyId)) {
        throw new Error(`inspect ${inspect.id} declares duplicate dependency: ${dependencyId}`);
      }
      dependencies.add(dependencyId);
      if (!ids.has(dependencyId)) {
        throw new Error(`inspect ${inspect.id} depends on unknown inspect: ${dependencyId}`);
      }
    }
  }
}

function freezeFactValue(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return;
  for (const child of Object.values(value)) freezeFactValue(child);
  Object.freeze(value);
}

export function freezeFacts<Facts extends object>(facts: Facts): Readonly<Facts> {
  freezeFactValue(facts);
  return facts;
}

/**
 * 按依赖顺序执行 collect 起点的只读 Inspect，并合并为一份初始 Facts 快照。
 *
 * 一个 fact key 只能由一个 Inspect 负责；拒绝覆盖可避免后执行的算子悄悄改写已经用于
 * 策略选择的现场现实。每批已产出的 JSON-like 值会被冻结，再交给依赖它的 Inspect。
 */
export async function runInspects<Facts extends object, Ctx = void>(
  inspects: readonly Inspect<Facts, Ctx>[],
  ctx: Ctx,
  log: (line: string) => void = () => {},
): Promise<Readonly<Facts>> {
  validateInspects(inspects);
  const pending = new Set(inspects.map((inspect) => inspect.id));
  const completed = new Set<string>();
  const facts: Partial<Facts> = {};

  while (pending.size > 0) {
    const inspect = inspects.find((candidate) => (
      pending.has(candidate.id)
      && (candidate.dependsOn ?? []).every((id) => completed.has(id))
    ));
    if (!inspect) throw new Error(`inspect dependency cycle: ${[...pending].join(", ")}`);

    log(`[collect] 执行 Inspect：${inspect.id}…`);
    const produced = await inspect.run(ctx, Object.freeze({ ...facts }));
    const keys = Object.keys(produced) as (keyof Facts)[];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(facts, key)) {
        throw new Error(`inspect ${inspect.id} produced duplicate fact: ${String(key)}`);
      }
      const value = produced[key];
      freezeFactValue(value);
      facts[key] = value;
    }
    log(`[collect] Inspect 完成：${inspect.id}（${keys.length} 个 Fact）`);
    pending.delete(inspect.id);
    completed.add(inspect.id);
  }

  return freezeFacts(facts as Facts);
}
