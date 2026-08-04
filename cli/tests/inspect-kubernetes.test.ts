import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectKubernetes } from "../src/command";

test("启动 Kubernetes Inspect 把不适用于当前 profile 的配置记为 Fact，不阻断离线命令", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-inspect-k8s-"));
  const config = join(directory, "config.yaml");
  writeFileSync(
    config,
    "default_profile: local\nprofiles:\n  local:\n    readonly: true\n",
  );

  const facts = await inspectKubernetes({ profile: "local", config });

  expect(facts.kubeconfig.source).toBe("unresolved");
  expect(facts.channel.available).toBe(false);
  expect(facts.channel.reason).toContain("未配置 kube.kubeconfig_path");
});
