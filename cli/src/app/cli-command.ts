import { Command } from "commander";
import { withInteractionOptions } from "../terminal/policy";
import { commandOptionsWithSources } from "./option-sources";

/** Scope starts before the action: even bootstrap and parameter selection must honor --yes. */
export class CliCommand extends Command {
  override createCommand(name?: string): Command { return new CliCommand(name); }

  override action(handler: Parameters<Command["action"]>[0]): this {
    return super.action((...args: Parameters<typeof handler>) =>
      withInteractionOptions(commandOptionsWithSources(this), () => handler.apply(this, args)));
  }
}
