import type { RegisteredExtension, ServiceCatalog, ServiceDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { isInteractive } from "../terminal/policy";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";

export type ExtensionProvider = { service: ServiceDefinition; extension: RegisteredExtension };

/** Commands choose their candidate scope; this helper only resolves an individual choice. */
export async function selectExtension(
  catalog: ServiceCatalog,
  kind: string,
  options: { service?: string; extension?: string; commandContext?: CommandContext } = {},
): Promise<ExtensionProvider> {
  const [serviceName, extensionId] = options.service?.split("/") ?? [];
  const selectedId = options.extension ?? extensionId;
  const canonical = serviceName === undefined ? undefined : catalog.find(serviceName)?.name;
  const candidates = catalog.extensions(kind).filter(item =>
    (serviceName === undefined || item.service.name === canonical)
    && (selectedId === undefined || item.extension.id === selectedId));
  const label = (item: ExtensionProvider) => item.service.name + "/" + item.extension.id;
  if (!candidates.length) throw new Error("No " + kind + " Extension" + (options.service ? " for Service '" + options.service + "'" : ""));
  if (candidates.length === 1) return candidates[0]!;
  if (!isInteractive()) throw new Error("Ambiguous " + kind + " Extension: " + candidates.map(label).join(", ") + "; select a provider explicitly");
  printNumberedChoices(candidates, kind + " providers:", label);
  const selected = await promptListedChoice({
    question: "选择提供方（序号/Service 与 Extension ID，q 取消）: ",
    match: answer => matchListedChoice(candidates, answer, label, item => item),
    invalidMessage: "请选择列出的 Extension",
  });
  if (!selected) {
    options.commandContext?.cancel();
    throw new Error("已取消 " + kind + " 提供方选择");
  }
  return selected;
}
