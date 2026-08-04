import { Box, Text, render, useApp, useInput } from "ink";
import { PassThrough } from "node:stream";
import { useMemo, useState } from "react";

export interface MultiSelectChoice {
  name: string;
}

export interface MultiSelectState {
  cursor: number;
  selected: ReadonlySet<string>;
  warning?: string;
}

export type MultiSelectAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "toggle" };

const VISIBLE_LIMIT = 12;

// Bun 的 readline 与 Ink 分别使用 data/readable 模式；连续交互时直接复用 stdin 会让
// Ink 收不到输入并空转。桥接流让真实 stdin 固定走 data，Ink 只读取独立的 PassThrough。
function createInkStdinBridge(): { stdin: NodeJS.ReadStream; close: () => void } {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stdin, "isTTY", { value: process.stdin.isTTY });
  stdin.setRawMode = (enabled) => {
    process.stdin.setRawMode(enabled);
    return stdin;
  };
  stdin.ref = () => {
    process.stdin.ref();
    return stdin;
  };
  stdin.unref = () => {
    process.stdin.unref();
    return stdin;
  };
  const forward = (chunk: string | Buffer) => { stdin.write(chunk); };
  process.stdin.on("data", forward);
  process.stdin.resume();
  return {
    stdin,
    close: () => {
      process.stdin.removeListener("data", forward);
      process.stdin.pause();
      stdin.end();
    },
  };
}

export function filterMultiSelectChoices<Choice extends MultiSelectChoice>(
  choices: readonly Choice[],
  keyword: string,
): Choice[] {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return [...choices];
  return choices.filter((choice) => choice.name.toLowerCase().includes(normalized));
}

export function createMultiSelectState<Choice extends MultiSelectChoice>(
  choices: readonly Choice[],
  defaults: readonly string[],
): MultiSelectState {
  return {
    cursor: 0,
    selected: new Set(defaults.filter((name) => choices.some((choice) => choice.name === name))),
  };
}

export function reduceMultiSelectState<Choice extends MultiSelectChoice>(
  state: MultiSelectState,
  action: MultiSelectAction,
  choices: readonly Choice[],
): MultiSelectState {
  if (!choices.length) return state;
  if (action.type === "move") {
    return {
      ...state,
      cursor: (state.cursor + action.delta + choices.length) % choices.length,
      warning: undefined,
    };
  }
  const name = choices[state.cursor]!.name;
  const selected = new Set(state.selected);
  if (selected.has(name)) selected.delete(name);
  else selected.add(name);
  return { ...state, selected, warning: undefined };
}

interface MultiSelectPromptProps<Choice extends MultiSelectChoice> {
  choices: readonly Choice[];
  defaults: readonly string[];
  title: string;
  renderChoice: (choice: Choice) => string;
  onComplete: (selected: string[] | undefined) => void;
}

function MultiSelectPrompt<Choice extends MultiSelectChoice>({
  choices,
  defaults,
  title,
  renderChoice,
  onComplete,
}: MultiSelectPromptProps<Choice>) {
  const { exit } = useApp();
  const [state, setState] = useState(() => createMultiSelectState(choices, defaults));
  const [keyword, setKeyword] = useState("");
  const filteredChoices = useMemo(
    () => filterMultiSelectChoices(choices, keyword),
    [choices, keyword],
  );

  const complete = (selected: string[] | undefined): void => {
    onComplete(selected);
    exit();
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      complete(undefined);
      return;
    }
    if (key.escape) {
      if (keyword) {
        setKeyword("");
        setState((current) => ({ ...current, cursor: 0, warning: undefined }));
      } else {
        complete(undefined);
      }
      return;
    }
    if (key.upArrow) {
      setState((current) => reduceMultiSelectState(
        current,
        { type: "move", delta: -1 },
        filteredChoices,
      ));
      return;
    }
    if (key.downArrow) {
      setState((current) => reduceMultiSelectState(
        current,
        { type: "move", delta: 1 },
        filteredChoices,
      ));
      return;
    }
    if (input === " ") {
      setState((current) => {
        const choice = filteredChoices[current.cursor];
        if (!choice) return current;
        const next = reduceMultiSelectState(current, { type: "toggle" }, filteredChoices);
        return {
          ...next,
          cursor: Math.max(0, choices.findIndex((item) => item.name === choice.name)),
        };
      });
      setKeyword("");
      return;
    }
    if (key.return) {
      const selected = choices
        .map((choice) => choice.name)
        .filter((name) => state.selected.has(name));
      if (selected.length) complete(selected);
      else setState((current) => ({ ...current, warning: "请至少选择一个资源。" }));
      return;
    }
    if (key.backspace || key.delete) {
      setKeyword((current) => current.slice(0, -1));
      setState((current) => ({ ...current, cursor: 0, warning: undefined }));
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setKeyword((current) => current + input);
      setState((current) => ({ ...current, cursor: 0, warning: undefined }));
    }
  });

  const windowStart = Math.min(
    Math.max(0, state.cursor - Math.floor(VISIBLE_LIMIT / 2)),
    Math.max(0, filteredChoices.length - VISIBLE_LIMIT),
  );
  const visibleChoices = filteredChoices.slice(windowStart, windowStart + VISIBLE_LIMIT);

  return (
    <Box flexDirection="column">
      <Text color="cyan">{title}</Text>
      <Text>关键词：<Text color={keyword ? "cyan" : undefined}>{keyword || "—"}</Text></Text>
      {visibleChoices.map((choice, offset) => {
        const index = windowStart + offset;
        return <Text key={choice.name} color={index === state.cursor ? "cyan" : undefined}>
          {index === state.cursor ? "❯" : " "} [{state.selected.has(choice.name) ? "x" : " "}] {renderChoice(choice)}
        </Text>
      })}
      {!visibleChoices.length ? <Text color="yellow">没有匹配的资源。</Text> : null}
      <Text dimColor>已选 {state.selected.size} / {choices.length}</Text>
      <Text dimColor>输入关键词过滤 · ↑/↓ 移动 · Space 切换 · Enter 确认 · Esc 清空/取消</Text>
      {state.warning ? <Text color="yellow">{state.warning}</Text> : null}
    </Box>
  );
}

export async function promptMultiSelect<Choice extends MultiSelectChoice>(input: {
  choices: readonly Choice[];
  defaults?: readonly string[];
  title: string;
  renderChoice?: (choice: Choice) => string;
}): Promise<string[] | undefined> {
  let selected: string[] | undefined;
  const bridge = createInkStdinBridge();
  try {
    const app = render(
      <MultiSelectPrompt
        choices={input.choices}
        defaults={input.defaults ?? []}
        title={input.title}
        renderChoice={input.renderChoice ?? ((choice) => choice.name)}
        onComplete={(value) => {
          selected = value;
        }}
      />,
      { stdin: bridge.stdin, incrementalRendering: true },
    );
    await app.waitUntilExit();
    return selected;
  } finally {
    bridge.close();
  }
}
