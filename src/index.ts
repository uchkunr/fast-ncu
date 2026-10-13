import {
  diff,
  gte,
  major,
  maxSatisfying,
  minVersion,
  minor,
  prerelease,
  validRange,
} from "semver";
import { fileCache, memoryCache, type VersionCache } from "./cache.js";
import {
  createRegistry,
  type Registry,
  type RegistryOptions,
} from "./registry.js";

export {
  defaultCacheFile,
  fileCache,
  memoryCache,
  type CacheEntry,
  type VersionCache,
} from "./cache.js";

/** How far an upgrade may go: anywhere, within the current major, or within the current minor. */
export type Target = "latest" | "minor" | "patch";

export interface DependencyInfo {
  name: string;
  currentRange: string;
  latestVersion: string | null;
  upgradeVersion: string | null;
  diffType: "major" | "minor" | "patch" | "none";
  /** With a minor/patch target: the latest version, which lies beyond the target. */
  heldBack?: string;
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

export interface CheckOptions extends RegistryOptions {
  /** Defaults to the on-disk cache shared by every project on the machine. */
  cache?: VersionCache;
  /** Defaults to "latest". */
  target?: Target;
}

// Measured against the public registry: more parallel requests than this
// doesn't make a run faster, it only makes rate limiting more likely.
const CONCURRENCY = 30;

export async function checkUpdates(
  dependencies: Record<string, string>,
  options: CheckOptions = {},
): Promise<NCUResult> {
  const start = Date.now();
  const cache = options.cache ?? defaultCache(options.registry);
  const registry = createRegistry(options);
  const target = options.target ?? "latest";
  let cacheHits = 0;

  const details = await mapLimit(
    Object.entries(dependencies),
    CONCURRENCY,
    async ([name, spec]): Promise<DependencyInfo> => {
      const dep = resolveSpec(name, spec);
      // file:, workspace: and git specifiers aren't registry versions, and a
      // wildcard (*, x, "") already allows whatever is latest.
      const normalized = validRange(dep.range);
      if (!normalized || normalized === "*") return unchanged(name, spec);

      try {
        const cached = cache.get(dep.lookupName);
        const latest = cached
          ? cached.version
          : await registry.latest(dep.lookupName);
        if (cached) cacheHits++;
        else
          cache.set(dep.lookupName, { version: latest, checkedAt: Date.now() });

        const info =
          latest === null
            ? { ...unchanged(name, spec), error: "not found" }
            : await resolveUpgrade(dep, latest, target, registry);
        return cached ? { ...info, fromCache: true } : info;
      } catch (err) {
        return { ...unchanged(name, spec), error: (err as Error).message };
      }
    },
  );
  await cache.flush();

  const upgraded: Record<string, string> = {};
  for (const d of details) {
    if (d.upgradeVersion) upgraded[d.name] = d.upgradeVersion;
  }

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

// The shared on-disk cache is keyed by package name, so it only makes sense for
// the public registry. If it can't be opened (no home directory), run without one.
function defaultCache(registry?: string): VersionCache {
  if (registry) return memoryCache();
  try {
    return fileCache();
  } catch {
    return memoryCache();
  }
}

interface Dep {
  name: string;
  spec: string; // as written in package.json
  range: string; // the semver part of it
  lookupName: string; // the package to ask the registry about
  prefix: string; // put back in front of the rewritten range
}

// "npm:debug@^3.0.0" (or "npm:@scope/pkg@^1") aliases another package: that one
// is looked up, and the alias prefix is kept on the rewritten range.
const ALIAS = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/;

function resolveSpec(name: string, spec: string): Dep {
  const alias = spec.match(ALIAS);
  if (!alias) return { name, spec, range: spec, lookupName: name, prefix: "" };
  const [, target, range] = alias as unknown as [string, string, string];
  return { name, spec, range, lookupName: target, prefix: `npm:${target}@` };
}

const unchanged = (name: string, currentRange: string): DependencyInfo => ({
  name,
  currentRange,
  latestVersion: null,
  upgradeVersion: null,
  diffType: "none",
});

async function resolveUpgrade(
  dep: Dep,
  latest: string,
  target: Target,
  registry: Registry,
): Promise<DependencyInfo> {
  if (target === "latest" || withinTarget(dep.range, latest, target)) {
    return fromVersion(dep, latest);
  }
  // `latest` lies beyond the target, so find the newest version inside it. This
  // is the only path that needs the version list; only these packages pay for it.
  const allowed = targetRange(dep.range, target);
  const best = allowed
    ? maxSatisfying(await registry.versions(dep.lookupName), allowed)
    : null;
  const info = best ? fromVersion(dep, best) : unchanged(dep.name, dep.spec);
  return { ...info, latestVersion: latest, heldBack: latest };
}

function withinTarget(range: string, version: string, target: Target) {
  const min = minVersion(range);
  if (!min) return true;
  if (major(version) !== min.major) return false;
  return target === "minor" || minor(version) === min.minor;
}

// The versions an upgrade may move within: the current major for `minor`,
// the current minor for `patch`.
function targetRange(range: string, target: Target): string | null {
  const min = minVersion(range);
  if (!min) return null;
  const ceiling =
    target === "minor"
      ? `${min.major + 1}.0.0-0`
      : `${min.major}.${min.minor + 1}.0-0`;
  return `>=${min.version} <${ceiling}`;
}

function fromVersion(dep: Dep, latestVersion: string): DependencyInfo {
  const diffType = classify(dep.range, latestVersion);
  const upgradeVersion =
    diffType === "none"
      ? null
      : dep.prefix + rewriteRange(dep.range, latestVersion);
  // e.g. "4.x" already covers 4.21.2: a rewrite that changes nothing is no upgrade.
  if (upgradeVersion === null || upgradeVersion === dep.spec) {
    return { ...unchanged(dep.name, dep.spec), latestVersion };
  }
  return {
    name: dep.name,
    currentRange: dep.spec,
    latestVersion,
    upgradeVersion,
    diffType,
  };
}

// How far `latest` is beyond the lowest version the range allows.
function classify(range: string, latest: string): DependencyInfo["diffType"] {
  try {
    const min = minVersion(range);
    if (!min || gte(min, latest)) return "none";
    // A pre-release tagged as latest (a mis-tagged beta) is only offered to
    // ranges that are already on a pre-release.
    if (prerelease(latest) && min.prerelease.length === 0) return "none";
    const kind = diff(min, latest);
    if (kind === "major" || kind === "premajor") return "major";
    if (kind === "minor" || kind === "preminor") return "minor";
    return "patch";
  } catch {
    return "none";
  }
}

// Points the range at `version` while keeping its shape:
//   ^1.2.0 -> ^2.0.0   ~1.2.0 -> ~1.3.0   >=1.0.0 -> >=2.0.0   1.2.3 -> 2.0.0
//   1.x -> 2.x   1.2.x -> 2.1.x   1 -> 2
// A bare ">" would exclude the very version we're upgrading to, so it becomes ">=".
// A range made of several comparators (">=4 <5", "^5 || ^6", "1.0.0 - 2.0.0") has
// no single operator to keep, so it becomes a caret range, like npm-check-updates.
function rewriteRange(range: string, version: string): string {
  if (isCompound(range)) return `^${version}`;
  const xRange = rewriteXRange(range.trim(), version);
  if (xRange) return xRange;
  const prefix = range.match(/^[~^>=\s]+/)?.[0] ?? "";
  return prefix.replace(/^>(?!=)/, ">=") + version;
}

const isCompound = (range: string) =>
  /\|\||\s+-\s+|\s+(?=[<>=~^])/.test(range.trim());

// "1.x", "1.2.x", "1.*", "1", "1.2": keep the wildcard part, replace the numbers.
function rewriteXRange(range: string, version: string): string | undefined {
  const parts = range.split(".");
  if (parts.length > 3 || !parts.every((p) => /^(\d+|[xX*])$/.test(p))) return;
  const wildcardAt = parts.findIndex((p) => !/^\d+$/.test(p));
  const numeric = wildcardAt === -1 ? parts.length : wildcardAt;
  if (numeric === 3) return; // a plain version, not an x-range
  return [
    ...version.split(".").slice(0, numeric),
    ...parts.slice(numeric),
  ].join(".");
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
      results[i] = await fn(items[i]!);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
