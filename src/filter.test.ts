/// <reference types="bun" />
import { expect, test } from "bun:test";
import { selectDependencies } from "./filter.js";

const deps = {
  react: "^18.0.0",
  "react-dom": "^18.0.0",
  "@types/react": "^18.0.0",
  "@types/node": "^20.0.0",
  eslint: "^9.0.0",
  "eslint-plugin-react": "^7.0.0",
  "lodash.merge": "^4.0.0",
};

test("no patterns keeps everything", () => {
  expect(selectDependencies(deps, [])).toBe(deps);
});

test("plain names match exactly", () => {
  expect(Object.keys(selectDependencies(deps, ["react"]))).toEqual(["react"]);
  expect(Object.keys(selectDependencies(deps, ["react", "eslint"]))).toEqual([
    "react",
    "eslint",
  ]);
});

test("* matches any part of a name, including scopes", () => {
  expect(Object.keys(selectDependencies(deps, ["@types/*"]))).toEqual([
    "@types/react",
    "@types/node",
  ]);
  expect(Object.keys(selectDependencies(deps, ["eslint*"]))).toEqual([
    "eslint",
    "eslint-plugin-react",
  ]);
  expect(Object.keys(selectDependencies(deps, ["*react*"]))).toEqual([
    "react",
    "react-dom",
    "@types/react",
    "eslint-plugin-react",
  ]);
});

test("dots and other regex characters are literal", () => {
  expect(Object.keys(selectDependencies(deps, ["lodash.merge"]))).toEqual([
    "lodash.merge",
  ]);
  expect(selectDependencies(deps, ["lodashXmerge"])).toEqual({});
});

test("a pattern that matches nothing yields nothing", () => {
  expect(selectDependencies(deps, ["vue"])).toEqual({});
});
