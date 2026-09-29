import { Argument, type Command } from "commander";
import { deliveryFormatOption } from "../../app/command-defaults";
import { S3_ACTIONS } from "./input";

export function withS3Options(command: Command): Command {
  return command
    .addArgument(new Argument("[operation]", "ls 浏览、stat 元数据、cat 有界读取；省略时在终端选择").choices([...S3_ACTIONS]))
    .argument("[target]", "Service[/bucket[/key]]；指定 --service 时也可用 bucket/key 或 s3://bucket/key")
    .option("--service <name>", "提供 S3 访问配置的业务 Service")
    .option("--data-source <id>", "选择 Service 声明的 S3 数据源；多数据源时必须唯一选择")
    .option("-r, --recursive", "递归列出指定 bucket/prefix 的对象（默认只列一层）")
    .option("--continuation-token <token>", "从上次 ls 返回的游标继续，需保持相同目标与递归选项")
    .option("--version-id <id>", "stat/cat 指定对象版本")
    .option("--max-items <n>", "ls 最多返回的 bucket、对象与子前缀总数", "1000")
    .option("--max-bytes <n>", "cat 最多读取的字节数", "65536")
    .option("--timeout <seconds>", "本次 S3 操作的总时间预算", "15")
    .option("-p, --pod <pod>", "读取运行时 S3 配置的 Service Pod")
    .option("-c, --container <name>", "配置来源 Container")
    .option("-n, --namespace <ns>", "Service 所在 namespace")
    .option("--profile <name>", "使用指定 profile")
    .option("--config <path>", "Doctor 配置路径")
    .addOption(deliveryFormatOption(["html", "bundle", "json", "summary"]))
    .option("-o, --output <path>", "取证结果输出路径")
    .addHelpText("after", `\n示例：\n  doctor s3 ls app\n  doctor s3 ls app/bucket/artifacts/\n  doctor s3 stat app/bucket/file.txt\n  doctor s3 cat --service app s3://bucket/file.txt --max-bytes 4096\n\nService 相当于 mc 的连接别名；连接来自 Service，key 按字面传递，不解码或归一化。\n`);
}
