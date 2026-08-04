import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectPackageBundle } from "../src/infra/target/package-install/archive";

const [bundleVersion, outputArg, ...inputArgs] = process.argv.slice(2);
if (!bundleVersion || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(bundleVersion)) {
  throw new Error("usage: build-package-set.ts <version> <output.tar> <variant.tar>...");
}
if (!outputArg || inputArgs.length === 0) {
  throw new Error("package set output and at least one variant are required");
}

const output = resolve(outputArg);
const temporaryRoot = mkdtempSync(join(tmpdir(), "doctor-package-set-build-"));
const setRoot = join(temporaryRoot, "doctor-package-set");
const variantsRoot = join(setRoot, "variants");

function variantId(path: string, index: number): string {
  const manifest = inspectPackageBundle(path).manifest;
  const packages = manifest.packages.join("-");
  const versions = manifest.packages
    .map((name) => manifest.packageVersions?.[name] ?? "unknown")
    .join("-");
  return [
    manifest.osId,
    manifest.osVersionId,
    manifest.architecture,
    packages,
    versions,
    index + 1,
  ].join("-").replace(/[^0-9A-Za-z._+-]/g, "_");
}

try {
  mkdirSync(variantsRoot, { recursive: true });
  const variants = inputArgs.map((inputArg, index) => {
    const input = resolve(inputArg);
    const bundle = inspectPackageBundle(input);
    const id = variantId(input, index);
    const entryPath = `doctor-package-set/variants/${id}.tar`;
    copyFileSync(input, join(variantsRoot, `${id}.tar`));
    return {
      id,
      path: entryPath,
      sha256: createHash("sha256").update(readFileSync(input)).digest("hex"),
      manifest: bundle.manifest,
    };
  });
  writeFileSync(join(setRoot, "manifest.json"), `${JSON.stringify({
    schema: "doctor-package-set/v1",
    bundleVersion,
    variants,
  }, null, 2)}\n`);
  mkdirSync(dirname(output), { recursive: true });
  const archived = Bun.spawnSync({
    cmd: ["tar", "--format", "ustar", "-cf", output, "doctor-package-set"],
    cwd: temporaryRoot,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (archived.exitCode !== 0) {
    throw new Error(`unable to build package set: tar exited ${archived.exitCode}`);
  }
  console.log(`package set built: ${output}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
