import { readFile } from "node:fs/promises";
import { CsvError, parse } from "csv-parse/sync";
import type { Case } from "@compforge/spec-case/model";
import type { CaseDataset } from "../case/params";

export async function loadCaseDataset(path: string, cases: readonly Case[]): Promise<CaseDataset> {
  const data = await readFile(path, "utf8");
  let records: string[][];
  try {
    records = parse(data, { bom: true, skip_empty_lines: true });
  } catch (error) {
    if (error instanceof CsvError) throw new Error(`--case-dataset: CSV 第 ${error.lines} 行格式错误 (${error.code})`);
    throw error;
  }
  const headers = records.shift()?.map(header => header.trim());
  if (!headers?.length || !records.length) throw new Error("--case-dataset 需要列名和至少一条数据");
  const names = new Set(cases.flatMap(item => Object.keys(item.params ?? {})));
  const seen = new Set<string>();
  for (const header of headers) {
    if (!header || seen.has(header)) throw new Error("--case-dataset 列名不能为空或重复");
    if (!names.has(header)) throw new Error(`--case-dataset 列 '${header}' 不属于已选 Case 的参数`);
    seen.add(header);
  }
  return records.map(record => Object.fromEntries(headers.map((name, index) => [name, record[index]!])));
}
