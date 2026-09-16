import type { Command } from "commander";
import { deliveryFormatOption } from "../../app/command-defaults";

export function withDbOptions(command: Command): Command {
  return command
    .option("--service <name>", "贡献数据库访问目标的业务 Service")
    .option("-D, --database <name>", "Service 可访问的 database")
    .option("--table <name>", "table 或 database.table；必须唯一定位")
    .option("--show-databases", "列出 Service 账号可见的数据库（不代表拥有全部表的读取权限）")
    .option("--show-tables", "列出可见表，可用 --database 缩小范围")
    .option("--show-create-table", "查看 --table 的建表语句")
    .option("-e, --execute <sql>", "执行一条只读 SQL；参数值使用 ? 和 --params")
    .option("--file <path>", "从 UTF-8 文件读取一条 SQL；- 表示 stdin，不支持批量脚本")
    .option("--params <json-array>", "? 的位置参数 JSON 数组")
    .option("--timeout <seconds>", "每次查询期限（1..300 秒）", "15")
    .option("--max-rows <n>", "每次查询最多保留行数（1..100000）", "1000")
    .option("--max-bytes <n>", "每次查询最多保留 JSON 行字节数（不含包装结构）", "4194304")
    .option("-n, --namespace <ns>", "Service 目标 namespace")
    .option("-p, --pod <pod>", "envPrefix 配置来源 Pod；多副本时可显式指定")
    .option("-c, --container <name>", "envPrefix 配置来源 Container")
    .option("--profile <name>", "从 profile 读取 namespace / kubeconfig / Plugin config")
    .option("--config <path>", "Doctor config 文件路径")
    .addOption(deliveryFormatOption(["html", "bundle", "json"]))
    .option("-o, --output <path>", "取证结果输出路径");
}
