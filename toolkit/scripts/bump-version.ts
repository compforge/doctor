import { readFile, writeFile } from "node:fs/promises";

const versionFile = new URL("../VERSION", import.meta.url);
const current = (await readFile(versionFile, "utf8")).trim();
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!match) throw new Error(`cannot read Toolkit version: ${current}`);

const requested = process.argv[2]?.trim();
const next = requested || `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`invalid version: ${next}`);

await writeFile(versionFile, `${next}\n`);
console.log(`${current} -> ${next}`);
