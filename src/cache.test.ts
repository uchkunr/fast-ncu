/// <reference types="bun" />
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CACHE_TTL_MS, fileCache } from "./cache.js";

// A file in a directory that doesn't exist yet, so flush has to create it.
const tempFile = () =>
  path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "fast-ncu-test-")),
    "nested",
    "versions.json",
  );

const now = () => Date.now();

test("round-trips entries through the file", async () => {
  const file = tempFile();
  const cache = fileCache(file);
  cache.set("x", { version: "1.0.0", checkedAt: now() });
  await cache.flush();
  expect(fileCache(file).get("x")?.version).toBe("1.0.0");
});

test("keeps entries written by a concurrent run", async () => {
  const file = tempFile();
  const a = fileCache(file);
  const b = fileCache(file); // opened before either has written
  a.set("x", { version: "1.0.0", checkedAt: now() });
  b.set("y", { version: "2.0.0", checkedAt: now() });
  await a.flush();
  await b.flush();
  const c = fileCache(file);
  expect(c.get("x")?.version).toBe("1.0.0");
  expect(c.get("y")?.version).toBe("2.0.0");
});

test("expires entries after the TTL and drops them on write", async () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const expired = { version: "0.1.0", checkedAt: now() - CACHE_TTL_MS - 1 };
  fs.writeFileSync(file, JSON.stringify({ old: expired }));

  const cache = fileCache(file);
  expect(cache.get("old")).toBeUndefined();
  cache.set("new", { version: "1.0.0", checkedAt: now() });
  await cache.flush();
  expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")))).toEqual([
    "new",
  ]);
});

test("treats a corrupt file as empty", async () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  const cache = fileCache(file);
  expect(cache.get("x")).toBeUndefined();
  cache.set("x", { version: "1.0.0", checkedAt: now() });
  await cache.flush();
  expect(fileCache(file).get("x")?.version).toBe("1.0.0");
});

test("leaves the file untouched when nothing changed", async () => {
  const file = tempFile();
  await fileCache(file).flush();
  expect(fs.existsSync(file)).toBe(false);
});
