import { InvalidArgumentError, Option } from "commander";

/** @spec Service selection is an array; repeat -s/--service to select additional Services. */
class ServiceOption extends Option {
  override attributeName(): string { return "services"; }
}

export function serviceOption(description: string): Option {
  return new ServiceOption("-s, --service <name>", `${description}；可重复传入`)
    .argParser((value: string, previous: string[] = []) => {
      const name = value.trim();
      if (!name || name.includes(",")) throw new InvalidArgumentError("每次指定一个 Service；多个 Service 请重复传入 -s/--service");
      return [...new Set([...previous, name])];
    });
}
