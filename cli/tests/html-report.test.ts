import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle } from "../src/collect/evidence";
import {
  htmlPieChartSection,
  htmlTable,
  htmlTableCell,
  htmlTableDetailCell,
  writeHtmlReport,
} from "../src/collect/output/html";
import { REPORT_SCRIPT } from "../src/collect/output/report/assets/base-script";

test("离线表格脚本只挂载当前页记录且保持可执行", () => {
  expect(() => new Function(REPORT_SCRIPT)).not.toThrow();
  expect(REPORT_SCRIPT).toContain("renderRows(filteredRows.slice(start, end))");
  expect(REPORT_SCRIPT).toContain("body.replaceChildren(fragment)");
  expect(REPORT_SCRIPT).not.toContain("payload.rows.forEach");
});

test("htmlTable 为离线报告提供数值/字符串排序和分页控件", () => {
  const html = htmlTable(
    ["prefix", "count", "memory"],
    Array.from({ length: 12 }, (_, index) => [
      index === 0 ? "</script><script>alert(3)</script>" : `prefix-${index}:*`,
      index + 2,
      index === 1 ? htmlTableCell("1 MiB", 1024 * 1024) : htmlTableCell("2 KiB", 2048),
    ]),
    { search: { column: 0, placeholder: "按 prefix 检索" } },
  );

  expect(html).toContain('<details class="table-view">');
  expect(html).toContain('class="table-data"');
  expect(html).not.toContain('<table class="data-table"');
  expect(html).toContain('"sortType":"text"');
  expect(html).toContain('"sortType":"number"');
  expect(html).toContain('"sortValue":1048576');
  expect(html).toContain('"display":"1 MiB"');
  expect(html).toContain('class="table-page-size"');
  expect(html).toContain('"searchColumn":0');
  expect(html).toContain('class="table-search"');
  expect(html).toContain('placeholder="按 prefix 检索"');
  expect(html.indexOf('class="table-search"')).toBeLessThan(html.indexOf('class="table-mount"'));
  expect(html).toContain('<option value="0">全部</option>');
  expect(html).toContain('12 条 · 3 列');
  expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(3)");
  expect(html).not.toContain("</script><script>alert(3)</script>");
});

test("htmlTable 大字段仅渲染短预览并保留可搜索详情", () => {
  const html = htmlTable(
    ["key", "data"],
    [["message:1", htmlTableDetailCell('{"message":"preview"}', '{\n  "message": "full detail"\n}', "message:1")]],
    { search: { placeholder: "搜索数据" } },
  );

  expect(html).toContain('"display":"{\\"message\\":\\"preview\\"}"');
  expect(html).toContain('"detail":"{\\n  \\"message\\": \\"full detail\\"\\n}"');
  expect(html).toContain('"detailTitle":"message:1"');
  expect(REPORT_SCRIPT).toContain("cell.detail ?? cell.display");
  expect(REPORT_SCRIPT).toContain("dialog.showModal()");
  expect(REPORT_SCRIPT).toContain("className = 'table-detail-trigger'");
});

test("writeHtmlReport 生成包含诊断内容、Facts 和步骤的轻量单文件报告", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-html-report-"));
  const bundle = new EvidenceBundle(join(dir, "bundle"));
  const rawPayload = JSON.stringify({
    key: "<script>alert(1)</script>",
    padding: "x".repeat(256 * 1024),
  });
  bundle.addStep({
    id: "redis-analysis",
    title: "Redis analysis",
    risk: "observe",
    status: "ok",
    output: rawPayload,
    ext: "json",
  });
  bundle.writeSummary("# Redis 诊断\n\n| node | keys |\n|---|---:|\n| redis-0 | 10 |\n\n<script>alert(2)</script>");
  bundle.writeManifest({
    doctorVersion: "0.0.7",
    target: { endpoint: "redis://redis:6379/0" },
    inspectionFacts: {
      environment: {
        status: "collected",
        variables: {
          REDIS_HOST: "redis.example.test:6379",
          REDIS_PASSWORD: "[REDACTED]",
          HTML_VALUE: "<script>alert(4)</script>",
        },
      },
    },
    params: { output_format: "html" },
    startedAt: "2026-07-13T00:00:00Z",
    finishedAt: "2026-07-13T00:01:00Z",
  });

  const output = join(dir, "report.html");
  writeHtmlReport(bundle.dir, output, {
    title: "Redis report",
    profileName: "prod-cn",
    summaryHtml: "<h1>Redis 诊断</h1><p>TTL 由结构化图表展示。</p><h2>节点容量</h2><p>容量详情。</p><h3>Big Key</h3><p>大 Key 详情。</p>",
    overlay: {
      title: "HTTP Exchange",
      ariaLabel: "HTTP 请求详情",
      html: '<div class="inspector-placeholder">选择请求</div>',
    },
    sections: [
      { title: "Key 分布", html: "<p>Key details</p>" },
      htmlPieChartSection("TTL 分布", [{
        title: "redis-0:6379",
        slices: [{ label: "无 TTL", value: 4 }, { label: "≤ 1 小时", value: 6 }],
      }]),
    ],
    assets: { styles: ".domain-view { color: rebeccapurple; }", script: "window.domainMounted = true;" },
  });
  const html = readFileSync(output, "utf-8");

  expect(existsSync(output)).toBe(true);
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("profile: prod-cn");
  expect(html).toContain("class=\"report-layout\"");
  expect(html).toContain("<aside class=\"sidebar\"");
  expect(html).toContain('<aside class="report-inspector" role="dialog" aria-modal="false" aria-label="HTTP 请求详情" hidden>');
  expect(html).toContain('class="report-inspector-close"');
  expect(html).toContain("resize:both");
  expect(html).toContain("startInspectorDrag");
  expect(html).toContain("选择请求");
  expect(html).toContain("class=\"nav-level-1\" href=\"#report-heading-1\">Redis 诊断</a>");
  expect(html).toContain("class=\"nav-level-2\" href=\"#report-heading-2\">节点容量</a>");
  expect(html).toContain("class=\"nav-level-3\" href=\"#report-heading-3\">Big Key</a>");
  expect(html).toContain("<details class=\"report-subsection section-level-2\" open>");
  expect(html).toContain("<details class=\"report-subsection section-level-3\" open>");
  expect(html).toContain("<h2 id=\"report-heading-2\">节点容量</h2>");
  expect(html).toContain('class="nav-level-1" href="#report-section-1">Key 分布</a>');
  expect(html).toContain('<section id="report-section-1"><h2>Key 分布</h2><p>Key details</p></section>');
  expect(html).toContain('class="nav-level-1" href="#visualizations">TTL 分布</a>');
  expect(html).toContain("href=\"#inspection-facts\"");
  expect(html).toContain("href=\"#collection-steps\"");
  expect(html).toContain("<h2>Inspect Facts</h2>");
  expect(html).toContain("REDIS_HOST");
  expect(html).toContain("redis.example.test:6379");
  expect(html).toContain("[REDACTED]");
  expect(html).not.toContain("<script>alert(4)</script>");
  expect(html).toContain('<details class="collection-steps-view"><summary><span>查看采集步骤</span>');
  expect(html).toContain('<span class="table-summary-meta">1 条</span>');
  expect(html).not.toContain('<details class="collection-steps-view" open>');
  expect(html).not.toContain("href=\"#raw-evidence\"");
  expect(html).toContain("<table>");
  expect(html).toContain("enhanceDataTable");
  expect(html).toContain("mountDataTable");
  expect(html).toContain("[doctor-report] dom:ready");
  expect(html).toContain("[doctor-report] frame:ready");
  expect(html).toContain("[doctor-report] table:mounted");
  expect(html).toContain("document.addEventListener('contextmenu'");
  expect(html).toContain("copyReportText");
  expect(html).toContain("copySource?.textContent");
  expect(html).toContain("activateExchangeTab");
  expect(html).toContain("closeInspector");
  expect(html).toContain("content-visibility:auto");
  expect(html).toContain("contain-intrinsic-size:auto 500px");
  expect(html).toContain("pre code { padding:0; border-radius:0; color:inherit; background:transparent; }");
  expect(html).toContain("redis-analysis");
  expect(html).toContain("conic-gradient");
  expect(html).toContain("TTL 分布");
  expect(html).toContain("无 TTL");
  expect(html).toContain("40.0%");
  expect(html).toContain("TTL 由结构化图表展示");
  expect(html).toContain(".domain-view { color: rebeccapurple; }");
  expect(html).toContain("window.domainMounted = true;");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("<script>alert(2)</script>");
  expect(html).not.toContain("doctor-report-data");
  expect(html).not.toContain("01-redis-analysis.json");
  expect(html).not.toContain("导出原始 JSON");
  expect(html).not.toContain("打印 / 保存 PDF");
  expect(html.length).toBeLessThan(rawPayload.length);
});
