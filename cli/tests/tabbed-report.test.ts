import { expect, test } from "bun:test";
import { renderTabbedReport } from "../src/collect/output/tabbed-report";

test("单个结果收进上下文且不占用页签行", () => {
  const html = renderTabbedReport({
    title: "doctor Data 业务数据汇集报告",
    description: "同一批次采集，每个 Biz ID 独立诊断",
    ariaLabel: "Biz ID 数据诊断结果",
    tabs: [{ key: "biz-1", label: "biz-1", status: "delivered", html: "<h1>biz one</h1>" }],
  });

  expect(html).toContain('class="context"');
  expect(html).toContain('id="primary-tabs" role="tablist" aria-label="Biz ID 数据诊断结果" hidden');
  expect(html.match(/<iframe/g)).toHaveLength(1);
});

test("多个结果使用同一套一级导航", () => {
  const html = renderTabbedReport({
    title: "doctor Log 日志报告",
    description: "同一批次采集，每个 Biz ID 独立筛选与诊断",
    ariaLabel: "Biz ID 日志诊断结果",
    tabs: [
      { key: "biz-1", label: "biz-1", status: "delivered", html: "<h1>biz one</h1>" },
      { key: "biz-2", label: "biz-2", status: "failed", html: "<h1>biz two</h1>" },
    ],
  });

  expect(html).not.toContain('class="context"');
  expect(html).not.toContain('aria-label="Biz ID 日志诊断结果" hidden');
  expect(html.match(/role="tab"/g)).toHaveLength(2);
});

test("分组报告用一层紧凑导航承载 Biz 与 Trace，不嵌套报告外壳", () => {
  const html = renderTabbedReport({
    title: "doctor Trace 诊断报告",
    description: "同一批次采集，每个 Biz ID 独立分组",
    ariaLabel: "Biz ID Trace 诊断结果",
    tabs: [{
      key: "biz-1",
      label: "biz-1",
      status: "delivered",
      tabs: [
        { key: "biz-1-trace-1", label: "source-1 · trace-1", status: "delivered", html: "<h1>trace one</h1>" },
        { key: "biz-1-trace-2", label: "source-2 · trace-2", status: "failed", html: "<h1>trace two</h1>" },
      ],
    }],
  });

  expect(html.match(/<iframe/g)).toHaveLength(1);
  expect(html).toContain('id="primary-tabs"');
  expect(html).toContain('id="secondary-tabs"');
  expect(html).toContain('class="context"');
  expect(html).toContain('const childTabs={"biz-1"');
  expect(html).toContain('flex:1;min-height:0');
  expect(html).not.toContain("linear-gradient");
});

test("分组标签安全嵌入脚本并由 DOM textContent 渲染", () => {
  const html = renderTabbedReport({
    title: "report",
    description: "description",
    ariaLabel: "results",
    tabs: [{
      key: "biz-1",
      label: "biz-1",
      status: "delivered",
      tabs: [{
        key: "biz-1-trace-1",
        label: "</script><script>alert(1)</script>",
        status: "delivered",
        html: "<p>trace</p>",
      }],
    }],
  });

  expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
  expect(html).not.toContain("</script><script>alert(1)</script>");
  expect(html).toContain("label.textContent=tab.label");
});
