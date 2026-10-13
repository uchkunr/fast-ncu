/// <reference types="bun" />
import { expect, test } from "bun:test";
import { advise } from "./advice.js";
import type { DependencyInfo } from "./index.js";
import { releaseNotesUrl, repositoryUrl } from "./links.js";
import type { VersionInfo } from "./types.js";

const upgrade = (name: string, meta: VersionInfo): DependencyInfo => ({
  name,
  currentRange: "^1.0.0",
  latestVersion: meta.version,
  upgradeVersion: `^${meta.version}`,
  diffType: "major",
  meta,
});

test("warns when the new version needs a Node the project's engines don't guarantee", () => {
  const details = [
    upgrade("express", { version: "5.3.0", engines: { node: ">=18" } }),
  ];
  expect(advise(details, { ranges: {}, nodeRange: ">=16" })).toEqual([
    "express 5.3.0 needs Node >=18; your engines allow >=16",
  ]);
  expect(advise(details, { ranges: {}, nodeRange: ">=20" })).toEqual([]);
});

test("falls back to the running Node when the project declares no engines", () => {
  const details = [
    upgrade("express", { version: "5.3.0", engines: { node: ">=18" } }),
  ];
  expect(advise(details, { ranges: {}, nodeVersion: "16.20.0" })).toEqual([
    "express 5.3.0 needs Node >=18; you run 16.20.0",
  ]);
  expect(advise(details, { ranges: {}, nodeVersion: "20.11.0" })).toEqual([]);
});

test("warns when a peer dependency won't be satisfied after the upgrade", () => {
  const details = [
    upgrade("react-dom", {
      version: "19.3.0",
      peerDependencies: { react: "^19.3.0" },
    }),
  ];
  expect(
    advise(details, { ranges: { react: "^18.3.1", "react-dom": "^19.3.0" } }),
  ).toEqual(["react-dom 19.3.0 wants react ^19.3.0; you'd have ^18.3.1"]);
  // react is upgraded too: the post-upgrade range satisfies the peer
  expect(
    advise(details, { ranges: { react: "^19.3.0", "react-dom": "^19.3.0" } }),
  ).toEqual([]);
});

test("ignores optional peers and peers the project doesn't have", () => {
  const details = [
    upgrade("lib", {
      version: "2.0.0",
      peerDependencies: { vue: "^3.0.0", typescript: "^5.0.0" },
      peerDependenciesMeta: { typescript: { optional: true } },
    }),
  ];
  expect(advise(details, { ranges: { typescript: "^4.0.0" } })).toEqual([]);
});

test("mentions deprecated versions, first line only", () => {
  const details = [
    upgrade("request", {
      version: "2.88.2",
      deprecated: "request has been deprecated\nsee issue",
    }),
  ];
  expect(advise(details, { ranges: {} })).toEqual([
    "request 2.88.2 is deprecated: request has been deprecated",
  ]);
});

test("says nothing about packages that aren't being upgraded", () => {
  const details: DependencyInfo[] = [
    {
      ...upgrade("x", { version: "2.0.0", engines: { node: ">=99" } }),
      upgradeVersion: null,
    },
  ];
  expect(advise(details, { ranges: {}, nodeVersion: "20.0.0" })).toEqual([]);
});

test("normalises the many shapes of repository URLs", () => {
  const cases: [unknown, string | undefined][] = [
    [
      "git+https://github.com/expressjs/express.git",
      "https://github.com/expressjs/express",
    ],
    [{ url: "git://github.com/o/r.git" }, "https://github.com/o/r"],
    ["git+ssh://git@github.com/o/r.git", "https://github.com/o/r"],
    ["git@github.com:o/r.git", "https://github.com/o/r"],
    ["github:o/r", "https://github.com/o/r"],
    ["gitlab:o/r", "https://gitlab.com/o/r"],
    ["o/r", "https://github.com/o/r"],
    ["http://example.com/repo", "https://example.com/repo"],
    ["not a url", undefined],
    [undefined, undefined],
    [{ url: "" }, undefined],
  ];
  for (const [input, expected] of cases)
    expect(repositoryUrl(input)).toBe(expected);
});

test("points at the releases page where there is one", () => {
  expect(releaseNotesUrl("https://github.com/o/r")).toBe(
    "https://github.com/o/r/releases",
  );
  expect(releaseNotesUrl("https://gitlab.com/o/r")).toBe(
    "https://gitlab.com/o/r/-/releases",
  );
  expect(releaseNotesUrl("https://example.com/repo/")).toBe(
    "https://example.com/repo",
  );
});
