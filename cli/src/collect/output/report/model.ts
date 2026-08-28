export interface HtmlPieChart {
  title: string;
  description?: string;
  slices: Array<{ label: string; value: number; valueLabel?: string }>;
}

export interface HtmlLineChart {
  title: string;
  description?: string;
  unit?: string;
  series: Array<{
    label: string;
    points: Array<{ timestamp: number; value: number }>;
  }>;
}

export interface HtmlBarChartItem {
  label: string;
  value: number;
  valueLabel: string;
  detail?: string;
  breakdown?: {
    title: string;
    items: HtmlBarChartItem[];
  };
}

export interface HtmlTableCell {
  display: unknown;
  sortValue: string | number;
  detail?: string;
  detailTitle?: string;
}

export interface HtmlTableOptions {
  search?: {
    /** Omit to search every cell in a row. */
    column?: number;
    placeholder?: string;
  };
}

export interface HtmlProgressMetric {
  title: string;
  value: number;
  max: number;
  valueLabel: string;
  maxLabel: string;
  status: string;
  details?: readonly string[];
  tone: "normal" | "warning" | "critical";
  indeterminate?: boolean;
}

/** 领域按阅读顺序提交 section；shell 只负责布局和导航，不理解其中业务语义。 */
export interface HtmlReportSection {
  id?: string;
  title: string;
  html: string;
}

/** 可选详情浮层。触发元素与 template 通过 data-inspector-* 属性关联。 */
export interface HtmlReportOverlay {
  title: string;
  ariaLabel: string;
  html: string;
}

export interface HtmlReportOptions {
  title?: string;
  profileName: string;
  /** 由领域 renderer 从 Diagnosis / 结构化结果直接生成；HTML shell 不解析 Markdown。 */
  summaryHtml: string;
  sections?: HtmlReportSection[];
  overlay?: HtmlReportOverlay;
  /** 领域特有的离线交互资产；shell 负责安全内嵌，但不理解其业务语义。 */
  assets?: { styles?: string; script?: string };
}

export interface BundleManifest {
  doctor_version?: string;
  target?: Record<string, unknown>;
  inspection_facts?: Record<string, unknown>;
  params?: Record<string, unknown>;
  started_at?: string;
  finished_at?: string;
  steps?: Array<{
    id: string;
    title: string;
    status: string;
    reason?: string;
    duration_ms?: number;
    raw_file?: string;
  }>;
}
