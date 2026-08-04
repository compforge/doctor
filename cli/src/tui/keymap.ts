// Centralised key binding definitions.
// App.tsx / Input.tsx match against these — change here to remap globally.

export const KEYMAP = {
  /** Abort the running turn (keep REPL alive). */
  ABORT: { escape: true },
  /** Quit the CLI. Double-tap to confirm when busy. */
  EXIT: { ctrl: true, input: "c" },
  /** Open $EDITOR for multi-line input. */
  OPEN_EDITOR: { ctrl: true, input: "e" },
} as const;
