/// <reference types="bun" />
import { expect, test } from "bun:test";
import { checkUpdates, memoryCache, type VersionCache } from "./index.js";

type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** A fake registry: one reply per package, or a sequence whose last reply repeats. */
function registry(replies: Record<string, Reply | Reply[]>) {
  const calls: string[] = [];
  const startedAt: Record<string, number[]> = {};
  const fetchImpl = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname; // "/typescript/latest"
    const name = decodeURIComponent(path.slice(1, -"/latest".length));
    calls.push(name);
    (startedAt[name] ??= []).push(Date.now());
    const script = replies[name];
    const reply = Array.isArray(script)
      ? script.length > 1
        ? script.shift()!
        : script[0]
      : script;
    if (!reply) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { calls, startedAt, fetch: fetchImpl as typeof fetch };
}

const latest = (version: string): Reply => ({ body: { version } });

async function run(
  deps: Record<string, string>,
  replies: Record<string, Reply | Reply[]>,
  cache: VersionCache = memoryCache(),
) {
  const reg = registry(replies);
  const result = await checkUpdates(deps, { cache, fetch: reg.fetch });
  return { ...result, calls: reg.calls, startedAt: reg.startedAt };
}

test("upgrades to latest and keeps the range operator", async () => {
  const { upgraded, details } = await run(
    {
      typescript: "^5.0.0",
      semver: "~7.0.0",
      lodash: ">=4.17.0",
      react: "^19.3.0",
    },
    {
      typescript: latest("5.3.3"),
      semver: latest("7.8.5"),
      lodash: latest("4.18.1"),
      react: latest("19.3.0"),
    },
  );
  expect(upgraded).toEqual({
    typescript: "^5.3.3",
    semver: "~7.8.5",
    lodash: ">=4.18.1",
  });
  const byName = Object.fromEntries(details.map((d) => [d.name, d.diffType]));
  expect(byName).toEqual({
    typescript: "minor",
    semver: "minor",
    lodash: "minor",
    react: "none",
  });
});

test("classifies major, minor and patch upgrades", async () => {
  const { details } = await run(
    { a: "^4.0.0", b: "^4.0.0", c: "^4.0.0" },
    { a: latest("5.0.0"), b: latest("4.1.0"), c: latest("4.0.1") },
  );
  expect(details.map((d) => d.diffType)).toEqual(["major", "minor", "patch"]);
});

test("reports packages the registry doesn't know", async () => {
  const { upgraded, details } = await run({ ghost: "^1.0.0" }, {});
  expect(upgraded).toEqual({});
  expect(details[0]).toMatchObject({
    error: "not found",
    upgradeVersion: null,
  });
});

test("never asks the registry about non-registry specifiers", async () => {
  const { calls, details } = await run(
    {
      local: "file:../lib",
      ws: "workspace:*",
      gh: "github:user/repo",
    },
    {},
  );
  expect(calls).toEqual([]);
  expect(details.every((d) => d.diffType === "none" && !d.error)).toBe(true);
});

test("serves fresh cache entries without a request", async () => {
  const cache = memoryCache({
    typescript: { version: "5.3.3", checkedAt: Date.now() },
  });
  const { calls, upgraded, details, stats } = await run(
    { typescript: "^5.0.0" },
    {},
    cache,
  );
  expect(calls).toEqual([]);
  expect(upgraded).toEqual({ typescript: "^5.3.3" });
  expect(details[0]?.fromCache).toBe(true);
  expect(stats.cacheHits).toBe(1);
});

test("ignores expired cache entries", async () => {
  const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
  const cache = memoryCache({
    typescript: { version: "5.0.0", checkedAt: sixMinutesAgo },
  });
  const { calls, upgraded } = await run(
    { typescript: "^5.0.0" },
    { typescript: latest("5.3.3") },
    cache,
  );
  expect(calls).toEqual(["typescript"]);
  expect(upgraded).toEqual({ typescript: "^5.3.3" });
});

test("caches 'not found' as well", async () => {
  const cache = memoryCache();
  await run({ ghost: "^1.0.0" }, {}, cache);
  const { calls, details } = await run({ ghost: "^1.0.0" }, {}, cache);
  expect(calls).toEqual([]);
  expect(details[0]).toMatchObject({ error: "not found", fromCache: true });
});

test("retries after 429, honouring Retry-After", async () => {
  const { calls, upgraded } = await run(
    { typescript: "^5.0.0" },
    {
      typescript: [
        { status: 429, headers: { "retry-after": "0" } },
        latest("5.3.3"),
      ],
    },
  );
  expect(calls).toEqual(["typescript", "typescript"]);
  expect(upgraded).toEqual({ typescript: "^5.3.3" });
});

test("gives up after three attempts on server errors", async () => {
  const { calls, details } = await run(
    { typescript: "^5.0.0" },
    { typescript: { status: 503, headers: { "retry-after": "0" } } },
  );
  expect(calls).toHaveLength(3);
  expect(details[0]?.error).toBe("HTTP 503");
});

test("does not retry client errors", async () => {
  const { calls, details } = await run(
    { typescript: "^5.0.0" },
    { typescript: { status: 403 } },
  );
  expect(calls).toHaveLength(1);
  expect(details[0]?.error).toBe("HTTP 403");
});

test("leaves wildcard ranges alone without asking the registry", async () => {
  const { calls, upgraded, details } = await run(
    { a: "*", b: "x", c: "" },
    { a: latest("9.0.0"), b: latest("9.0.0"), c: latest("9.0.0") },
  );
  expect(calls).toEqual([]);
  expect(upgraded).toEqual({});
  expect(details.every((d) => d.diffType === "none" && !d.error)).toBe(true);
});

test("turns a bare > into >= so the new version is included", async () => {
  const { upgraded } = await run(
    { a: ">1.0.0", b: ">=1.0.0", c: "> 1.0.0" },
    { a: latest("5.3.3"), b: latest("5.3.3"), c: latest("5.3.3") },
  );
  expect(upgraded).toEqual({ a: ">=5.3.3", b: ">=5.3.3", c: ">= 5.3.3" });
});

test("does not wait for a Retry-After beyond 30 seconds", async () => {
  const { calls, details } = await run(
    { a: "^1.0.0" },
    { a: { status: 429, headers: { "retry-after": "3600" } } },
  );
  expect(calls).toHaveLength(1);
  expect(details[0]?.error).toBe("HTTP 429");
});

test("accepts an HTTP-date Retry-After", async () => {
  const { calls, upgraded } = await run(
    { a: "^1.0.0" },
    {
      a: [
        {
          status: 429,
          headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
        },
        latest("1.2.0"),
      ],
    },
  );
  expect(calls).toHaveLength(2);
  expect(upgraded).toEqual({ a: "^1.2.0" });
});

test("a 429 pauses every worker, not just the one that got it", async () => {
  // 31 packages: the 31st can only start once a worker is free, by which time
  // the first package's 429 has set a 300 ms pause that the 31st must respect.
  const names = Array.from({ length: 31 }, (_, i) => `p${i}`);
  const deps = Object.fromEntries(names.map((n) => [n, "^1.0.0"]));
  const replies: Record<string, Reply | Reply[]> = Object.fromEntries(
    names.map((n) => [n, latest("1.0.0")]),
  );
  replies.p0 = [
    { status: 429, headers: { "retry-after": "0.3" } },
    latest("1.0.0"),
  ];
  const start = Date.now();
  const { startedAt, details } = await run(deps, replies);
  expect(details.every((d) => !d.error)).toBe(true);
  expect(startedAt.p30![0]! - start).toBeGreaterThanOrEqual(250);
  expect(startedAt.p0![1]! - start).toBeGreaterThanOrEqual(250);
});

test("keeps the shape of x-ranges and plain versions", async () => {
  const { upgraded, details } = await run(
    { a: "1.x", b: "1.2.x", c: "1", d: "1.*", e: "1.2.3", f: "1.2" },
    Object.fromEntries(
      ["a", "b", "c", "d", "e", "f"].map((n) => [n, latest("2.1.3")]),
    ),
  );
  expect(upgraded).toEqual({
    a: "2.x",
    b: "2.1.x",
    c: "2",
    d: "2.*",
    e: "2.1.3",
    f: "2.1",
  });
  expect(details.every((d) => d.diffType === "major")).toBe(true);
});

test("ignores a pre-release tagged as latest unless the range is on a pre-release", async () => {
  const { upgraded, details } = await run(
    { stable: "^1.0.0", beta: "^2.0.0-beta.1" },
    { stable: latest("2.0.0-beta.3"), beta: latest("2.0.0-beta.3") },
  );
  expect(upgraded).toEqual({ beta: "^2.0.0-beta.3" });
  expect(details.find((d) => d.name === "stable")?.diffType).toBe("none");
});

test("turns compound ranges into a caret range, like npm-check-updates", async () => {
  const { upgraded } = await run(
    {
      a: ">=4.0.0 <5.0.0",
      b: "^5.0.0 || ^6.0.0",
      c: "1.0.0 - 2.0.0",
      d: ">= 1.0.0",
    },
    Object.fromEntries(["a", "b", "c", "d"].map((n) => [n, latest("7.0.2")])),
  );
  expect(upgraded).toEqual({
    a: "^7.0.2",
    b: "^7.0.2",
    c: "^7.0.2",
    d: ">= 7.0.2",
  });
});

test("follows npm: aliases to the real package and keeps the alias", async () => {
  const { calls, upgraded, details } = await run(
    {
      dbg: "npm:debug@^3.0.0",
      types: "npm:@types/node@^18.0.0",
      pinned: "npm:ms@*",
    },
    {
      debug: latest("4.4.3"),
      "@types/node": latest("20.0.0"),
      ms: latest("2.1.3"),
    },
  );
  expect(calls.sort()).toEqual(["@types/node", "debug"]);
  expect(upgraded).toEqual({
    dbg: "npm:debug@^4.4.3",
    types: "npm:@types/node@^20.0.0",
  });
  expect(details.find((d) => d.name === "dbg")?.currentRange).toBe(
    "npm:debug@^3.0.0",
  );
});
