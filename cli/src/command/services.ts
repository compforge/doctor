import { posix } from "node:path";
import { defineCommand, type Command, type CommandInput } from "./spec";
import { CommandInputError, aggregateCommandStatus, type CommandResult } from "./result";
import { CommandStatus } from "./status";
import { composeReports } from "../report/model";
import { summaryText } from "./summary";
import { useLogger } from "../terminal/log";

type ServiceInput<Input> = Omit<Input, "service"> & { services?: readonly string[] };
interface ServiceResult<Output> {
  service?: string;
  result: CommandResult<Output>;
}

/**
 * @spec A service-scoped command always receives a selection array. Each selected Service owns
 * its preparation and result; failures retain sibling evidence and cancellation stops the batch.
 * @link cli/docs/kernel.md
 */
export function forServices<Input extends CommandInput & { service?: string }, Output>(
  command: Command<Input, Output>,
): Command<ServiceInput<Input>, { services: ServiceResult<Output>[] }> {
  return defineCommand<ServiceInput<Input>, { services: ServiceResult<Output>[] }>({
    name: command.name,
    validate: async input => {
      if (input.services !== undefined && (!input.services.length || input.services.some(name => !name.trim()))) {
        throw new CommandInputError("--service 不能为空");
      }
      const { services, ...options } = input;
      for (const service of services ?? [undefined]) await command.validate?.({ ...options, service } as Input);
    },
    prepare: async (context, input) => {
      if (input.services === undefined) return input;
      const plugin = await context.resolvePlugin();
      if (!plugin) throw new CommandInputError(`${command.name} 需要 Plugin 声明 Service`);
      const unknown = input.services.filter(name => !plugin.services.find(name));
      if (unknown.length) throw new CommandInputError(`Unknown Service: ${unknown.join(", ")}`);
      return { ...input, services: plugin.services.resolveNames(input.services) };
    },
    run: async (context, input) => {
      const { services, ...options } = input;
      const results: ServiceResult<Output>[] = [];
      for (const service of services ?? [undefined]) {
        if (context.signal.aborted) break;
        if (service) useLogger(command.name).info(`Service: ${service}`);
        const result = await command.run(context, { ...options, service, idempotencyKey: undefined } as Input);
        results.push({ service, result });
        if (result.status === CommandStatus.Cancelled) break;
      }
      const failures = results.flatMap(item => "reason" in item.result && item.result.reason
        ? [`${item.service ?? command.name}: ${item.result.reason}`] : []);
      const error = results.map(item => "error" in item.result ? item.result.error : undefined).find(error => error !== undefined);
      const status = context.signal.aborted ? CommandStatus.Cancelled : aggregateCommandStatus(results.map(item => item.result.status));
      const artifacts = results.flatMap(item => item.result.artifacts);
      const reason = failures.length ? failures.join("; ") : undefined;
      if (status === CommandStatus.Failed || status === CommandStatus.Cancelled) {
        const collected = results.some(item => item.result.output !== undefined || item.result.artifacts.length > 0);
        return { status, error, reason, artifacts, output: collected ? { services: results } : undefined };
      }
      return { status, reason, output: { services: results }, artifacts };
    },
    reportName: command.reportName ? (input, result, now) => {
      const first = result.output?.services[0];
      if (!first) return undefined;
      const { services: _services, ...options } = input;
      return command.reportName!({ ...options, service: first.service } as Input, first.result, now);
    } : undefined,
    serialize: command.serialize ? async (context, result) => {
      const services = result.output?.services ?? [];
      // Keep a single delivery's established evidence paths and full terminal summary.
      if (services.length === 1) return command.serialize!(context, services[0]!.result);
      const children = await Promise.all(services.map(item => context.serialize(command, item.result)));
      const lines = services.map((item, index) => {
        const summary = posix.join(posix.dirname(children[index]!.manifest), "summary.md");
        return `- [${summaryText(item.service ?? command.name)}](<${summary}>) · ${item.result.status}`;
      });
      return { files: { summary: context.writeText("summary.md", `# ${summaryText(command.name)}\n\n${lines.join("\n")}\n`) }, children };
    } : undefined,
    render: command.render ? async (context, result) => composeReports(command.name,
      await Promise.all((result.output?.services ?? []).map(async item => {
        const report = await context.render(command, item.result);
        return item.service ? { ...report, sections: report.sections.map(section => ({ ...section,
          pages: section.pages.map(page => ({ ...page, subject: page.subject ?? { key: item.service!, label: item.service! } })),
        })) } : report;
      })),
    ) : undefined,
  });
}
