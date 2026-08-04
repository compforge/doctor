import { readdirSync } from "node:fs";
import { join } from "node:path";
import { terminalStdout } from "./output";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "./selection";

export function findSelectableFiles(
  directory: string,
  accept: (name: string, path: string) => boolean,
): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => accept(name, join(directory, name)))
    .sort((left, right) => left.localeCompare(right));
}

export interface ResolveFileSelectionInput {
  file?: string;
  directory?: string;
  interactive?: boolean;
  findCandidates: (directory: string) => string[];
  listTitle: string;
  question: string;
  invalidMessage: string;
  cancelledMessage: string;
  missingFileMessage: string;
  noCandidatesMessage: string;
  singleCandidateMessage: (file: string) => string;
  prompt?: (files: readonly string[]) => Promise<string | undefined>;
}

async function promptFile(
  files: readonly string[],
  input: ResolveFileSelectionInput,
): Promise<string | undefined> {
  printNumberedChoices(files, input.listTitle, (file) => file);
  return promptListedChoice({
    question: input.question,
    match: (answer) => matchListedChoice(files, answer, (file) => file, (file) => file),
    invalidMessage: input.invalidMessage,
  });
}

export async function resolveFileSelection(
  input: ResolveFileSelectionInput,
): Promise<string | undefined> {
  if (input.file?.trim()) return input.file;

  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) throw new Error(input.missingFileMessage);

  const directory = input.directory ?? ".";
  const files = input.findCandidates(directory);
  if (!files.length) throw new Error(input.noCandidatesMessage);
  if (files.length === 1) {
    terminalStdout.info(`${input.singleCandidateMessage(files[0]!)}\n`);
    return join(directory, files[0]!);
  }

  const selected = await (input.prompt ? input.prompt(files) : promptFile(files, input));
  if (!selected) {
    terminalStdout.warning(`${input.cancelledMessage}\n`);
    return undefined;
  }
  return join(directory, selected);
}
