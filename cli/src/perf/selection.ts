import type { Case } from "@compforge/spec-case/model";
import { chooseName } from "../terminal/selection";
import { Operation } from "@compforge/harness-common";
import type { CaseSet, Experiment } from "@compforge/perf-harness";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { loadCaseCatalog } from "@compforge/doctor-plugin";
import { caseRef, type CaseChoice } from "../case/choices";
import { chooseServiceCases } from "../terminal/case-selection";
import type { DoctorCaseSet } from "../case/catalog";
import type { PerfCliOpts } from "./model";

export async function selectPerfTarget(plugin: PluginDefinition, opts: PerfCliOpts, inject: boolean) {
  const registry = plugin.services;
  const sources = registry.caseSources();
  const operations = registry.operations();
  let explicitOp = opts.operation ? registry.operation(opts.operation) : undefined;
  // Older observation scripts identify their entry by CaseSet. Resolve an explicit hint
  // without selecting Cases or opening a runner.
  if (!inject && opts.caseset && !explicitOp) {
    const owners = sources.filter(({service, source}) => source.operation
      && (!opts.service || registry.find(opts.service)?.name === service.name)
      && loadCaseCatalog(source).some(set => set.caseset === opts.caseset));
    const ids = [...new Set(owners.map(o => o.source.operation!))];
    if (ids.length !== 1) throw new Error(`CaseSet '${opts.caseset}' 无法唯一确定观测入口，请指定 --operation`);
    explicitOp = registry.operation(ids[0]!);
  }
  const groups: DoctorCaseSet[] = inject ? sources.filter(s => s.source.runner).flatMap(({service, source}) =>
    loadCaseCatalog(source).filter(set => (!opts.caseset || opts.caseset === set.caseset) && set.cases.some(c => source.runner!.supports(c)))
      .map(caseSet => ({service:service.name, source:"plugin", sourceId:source.id, caseSet, supports:item => source.runner!.supports(item)}))) : [];
  const names = [...new Set(inject ? groups.map(g => g.service) : operations.map(o => o.service.name))];
  const owner = opts.service ? registry.find(opts.service)?.name : undefined;
  if (opts.service && (!owner || !names.includes(owner))) throw new Error(`不可选的 Service: ${opts.service}`);
  if (!inject && explicitOp && owner && explicitOp.service.name !== owner) {
    throw new Error(`Operation ${opts.operation} 不属于 Service ${owner}`);
  }
  const preferred = plugin.perf?.defaultService;
  const name = owner ?? (!inject && explicitOp ? explicitOp.service.name : await chooseName(names, "Service", "--service", preferred && names.includes(preferred) ? preferred : undefined));
  if (!name) return;
  const selected = inject ? await chooseServiceCases(groups.filter(g => g.service === name), {
    ...opts, supports:(source, item) => source.supports!(item),
  }) : [];
  if (!selected) return;
  if (inject && !selected.length) throw new Error("加压需要至少一个可执行的 Case");
  const bindings = selected.map(c => registry.caseSource({service:name, source:c.source.sourceId!}).source.operation);
  const defaults = [...new Set(bindings)];
  const localOps = operations.filter(o => o.service.name === name);
  const candidates = defaults.length > 1 && defaults.every(Boolean)
    ? operations.filter(o => defaults.includes(o.operation.id()))
    : localOps.length ? localOps : operations;
  const opId = explicitOp?.operation.id() ?? (defaults.every(Boolean) ? defaults[0] : undefined)
    ?? await chooseName(candidates.map(o => o.operation.id()), "Operation", "--operation");
  if (!opId) return;
  return {service:registry.find(name)!, operation:registry.operation(opId).operation, selected};
}

export function perfCaseMix(selected: CaseChoice[]) {
  const sources = [...new Set(selected.map(c => c.source))];
  // Canonical Harness IDs accept lowercase ASCII, digits and underscores. Encode the qualified
  // identity so reordering the selection never changes attribution between runs.
  const routes = selected.map(choice => {
    const qualified = caseRef(choice).replace(/[^a-z0-9]/g, ch => "_" + ch.charCodeAt(0).toString(16).padStart(2, "0"));
    return {choice, id:sources.length > 1 ? `c_${qualified}` : choice.item.id};
  });
  const caseSet: CaseSet | undefined = sources.length < 2 ? sources[0]?.caseSet : {
    caseset:sources[0]!.service,
    facets:Object.fromEntries(selected.flatMap(c => Object.keys(c.item.facets ?? {}).map(key => [key,{open:true}]))),
    cases:routes.map(({choice:{item}, id}) => ({id, input:item.input, facets:item.facets})),
  };
  return {sources, routes, caseSet, caseMix:routes.map(({id}) => ({id, weight:1})),
    caseRefs:Object.fromEntries(routes.map(({choice,id}) => [id, caseRef(choice)]))};
}

type Adapter = Required<Pick<Experiment, "runner" | "judge">>;

/** Each factory owns one CaseSet. Harness chooses the Case once per arrival and returns its ID to the judge. */
export function routePerfCases(mix: ReturnType<typeof perfCaseMix>, adapters: Map<DoctorCaseSet, Adapter>,
  inputs?: ReadonlyMap<Case, () => Case>): Adapter {
  const routes = new Map(mix.routes.map(({id, choice}) => [id, {item:choice.item, adapter:adapters.get(choice.source)!}]));
  const active: Adapter[] = [];
  return {
    runner:{
      name:mix.sources[0]!.service,
      setup:async ctx => {
        for (const adapter of adapters.values()) {
          active.push(adapter);
          await adapter.runner.setup?.(ctx);
        }
      },
      fire:ctx => {
        const route = routes.get(ctx.case.id)!;
        return route.adapter.runner.fire({...ctx, case:inputs?.get(route.item)?.() ?? route.item});
      },
      operation:ctx => {
        const route = routes.get(ctx.case.id)!;
        return route.adapter.runner.operation?.({...ctx, case:route.item}) ?? new Operation({serviceName:ctx.service.name, name:route.adapter.runner.name});
      },
      deactivate:async ctx => { await Promise.all(active.map(a => a.runner.deactivate?.(ctx))); },
      cleanup:async ctx => {
        const results = await Promise.allSettled(active.splice(0).map(a => a.runner.cleanup?.(ctx)));
        for (const r of results) if (r.status === "rejected") throw r.reason;
      },
    },
    judge:outcome => routes.get(outcome.case_id!)!.adapter.judge(outcome),
  };
}
