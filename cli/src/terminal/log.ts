import { AsyncLocalStorage } from "node:async_hooks";
import { createConsola, type ConsolaInstance } from "consola";
import { writeTerminalOutput } from "./interaction";

export type LogLevel = "silent" | "info" | "verbose";
const levels = { silent: 0, info: 3, verbose: 5 } as const;
const scope = new AsyncLocalStorage<ConsolaInstance>();

function createLogger(level: LogLevel): ConsolaInstance {
  const logger = createConsola({
    level: levels[level], throttle: 0,
    formatOptions: { date: false },
  });
  // Keep Consola's formatting while coordinating writes with interactive input ownership.
  const stream = (target: NodeJS.WriteStream) => new Proxy(target, {
    get(target, key) {
      if (key === "write") return (chunk: string | Uint8Array) => writeTerminalOutput(target, chunk);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const stdout = stream(process.stdout), stderr = stream(process.stderr);
  const reporters = logger.options.reporters;
  logger.setReporters([{
    log(record, context) {
      for (const reporter of reporters) reporter.log(record, {
        options: { ...context.options, stdout, stderr: record.level === 0 ? stderr : stdout },
      });
    },
  }]);
  return logger;
}

const startupLogger = createLogger("info");

/** Resolve inside execution, so concurrent commands retain their own verbosity policy. */
export function useLogger(tag?: string): ConsolaInstance {
  const logger = scope.getStore() ?? startupLogger;
  return tag ? logger.withTag(tag) : logger;
}

/** Includes preparation, execution and cleanup; result delivery uses an independent writer. */
export function withLogger<T>(level: LogLevel, work: () => T): T {
  return scope.run(createLogger(level), work);
}
