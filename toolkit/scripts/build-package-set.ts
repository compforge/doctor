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
import { basename, dirname, join, resolve } from "node:path";

const [bundleVersion, outputArg, ...variantArgs] = process.argv.slice(2);
if (!bundleVersion || !outputArg || variantArgs.length === 0) {
  throw new Error("usage: build-package-set.ts <version> <output.tar> <id=bundle.tar>...");
}

const root = mkdtempSync(join(tmpdir(), "doctor-package-set-build-"));
try {
  const setRoot = join(root, "doctor-package-set");
  const variantsRoot = join(setRoot, "variants");
  mkdirSync(variantsRoot, { recursive: true });
  const variants = variantArgs.map((argument) => {
    const separator = argument.indexOf("=");
    if (separator <= 0) throw new Error(`invalid package variant: ${argument}`);
    const id = argument.slice(0, separator);
    const source = resolve(argument.slice(separator + 1));
    if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(id)) {
      throw new Error(`invalid package variant id: ${id}`);
    }
    const inspected = Bun.spawnSync({
      cmd: ["tar", "-xOf", source, "doctor-packages/manifest.json"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (inspected.exitCode !== 0) {
      throw new Error(`unable to read package manifest: ${basename(source)}`);
    }
    const target = join(variantsRoot, `${id}.tar`);
    copyFileSync(source, target);
    return {
      id,
      path: `doctor-package-set/variants/${id}.tar`,
      sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      manifest: JSON.parse(inspected.stdout.toString()),
    };
  });
  writeFileSync(join(setRoot, "manifest.json"), `${JSON.stringify({
    schema: "doctor-package-set/v1",
    bundleVersion,
    variants,
  }, null, 2)}\n`);
  const output = resolve(outputArg);
  mkdirSync(dirname(output), { recursive: true });
  const archived = Bun.spawnSync({
    cmd: ["tar", "--format", "ustar", "-cf", output, "doctor-package-set"],
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (archived.exitCode !== 0) throw new Error(`tar exited ${archived.exitCode}`);
  console.log(`package set built: ${output}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
