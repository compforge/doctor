import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { createDeliveryPlan } from "../src/app/delivery-plan";

test("generated destinations are absolute, unique and immutable before execution", () => {
  const options = { format: "default" };
  const plan = createDeliveryPlan("doctor trace", options);
  expect(isAbsolute(plan.file!.path)).toBe(true);
  expect(isAbsolute(plan.archive!)).toBe(true);
  expect(plan.file!.path).toContain("doctor-trace-");
  expect(plan.archive).toBe(plan.file!.path.replace(/\.html$/, ".tar.gz"));
  expect(plan.archive).not.toBe(createDeliveryPlan("doctor trace", options).archive);
  const before = JSON.stringify(plan);
  options.format = "json";
  expect(JSON.stringify(plan)).toBe(before);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.file)).toBe(true);
});

for (const format of ["default", "html", "json", "md", "bundle", "manifest", "summary"]) {
  test(`render requirement is fixed with ${format} delivery`, () => {
    expect(createDeliveryPlan("doctor test", { format }).needsHtml).toBe(["default", "html", "bundle"].includes(format));
  });
}
