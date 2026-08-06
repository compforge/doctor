import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { createExecutionTools } from "../src/tools";

describe("execution tools", () => {
  test("binds read and bash to the host environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-agent-tools-"));
    writeFileSync(join(directory, "evidence.txt"), "observed");
    const env = new NodeExecutionEnv({ cwd: directory });
    const [read, bash] = createExecutionTools(env);

    const readResult = await read!.execute("read-1", { path: "evidence.txt" });
    const bashResult = await bash!.execute("bash-1", { command: "pwd" });

    expect(readResult.content[0]).toEqual({ type: "text", text: "observed" });
    expect(bashResult.content[0]).toEqual({
      type: "text",
      text: `${realpathSync(directory)}\n`,
    });
    await env.cleanup();
  });
});
