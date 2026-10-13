import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import semver from "semver";

export interface DependencyInfo {
  name: string;
  currentRange: string;
  latestVersion: string | null;
  upgradeVersion: string | null;
  diffType: "major" | "minor" | "patch" | "none";
  error?: string;
  fromCache?: boolean;
}

export interface NCUResult {
  upgraded: Record<string, string>;
  details: DependencyInfo[];
  stats: {
    total: number;
    upgradedCount: number;
    timeMs: number;
    cacheHits: number;
  };
}

type Cache = Record<string, { version: string; checkedAt: number }>;

const REGISTRY = "https://registry.npmjs.org";
const CONCURRENCY = 30; // past ~30 parallel requests there's no measurable gain
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(os.tmpdir(), "fast-ncu-cache-v2.json");

function readCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Each entry carries its own timestamp, so an old entry expires on time even
// when newer ones are written next to it. Expired entries are dropped on write.
function writeCache(cache: Cache) {
  const now = Date.now();
  const fresh = Object.entries(cache).filter(
    ([, e]) => now - e.checkedAt < CACHE_TTL_MS,
  );
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(fresh)));
  } catch {
    // The cache is an optimisation; failing to write it is not an error.
  }
}

// Runs fn over items with at most `limit` calls in flight, keeping input order.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function getDiffType(
  range: string,
  latest: string,
): DependencyInfo["diffType"] {
  try {
    const min = semver.minVersion(range);
    if (!min || semver.gte(min, latest)) return "none";
    const diff = semver.diff(min, latest);
    if (diff === "major" || diff === "premajor") return "major";
    if (diff === "minor" || diff === "preminor") return "minor";
    return "patch";
  } catch {
    return "none"; // not a semver range: file:, workspace:, git URLs, npm: aliases
  }
}

// Keeps the range operator: ^1.2.0 -> ^2.0.0, ~1.2.0 -> ~1.3.0.
function withPrefix(range: string, version: string): string {
  if (range === "*") return "*";
  return (range.match(/^[~^>=\s]+/)?.[0] ?? "") + version;
}

function describe(
  name: string,
  currentRange: string,
  latestVersion: string | null,
): DependencyInfo {
  const diffType = latestVersion
    ? getDiffType(currentRange, latestVersion)
    : "none";
  const upgradeVersion =
    latestVersion && diffType !== "none"
      ? withPrefix(currentRange, latestVersion)
      : null;
  return { name, currentRange, latestVersion, upgradeVersion, diffType };
}

async function fetchLatestVersion(name: string): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2F")}/latest`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { version?: string }).version ?? null;
}

// `useCache: false` is for tests that mock the registry.
export async function checkUpdates(
  dependencies: Record<string, string>,
  { useCache = true }: { useCache?: boolean } = {},
): Promise<NCUResult> {
  const start = Date.now();
  const cache = useCache ? readCache() : {};
  let cacheHits = 0;
  let cacheChanged = false;

  const details = await mapLimit(
    Object.entries(dependencies),
    CONCURRENCY,
    async ([name, range]): Promise<DependencyInfo> => {
      // file:, workspace:, git and npm: specifiers aren't registry versions:
      // don't look them up (and don't send local package names to the registry).
      if (!semver.validRange(range)) return describe(name, range, null);
      const cached = cache[name];
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
        cacheHits++;
        return { ...describe(name, range, cached.version), fromCache: true };
      }
      try {
        const latest = await fetchLatestVersion(name);
        if (!latest)
          return { ...describe(name, range, null), error: "not found" };
        cache[name] = { version: latest, checkedAt: Date.now() };
        cacheChanged = true;
        return describe(name, range, latest);
      } catch (err) {
        return {
          ...describe(name, range, null),
          error: (err as Error).message,
        };
      }
    },
  );

  if (useCache && cacheChanged) writeCache(cache);

  const upgraded: Record<string, string> = {};
  for (const d of details)
    if (d.upgradeVersion) upgraded[d.name] = d.upgradeVersion;

  return {
    upgraded,
    details,
    stats: {
      total: details.length,
      upgradedCount: Object.keys(upgraded).length,
      timeMs: Date.now() - start,
      cacheHits,
    },
  };
}
