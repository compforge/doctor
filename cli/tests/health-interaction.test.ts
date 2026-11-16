import { CommandContext } from "../src/command";
import { expect, test } from "bun:test";
import { HealthInteraction } from "../src/health/interaction";
import type { ApprovalRequest } from "../src/command/approval";
import { withInteractionOptions, isInteractive } from "../src/terminal/policy";

const request: ApprovalRequest = { id: "check", risk: "observe", title: "连接检查", target: "fixture", impact: ["只读请求"] };

test("skip continues, quit stops and later approvals cannot execute", async () => {
  const answers = ["n", "y", "q"];
  let prompts = 0;
  const interaction = new HealthInteraction(new CommandContext({}), true, async input => { prompts++; return input.match(answers.shift()!); });
  expect((await interaction.approve(request)).approved).toBe(false);
  expect(interaction.stopped).toBe(false);
  expect((await interaction.approve(request)).approved).toBe(true);
  expect((await interaction.approve(request)).approved).toBe(false);
  expect(interaction.stopped).toBe(true);
  expect((await interaction.approve(request)).approved).toBe(false);
  expect(prompts).toBe(3);
});

test("read-only noninteractive probes run, writes need yes, and yes never prompts", async () => {
  const prompt = async () => { throw new Error("must not prompt"); };
  const interaction = new HealthInteraction(new CommandContext({}), false, prompt);
  expect((await interaction.approve(request)).approved).toBe(true);
  expect(await interaction.approve({ ...request, risk: "disrupt" })).toEqual({ approved: false, source: "non-interactive" });
  expect((await new HealthInteraction(new CommandContext({}, undefined, { yes: true }), true, prompt).approve({ ...request, risk: "disrupt" })).approved).toBe(true);
  await withInteractionOptions({ yes: true }, async () => expect(isInteractive(true)).toBe(false));
});

test("shared source reuses refusal, while separate sources and sessions ask again", async () => {
  let prompts = 0;
  const interaction = new HealthInteraction(new CommandContext({}), true, async input => { prompts++; return input.match("n"); });
  const [first, second] = await Promise.all([interaction.approveOnce("source-a", request), interaction.approveOnce("source-a", request)]);
  expect(first).toBe(second);
  expect(first.approved).toBe(false);
  await interaction.approveOnce("source-b", request);
  expect(prompts).toBe(2);
  await new HealthInteraction(new CommandContext({}), true, async input => { prompts++; return input.match("y"); }).approveOnce("source-a", request);
  expect(prompts).toBe(3);
});
