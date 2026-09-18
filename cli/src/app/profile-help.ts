import { Help, type Command } from "commander";
import { resolveConfigPath } from "./profile";
import { commandOptionsWithSources } from "./option-sources";

const profileOptions = new Set(["profile", "resume", "server"]);

/** Help reflects the parsed config entry without reading a file or mutating shared option definitions. */
export function configureProfileHelp(program: Command): void {
  const configure = (command: Command): void => {
    const disabled = () => resolveConfigPath(commandOptionsWithSources(command).config) === "";
    command.configureHelp({
      ...command.configureHelp(),
      visibleCommands(cmd) {
        const commands = Help.prototype.visibleCommands.call(this, cmd);
        return disabled() ? commands.filter(child => !["init", "profile"].includes(child.name())) : commands;
      },
      visibleOptions(cmd) {
        const options = Help.prototype.visibleOptions.call(this, cmd);
        return disabled() ? options.filter(option => !profileOptions.has(option.attributeName())) : options;
      },
      visibleGlobalOptions(cmd) {
        const options = Help.prototype.visibleGlobalOptions.call(this, cmd);
        return disabled() ? options.filter(option => !profileOptions.has(option.attributeName())) : options;
      },
      optionDescription(option) {
        if (disabled()) {
          if (option.attributeName() === "kubeconfig") return "Kubernetes 配置路径；仅访问 Kubernetes 时使用";
          if (option.attributeName() === "config") return 'Doctor 配置路径；空字符串禁用外部配置（当前已禁用）';
          if (option.attributeName() === "prometheus") return "Prometheus 地址";
        }
        return Help.prototype.optionDescription.call(this, option);
      },
    });
    for (const child of command.commands) configure(child);
  };
  configure(program);
}
