import { expect, test } from "bun:test";
import { CommandArtifacts } from "../src/command/artifacts";

test("add registers once by normalized path and preserves references across invocation scopes", async () => {
  const artifacts = new CommandArtifacts();
  const child = await artifacts.capture(async () => {
    const first = artifacts.add({ command: "inspect", path: "/tmp/evidence/../inspect" });
    expect(artifacts.add({ command: "inspect", path: "/tmp/inspect" })).toBe(first);
    expect(artifacts.add(first)).toBe(first);
    expect(artifacts.list()).toEqual([first]);
    return first;
  });
  expect(artifacts.list()).toEqual([]);
  artifacts.add(child.artifacts);
  artifacts.add(child.value);
  expect(artifacts.list()).toEqual([child.value]);
});

test("concurrent same-named artifacts retain separate identity and local selection", async () => {
  const artifacts = new CommandArtifacts();
  const children = await Promise.all(["a", "b"].map(parent => artifacts.capture(async () => {
    const artifact = artifacts.add({ command: "data", path: `/tmp/${parent}/same-name` });
    await Promise.resolve();
    expect(artifacts.list()).toEqual([artifact]);
    return artifact;
  })));
  expect(children[0]!.value.id).not.toBe(children[1]!.value.id);
  artifacts.add(children.flatMap(child => child.artifacts));
  expect(artifacts.list()).toHaveLength(2);
});

test("artifact identity conflicts fail without overwriting the registered reference", () => {
  const artifacts = new CommandArtifacts();
  const original = artifacts.add({ command: "data", path: "/tmp/a" });
  expect(() => artifacts.add({ ...original, path: "/tmp/b" })).toThrow("identity conflict");
  expect(() => artifacts.add({ ...original, command: "trace" })).toThrow("identity conflict");
  expect(() => artifacts.add({ ...original, id: "another-id" })).toThrow("identity conflict");
  expect(artifacts.list()).toEqual([original]);
});

test("failed child execution preserves partial artifacts on its parent", async () => {
  const artifacts = new CommandArtifacts();
  await expect(artifacts.capture(async () => {
    artifacts.add({ command: "data", path: "/tmp/partial" });
    throw new Error("failed");
  })).rejects.toThrow("failed");
  expect(artifacts.list()).toMatchObject([{ command: "data", path: "/tmp/partial" }]);
});
