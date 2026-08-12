import { readFile, writeFile } from "node:fs/promises";

const versionFile = new URL("../src/app/version.ts", import.meta.url);
const versionPattern = /export const DOCTOR_CLI_VERSION = "(\d+)\.(\d+)\.(\d+)";/;

const versionSource = await readFile(versionFile, "utf8");
const current = versionSource.match(versionPattern);
if (!current) throw new Error("cannot read DOCTOR_CLI_VERSION from src/app/version.ts");

const requested = process.argv[2]?.trim();
const next = requested || `${current[1]}.${current[2]}.${Number(current[3]) + 1}`;
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`invalid version: ${next}`);

await writeFile(versionFile, versionSource.replace(versionPattern, `export const DOCTOR_CLI_VERSION = "${next}";`));
console.log(`${current[1]}.${current[2]}.${current[3]} -> ${next}`);
