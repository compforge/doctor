import type { ServiceMetricCapability } from "@compforge/doctor-plugin";

export type MetricStoreKind = "redis" | "mysql";

export const STORE_METRIC_NAMES: Record<MetricStoreKind, readonly string[]> = {
  redis: [
    "redis_up",
    "redis_commands_total",
    "redis_commands_duration_seconds_total",
    "redis_commands_rejected_calls_total",
    "redis_commands_failed_calls_total",
    "redis_connected_clients",
    "redis_blocked_clients",
    "redis_memory_used_bytes",
    "redis_memory_used_rss_bytes",
    "redis_evicted_keys_total",
    "redis_expired_keys_total",
    "redis_keyspace_hits_total",
    "redis_keyspace_misses_total",
    "redis_rejected_connections_total",
    "redis_doctor_clients",
    "redis_doctor_memory_bytes",
  ],
  mysql: [
    "mysql_up",
    "mysql_global_status_queries",
    "mysql_global_status_threads_connected",
    "mysql_global_status_threads_running",
    "mysql_global_status_slow_queries",
    "mysql_global_status_created_tmp_disk_tables",
    "mysql_global_status_aborted_connects",
    "mysql_global_status_bytes_received",
    "mysql_global_status_bytes_sent",
    "mysql_global_status_innodb_rows_read",
    "mysql_global_status_innodb_rows_inserted",
    "mysql_global_status_innodb_rows_updated",
    "mysql_global_status_innodb_rows_deleted",
    "mysql_doctor_threads",
    "mysql_doctor_pressure_events_total",
  ],
};

export const STORE_METRIC_CAPABILITIES: Record<MetricStoreKind, ServiceMetricCapability> = {
  redis: {
    endpoint: { port: 9121, path: "/metrics" },
    metricNames: STORE_METRIC_NAMES.redis,
    charts: [
      {
        id: "redis-command-rate",
        title: "Redis 命令速率",
        description: "按命令观察同期调用速率，重点关注 scan 等可能被压力放大的命令。",
        kind: "line",
        unit: "count",
        label: "cmd",
        query: {
          instant: "sum by (cmd) (redis_commands_total)",
          range: "sum by (cmd) (rate(redis_commands_total[{{window}}]))",
        },
      },
      {
        id: "redis-scan-duration",
        title: "Redis SCAN 累计执行耗时速率",
        description: "Redis 在单位时间内消耗于 SCAN 的执行秒数；与 SCAN 调用速率一起判断压力放大。",
        kind: "line",
        unit: "seconds",
        query: {
          instant: "sum(redis_commands_duration_seconds_total{cmd=\"scan\"})",
          range: "sum(rate(redis_commands_duration_seconds_total{cmd=\"scan\"}[{{window}}]))",
        },
      },
      {
        id: "redis-clients",
        title: "Redis 客户端连接",
        description: "同期已连接与阻塞客户端数量。",
        kind: "line",
        unit: "count",
        label: "state",
        query: {
          instant: "sum by (state) (redis_doctor_clients)",
          range: "sum by (state) (redis_doctor_clients)",
        },
      },
      {
        id: "redis-memory",
        title: "Redis 内存",
        description: "Redis logical used memory 与 RSS；数值单位为 bytes。",
        kind: "line",
        label: "type",
        query: {
          instant: "sum by (type) (redis_doctor_memory_bytes)",
          range: "sum by (type) (redis_doctor_memory_bytes)",
        },
      },
    ],
  },
  mysql: {
    endpoint: { port: 9104, path: "/metrics" },
    metricNames: STORE_METRIC_NAMES.mysql,
    charts: [
      {
        id: "mysql-query-rate",
        title: "MySQL QPS",
        description: "由全局 Queries 累计计数计算的同期查询速率。",
        kind: "line",
        unit: "count",
        query: {
          instant: "sum(mysql_global_status_queries)",
          range: "sum(rate(mysql_global_status_queries[{{window}}]))",
        },
      },
      {
        id: "mysql-threads",
        title: "MySQL 连接与运行线程",
        description: "同期 connected/running threads，用于佐证连接堆积或 DB 执行压力。",
        kind: "line",
        unit: "count",
        label: "state",
        query: {
          instant: "sum by (state) (mysql_doctor_threads)",
          range: "sum by (state) (mysql_doctor_threads)",
        },
      },
      {
        id: "mysql-pressure-events",
        title: "MySQL 压力事件速率",
        description: "同期慢查询、磁盘临时表和失败连接的增长速率。",
        kind: "line",
        unit: "count",
        label: "event",
        query: {
          instant: "sum by (event) (mysql_doctor_pressure_events_total)",
          range: "sum by (event) (rate(mysql_doctor_pressure_events_total[{{window}}]))",
        },
      },
    ],
  },
};
