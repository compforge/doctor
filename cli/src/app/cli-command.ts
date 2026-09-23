import { Command, type Help } from "commander";
import { withInteractionOptions } from "../terminal/policy";
import { commandOptionsWithSources } from "./option-sources";

const GLOBAL_HELP_OPTIONS = new Set(["profile", "output"]);

/** Scope starts before the action: even bootstrap and parameter selection must honor --yes. */
export class CliCommand extends Command {
  override createCommand(name?: string): Command { return new CliCommand(name); }

  override createHelp(): Help {
    const help = super.createHelp();
    const visibleOptions = help.visibleOptions.bind(help);
    const visibleGlobalOptions = help.visibleGlobalOptions.bind(help);
    // Keep parsing and command-specific descriptions local while presenting shared controls together.
    help.visibleOptions = command => visibleOptions(command).filter(option => !GLOBAL_HELP_OPTIONS.has(option.attributeName()));
    help.visibleGlobalOptions = command => [
      ...visibleGlobalOptions(command),
      ...visibleOptions(command).filter(option => GLOBAL_HELP_OPTIONS.has(option.attributeName())),
    ];
    return help;
  }

  override action(handler: Parameters<Command["action"]>[0]): this {
    return super.action((...args: Parameters<typeof handler>) =>
      withInteractionOptions(commandOptionsWithSources(this), () => handler.apply(this, args)));
  }
}
