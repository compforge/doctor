import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface FactsIndex {
  files?: Readonly<Record<string, string | { readonly path: string }>>;
}

/** Resolve against the delivered artifact location, never against the original command's cwd. */
export function readFacts<Facts = Record<string, unknown>>(
  root: string, manifest: FactsIndex,
): Facts {
  const entry = manifest.files?.facts;
  const file = typeof entry === "string" ? entry : entry?.path;
  if (file === undefined) return {} as Facts;
  const path = resolve(root, file);
  const inside = (value: string) => value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  if (isAbsolute(file) || !inside(relative(root, path))
    || !inside(relative(realpathSync(root), realpathSync(path)))) {
    throw new Error(`Evidence file is outside its artifact: ${file}`);
  }
  // Missing or corrupt indexed evidence must fail explicitly.
  return JSON.parse(readFileSync(path, "utf8")) as Facts;
}
