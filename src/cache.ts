import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CacheEntry {
  /** `null` means the registry said the package doesn't exist. */
  version: string | null;
  checkedAt: number;
}

export interface VersionCache {
  /** A fresh entry, or undefined when there is none or it has expired. */
  get(name: string): CacheEntry | undefined;
  set(name: string, entry: CacheEntry): void;
  /** Persist what was set. Called once per run. */
  flush(): Promise<void>;
}

// The registry serves /latest with Cache-Control: max-age=300, so this is as long
// as it is safe to keep a version without asking again.
export const CACHE_TTL_MS = 5 * 60 * 1000;

const fresh = (entry?: CacheEntry) =>
  entry && Date.now() - entry.checkedAt < CACHE_TTL_MS ? entry : undefined;

export function memoryCache(
  entries: Record<string, CacheEntry> = {},
): VersionCache {
  return {
    get: (name) => fresh(entries[name]),
    set(name, entry) {
      entries[name] = entry;
    },
    flush: async () => {},
  };
}

/** One JSON file shared by every project on the machine. */
export function fileCache(file = defaultCacheFile()): VersionCache {
  const loaded = readEntries(file);
  const changed: Record<string, CacheEntry> = {};
  return {
    get: (name) => fresh(changed[name] ?? loaded[name]),
    set(name, entry) {
      changed[name] = entry;
    },
    async flush() {
      if (Object.keys(changed).length === 0) return;
      // Re-read before writing so entries added by a concurrent run survive, then
      // write to a temp file and rename: a reader never sees a half-written file.
      const merged = Object.entries({ ...readEntries(file), ...changed });
      const kept = Object.fromEntries(merged.filter(([, e]) => fresh(e)));
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(kept));
        fs.renameSync(tmp, file);
      } catch {
        // The cache is an optimisation; failing to write it is not an error.
      }
    },
  };
}

function readEntries(file: string): Record<string, CacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function defaultCacheFile(): string {
  const home = os.homedir();
  const dir =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Caches")
        : process.env.XDG_CACHE_HOME || path.join(home, ".cache");
  return path.join(dir, "fast-ncu", "versions.json");
}
