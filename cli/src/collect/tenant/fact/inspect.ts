import type {
  TenantContributionSnapshot,
  TenantReportCell,
} from "@compforge/doctor-plugin";
import type { Inspect } from "../../inspection";
import type {
  TenantCommandContext,
  TenantContributionCollector,
  TenantFacts,
} from "../model";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cell(value: unknown, label: string): TenantReportCell {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  throw new Error(`${label} must be a string, finite number, boolean, or null`);
}

/** Validate the runtime Plugin boundary and retain only the safe tenant report IR. */
function normalizeSnapshot(value: unknown, contributionId: string): TenantContributionSnapshot {
  const label = `tenant contribution '${contributionId}'`;
  const snapshot = record(value, label);
  const summary = snapshot.summary === undefined ? [] : (() => {
    if (!Array.isArray(snapshot.summary)) throw new Error(`${label}.summary must be an array`);
    return snapshot.summary.map((value, index) => {
      const item = record(value, `${label}.summary[${index}]`);
      if (typeof item.label !== "string" || !item.label.trim()) {
        throw new Error(`${label}.summary[${index}].label must be a non-empty string`);
      }
      return {
        label: item.label,
        value: cell(item.value, `${label}.summary[${index}].value`),
      };
    });
  })();
  const tables = snapshot.tables === undefined ? [] : (() => {
    if (!Array.isArray(snapshot.tables)) throw new Error(`${label}.tables must be an array`);
    return snapshot.tables.map((value, tableIndex) => {
      const tableLabel = `${label}.tables[${tableIndex}]`;
      const table = record(value, tableLabel);
      if (typeof table.title !== "string" || !table.title.trim()) {
        throw new Error(`${tableLabel}.title must be a non-empty string`);
      }
      if (!Array.isArray(table.columns) || table.columns.length === 0) {
        throw new Error(`${tableLabel}.columns must be a non-empty array`);
      }
      const columns = table.columns.map((column, index) => {
        if (typeof column !== "string" || !column.trim()) {
          throw new Error(`${tableLabel}.columns[${index}] must be a non-empty string`);
        }
        return column;
      });
      if (!Array.isArray(table.rows)) throw new Error(`${tableLabel}.rows must be an array`);
      const rows = table.rows.map((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== columns.length) {
          throw new Error(`${tableLabel}.rows[${rowIndex}] must have ${columns.length} cells`);
        }
        return row.map((value, columnIndex) => (
          cell(value, `${tableLabel}.rows[${rowIndex}][${columnIndex}]`)
        ));
      });
      let search;
      if (table.search !== undefined) {
        const rawSearch = record(table.search, `${tableLabel}.search`);
        if (
          !Number.isInteger(rawSearch.column)
          || Number(rawSearch.column) < 0
          || Number(rawSearch.column) >= columns.length
        ) {
          throw new Error(`${tableLabel}.search.column must reference a table column`);
        }
        if (rawSearch.placeholder !== undefined && typeof rawSearch.placeholder !== "string") {
          throw new Error(`${tableLabel}.search.placeholder must be a string`);
        }
        search = {
          column: Number(rawSearch.column),
          placeholder: rawSearch.placeholder as string | undefined,
        };
      }
      return { title: table.title, columns, rows, search };
    });
  })();
  const missingEvidence = snapshot.missingEvidence === undefined ? [] : (() => {
    if (!Array.isArray(snapshot.missingEvidence)) {
      throw new Error(`${label}.missingEvidence must be an array`);
    }
    return snapshot.missingEvidence.map((reason, index) => {
      if (typeof reason !== "string" || !reason.trim()) {
        throw new Error(`${label}.missingEvidence[${index}] must be a non-empty string`);
      }
      return reason;
    });
  })();
  return { summary, tables, missingEvidence };
}

function makeTenantIdentityInspect(): Inspect<TenantFacts, TenantCommandContext> {
  return {
    id: "tenant-identity",
    run: async (ctx) => ({
      tenant: {
        status: "collected",
        id: ctx.config.tenant.id,
        name: ctx.config.tenant.name,
        displayName: ctx.config.tenant.displayName,
      },
    }),
  };
}

function makeTenantContributionsInspect(
  contributions: readonly TenantContributionCollector[],
): Inspect<TenantFacts, TenantCommandContext> {
  return {
    id: "tenant-contributions",
    run: async (ctx) => {
      const facts: Record<string, TenantFacts["contributions"][string]> = {};
      for (const contribution of contributions) {
        const started = Date.now();
        try {
          const snapshot = normalizeSnapshot(
            await contribution.collect(ctx.config.tenant.id),
            contribution.id,
          );
          const fact = {
            status: "collected" as const,
            id: contribution.id,
            title: contribution.title,
            service: contribution.service,
            ...snapshot,
          };
          facts[contribution.id] = fact;
          ctx.bundle.addStep({
            id: `tenant-${contribution.id}`,
            title: contribution.title,
            risk: "observe",
            status: "ok",
            durationMs: Date.now() - started,
            output: JSON.stringify(fact, null, 2),
            ext: "json",
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          facts[contribution.id] = {
            status: "failed",
            id: contribution.id,
            title: contribution.title,
            service: contribution.service,
            reason,
          };
          ctx.bundle.addStep({
            id: `tenant-${contribution.id}`,
            title: contribution.title,
            risk: "observe",
            status: "failed",
            reason,
            durationMs: Date.now() - started,
          });
        }
      }
      return { contributions: facts };
    },
  };
}

/**
 * @spec Tenant Core 只编排通用 contribution；新增租户领域不修改 Core Inspect
 * @see {@link ../../../../docs/commands/tenant.md}
 */
export function makeTenantInspects(
  contributions: readonly TenantContributionCollector[],
): Inspect<TenantFacts, TenantCommandContext>[] {
  return [
    makeTenantIdentityInspect(),
    makeTenantContributionsInspect(contributions),
  ];
}
