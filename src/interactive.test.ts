/// <reference types="bun" />
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { keyFromInput, pick, reduce, render } from "./interactive.js";

const plain = { highlight: (t: string) => `*${t}*`, dim: (t: string) => t };

test("maps terminal input to keys", () => {
  expect(keyFromInput("\x1b[A")).toBe("up");
  expect(keyFromInput("j")).toBe("down");
  expect(keyFromInput(" ")).toBe("toggle");
  expect(keyFromInput("\r")).toBe("confirm");
  expect(keyFromInput("\x03")).toBe("cancel");
  expect(keyFromInput("z")).toBeUndefined();
});

test("moves the cursor with wrap-around and toggles items", () => {
  let state = { cursor: 0, checked: [true, false, false] };
  state = reduce(state, "up");
  expect(state.cursor).toBe(2);
  state = reduce(state, "down");
  expect(state.cursor).toBe(0);
  state = reduce(state, "toggle");
  expect(state.checked).toEqual([false, false, false]);
  state = reduce(state, "all");
  expect(state.checked).toEqual([true, true, true]);
  state = reduce(state, "all");
  expect(state.checked).toEqual([false, false, false]);
});

test("renders a cursor marker and checkboxes", () => {
  const items = [
    { label: "express", checked: false },
    { label: "lodash", checked: true },
  ];
  expect(render(items, { cursor: 1, checked: [false, true] }, plain)).toEqual([
    "  [ ] express",
    "*> [x] lodash*",
  ]);
});

test("the picker can be driven through streams and resolves with the selection", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  const items = [
    { label: "express", checked: false },
    { label: "lodash", checked: true },
    { label: "react", checked: false },
  ];
  const result = pick(items, plain, { input, output });
  input.write("\x1b[B"); // down to lodash
  input.write("\x1b[B"); // down to react
  input.write(" "); // tick react
  input.write("\r"); // apply
  expect(await result).toEqual([false, true, true]);
  expect(written).toContain("[x] react");
  expect(written.endsWith("\x1b[?25h")).toBe(true); // cursor shown again
});

test("quitting resolves with null", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const result = pick([{ label: "x", checked: true }], plain, {
    input,
    output,
  });
  input.write("q");
  expect(await result).toBeNull();
});
