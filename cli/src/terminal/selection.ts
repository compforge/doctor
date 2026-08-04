import { terminalStdout } from "./output";
import { createInterface } from "node:readline/promises";
import { prepareTerminalInput } from "./input";

export function matchListedChoice<Choice, Value>(
  choices: readonly Choice[],
  answer: string,
  labelOf: (choice: Choice) => string,
  valueOf: (choice: Choice) => Value,
): Value | undefined {
  const normalized = answer.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    const choice = choices[Number(normalized) - 1];
    return choice === undefined ? undefined : valueOf(choice);
  }
  const choice = choices.find((item) => labelOf(item).toLowerCase() === normalized);
  return choice === undefined ? undefined : valueOf(choice);
}

export async function promptListedChoice<Value>(input: {
  question: string;
  match: (answer: string) => Value | undefined;
  invalidMessage: string;
  emptyValue?: Value;
}): Promise<Value | undefined> {
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await readline.question(input.question)).trim();
      if (/^(q|quit)$/i.test(answer)) return undefined;
      if (!answer && Object.prototype.hasOwnProperty.call(input, "emptyValue")) {
        return input.emptyValue;
      }
      const selected = input.match(answer);
      if (selected !== undefined) return selected;
      terminalStdout.warning(`${input.invalidMessage}\n`);
    }
  } finally {
    readline.close();
  }
}

export type EnterPromptResult = "submitted" | "cancelled" | "timeout";

export async function promptEnter(input: {
  question: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<EnterPromptResult> {
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    while (true) {
      let answer: string;
      try {
        answer = (await readline.question(input.question, { signal: controller.signal })).trim();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return input.signal?.aborted ? "cancelled" : "timeout";
        }
        throw error;
      }
      if (!answer) return "submitted";
      if (/^(q|quit)$/i.test(answer)) return "cancelled";
      terminalStdout.warning("操作完成后请直接按回车，或输入 q 取消。\n");
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    readline.close();
  }
}

export function matchSearchableChoices<Choice>(
  choices: readonly Choice[],
  keyword: string,
  nameOf: (choice: Choice) => string,
): Choice[] {
  const normalized = keyword.trim().toLowerCase();
  const exact = choices.find((choice) => nameOf(choice).toLowerCase() === normalized);
  if (exact) return [exact];
  return choices.filter((choice) => nameOf(choice).toLowerCase().includes(normalized));
}

export type SearchableChoiceResolution<Value, Choice> =
  | { kind: "selected"; value: Value }
  | { kind: "ambiguous"; matches: Choice[] }
  | { kind: "not-found" }
  | { kind: "invalid-number" };

export function resolveSearchableChoice<Choice, Value>(
  choices: readonly Choice[],
  answer: string,
  numberedChoices: readonly Choice[],
  nameOf: (choice: Choice) => string,
  valueOf: (choice: Choice) => Value,
): SearchableChoiceResolution<Value, Choice> {
  const normalized = answer.trim();
  if (/^\d+$/.test(normalized)) {
    const choice = numberedChoices[Number(normalized) - 1];
    return choice === undefined
      ? { kind: "invalid-number" }
      : { kind: "selected", value: valueOf(choice) };
  }
  const matches = matchSearchableChoices(choices, normalized, nameOf);
  if (matches.length === 1) return { kind: "selected", value: valueOf(matches[0]!) };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "not-found" };
}

export function printNumberedChoices<Choice>(
  choices: readonly Choice[],
  title: string,
  render: (choice: Choice) => string,
): void {
  terminalStdout.info(`${title}\n`);
  choices.forEach((choice, index) => {
    terminalStdout.write(`  ${index + 1}) ${render(choice)}\n`);
  });
}

export async function promptSearchableChoice<Value, Choice>(input: {
  choices: readonly Choice[];
  choicesAreListed?: boolean;
  numberedChoices?: readonly Choice[];
  question: (choicesAreListed: boolean) => string;
  resolve: (
    answer: string,
    numberedChoices: readonly Choice[],
  ) => SearchableChoiceResolution<Value, Choice>;
  printChoices: (choices: readonly Choice[], title: string) => void;
  ambiguousTitle: (answer: string) => string;
  notFoundMessage: (answer: string) => string;
  invalidNumberMessage: string;
  emptyMessage?: string;
}): Promise<Value | undefined> {
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let numberedChoices = input.numberedChoices
    ? [...input.numberedChoices]
    : input.choicesAreListed
      ? [...input.choices]
      : [];
  try {
    while (true) {
      const answer = (await readline.question(input.question(numberedChoices.length > 0))).trim();
      if (/^(q|quit)$/i.test(answer)) return undefined;
      if (!answer && input.emptyMessage) {
        terminalStdout.warning(`${input.emptyMessage}\n`);
        continue;
      }
      const resolution = input.resolve(answer, numberedChoices);
      if (resolution.kind === "selected") return resolution.value;
      if (resolution.kind === "ambiguous") {
        numberedChoices = resolution.matches;
        input.printChoices(numberedChoices, input.ambiguousTitle(answer));
        continue;
      }
      if (resolution.kind === "not-found") {
        terminalStdout.warning(`${input.notFoundMessage(answer)}\n`);
        continue;
      }
      terminalStdout.warning(`${input.invalidNumberMessage}\n`);
    }
  } finally {
    readline.close();
  }
}
