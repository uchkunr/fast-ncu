import type { Readable, Writable } from "node:stream";

export interface PickItem {
  label: string;
  checked: boolean;
}

export interface PickState {
  cursor: number;
  checked: boolean[];
}

export type Key = "up" | "down" | "toggle" | "all" | "confirm" | "cancel";

export interface PickStyle {
  highlight: (text: string) => string;
  dim: (text: string) => string;
}

export const HINT =
  "up/down move   space toggle   a all   enter apply   q quit";

export function keyFromInput(input: string): Key | undefined {
  switch (input) {
    case "\x1b[A":
    case "k":
      return "up";
    case "\x1b[B":
    case "j":
      return "down";
    case " ":
      return "toggle";
    case "a":
      return "all";
    case "\r":
    case "\n":
      return "confirm";
    case "q":
    case "\x1b":
    case "\x03": // ctrl+c
      return "cancel";
    default:
      return undefined;
  }
}

export function reduce(state: PickState, key: Key): PickState {
  const n = state.checked.length;
  switch (key) {
    case "up":
      return { ...state, cursor: (state.cursor + n - 1) % n };
    case "down":
      return { ...state, cursor: (state.cursor + 1) % n };
    case "toggle":
      return {
        ...state,
        checked: state.checked.map((c, i) => (i === state.cursor ? !c : c)),
      };
    case "all": {
      const all = state.checked.every(Boolean);
      return { ...state, checked: state.checked.map(() => !all) };
    }
    default:
      return state;
  }
}

export function render(
  items: PickItem[],
  state: PickState,
  style: PickStyle,
): string[] {
  return items.map((item, i) => {
    const line = `${i === state.cursor ? ">" : " "} [${state.checked[i] ? "x" : " "}] ${item.label}`;
    return i === state.cursor ? style.highlight(line) : line;
  });
}

interface Streams {
  input: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => void };
  output: Writable;
}

/**
 * Lets the user tick items in the terminal. Resolves with the final checked
 * flags, or null when they quit. `streams` defaults to the process's own; a
 * test can pass its own to drive the picker.
 */
export function pick(
  items: PickItem[],
  style: PickStyle,
  { input = process.stdin, output = process.stdout }: Partial<Streams> = {},
): Promise<boolean[] | null> {
  let state: PickState = { cursor: 0, checked: items.map((i) => i.checked) };
  let drawn = 0;

  const draw = () => {
    // Move up over what was drawn last time and clear it, then draw afresh.
    if (drawn > 0) output.write(`\x1b[${drawn}A\x1b[J`);
    const lines = [style.dim(HINT), ...render(items, state, style)];
    output.write(lines.join("\n") + "\n");
    drawn = lines.length;
  };

  input.setRawMode?.(true);
  input.setEncoding("utf8");
  input.resume();
  output.write("\x1b[?25l"); // hide the cursor while we own the screen
  draw();

  return new Promise((resolve) => {
    const finish = (result: boolean[] | null) => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\x1b[?25h");
      resolve(result);
    };
    const onData = (chunk: string) => {
      const key = keyFromInput(chunk);
      if (key === "confirm") return finish(state.checked);
      if (key === "cancel") return finish(null);
      if (!key) return;
      state = reduce(state, key);
      draw();
    };
    input.on("data", onData);
  });
}
