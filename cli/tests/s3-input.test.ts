import { expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import * as parameters from "../src/terminal/parameters";
import { withInteractionOptions } from "../src/terminal/policy";
import { promptS3Request, validateS3Input } from "../src/collect/s3/input";
import { withS3Options } from "../src/collect/s3/options";

test("bare S3 reaches command input resolution without Commander requiring an operation", async () => {
  let called = false;
  const command = withS3Options(new Command("s3")).action(action => {
    called = true;
    expect(action).toBeUndefined();
  });
  await command.parseAsync(["node", "s3"]);
  expect(called).toBe(true);
});

test("interactive bucket listing asks only for the missing operation", async () => {
  const prompt = spyOn(parameters, "canPrompt").mockReturnValue(true);
  const choose = spyOn(parameters, "chooseParameter").mockResolvedValue("列出 bucket（ls）");
  const input = spyOn(parameters, "inputParameter").mockRejectedValue(new Error("unexpected path prompt"));
  try {
    expect(await promptS3Request({})).toMatchObject({ action: "ls", bucket: undefined });
    expect(choose).toHaveBeenCalledTimes(1);
    expect(input).not.toHaveBeenCalled();
  } finally { prompt.mockRestore(); choose.mockRestore(); input.mockRestore(); }
});

test("interactive directory browsing retains literal keys and explicit Service", async () => {
  const prompt = spyOn(parameters, "canPrompt").mockReturnValue(true);
  const choose = spyOn(parameters, "chooseParameter").mockResolvedValue("浏览 bucket / 目录（ls）");
  const input = spyOn(parameters, "inputParameter").mockResolvedValue("bucket/a//../%20 +?#/文件 ");
  try {
    expect(await promptS3Request({ service: "app" })).toMatchObject({
      action: "ls", service: "app", bucket: "bucket", key: "a//../%20 +?#/文件 ",
    });
  } finally { prompt.mockRestore(); choose.mockRestore(); input.mockRestore(); }
});

test("explicit operations prompt only for absent paths; complete input never prompts", async () => {
  const prompt = spyOn(parameters, "canPrompt").mockReturnValue(true);
  const choose = spyOn(parameters, "chooseParameter").mockRejectedValue(new Error("unexpected operation prompt"));
  const input = spyOn(parameters, "inputParameter").mockResolvedValue("app/bucket/file");
  try {
    for (const action of ["stat", "cat"] as const) {
      expect(await promptS3Request({ action })).toMatchObject({ action, service: "app", bucket: "bucket", key: "file" });
    }
    input.mockClear();
    await promptS3Request({ action: "cat", path: "app/bucket/file" });
    expect(choose).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  } finally { prompt.mockRestore(); choose.mockRestore(); input.mockRestore(); }
});

test("invalid supplied inputs fail before prompting, and cancellation propagates", async () => {
  const prompt = spyOn(parameters, "canPrompt").mockReturnValue(true);
  const choose = spyOn(parameters, "chooseParameter").mockRejectedValue(new parameters.ParameterCancelled());
  try {
    expect(() => validateS3Input({ action: "cat", path: "app/bucket" })).toThrow("key");
    expect(() => validateS3Input({ timeout: "0" })).toThrow("--timeout");
    expect(choose).not.toHaveBeenCalled();
    await expect(promptS3Request({})).rejects.toBeInstanceOf(parameters.ParameterCancelled);
  } finally { prompt.mockRestore(); choose.mockRestore(); }
});

test("yes and noninteractive invocations reject missing arguments instead of prompting", async () => {
  const choose = spyOn(parameters, "chooseParameter").mockRejectedValue(new Error("unexpected operation prompt"));
  const input = spyOn(parameters, "inputParameter").mockRejectedValue(new Error("unexpected path prompt"));
  try {
    await expect(withInteractionOptions({ yes: true }, () => promptS3Request({}))).rejects.toThrow("缺少 S3 操作");
    await expect(promptS3Request({ action: "cat", interactive: false })).rejects.toThrow("需要 bucket/key");
    expect(choose).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
  } finally { choose.mockRestore(); input.mockRestore(); }
});
