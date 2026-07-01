import semver from 'semver';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface DependencyInfo {
  name: string;
  currentRange: string;
  latestVersion: string | null;
  upgradeVersion: string | null;
  diffType: 'major' | 'minor' | 'patch' | 'none';
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

interface CacheData {
  timestamp: number;
  versions: Record<string, string>;
}

const CACHE_FILE = path.join(os.tmpdir(), 'fast-ncu-cache.json');
const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function loadCache(ttl: number): Record<string, string> {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const content = fs.readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(content) as CacheData;
      if (Date.now() - data.timestamp < ttl) {
        return data.versions || {};
      }
    }
  } catch {}
  return {};
}

function saveCache(versions: Record<string, string>) {
  try {
    const data: CacheData = {
      timestamp: Date.now(),
      versions
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {}
}

// Zero-dependency concurrency limiter helper
async function pLimit<T>(concurrency: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];
  let i = 0;
  
  async function runTask(taskIndex: number) {
    results[taskIndex] = await tasks[taskIndex]();
  }

  const enqueue = async (): Promise<void> => {
    if (i === tasks.length) return;
    const currentIdx = i++;
    const promise = runTask(currentIdx).then(() => {
      executing.splice(executing.indexOf(promise), 1);
    });
    executing.push(promise);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
    await enqueue();
  };

  await enqueue();
  await Promise.all(executing);
  return results;
}

function preservePrefix(range: string, latestVersion: string): string {
  if (range === '*') return '*';
  const match = range.match(/^([~^>=\s]+)/);
  const prefix = match ? match[1] : '';
  return `${prefix}${latestVersion}`;
}

function getDiffType(currentRange: string, latest: string): 'major' | 'minor' | 'patch' | 'none' {
  try {
    const minVer = semver.minVersion(currentRange);
    if (!minVer) return 'none';
    
    if (semver.eq(minVer.version, latest)) return 'none';
    if (semver.gt(minVer.version, latest)) return 'none';

    const diff = semver.diff(minVer.version, latest);
    if (diff === 'major' || diff === 'premajor') return 'major';
    if (diff === 'minor' || diff === 'preminor') return 'minor';
    if (diff === 'patch' || diff === 'prepatch' || diff === 'prerelease') return 'patch';
    return 'none';
  } catch {
    return 'none';
  }
}

// Fetch the latest version from npm registry
async function fetchLatestVersion(name: string): Promise<string | null> {
  const encodedName = name.startsWith('@') 
    ? `@${encodeURIComponent(name.substring(1))}` 
    : encodeURIComponent(name);
  const url = `https://registry.npmjs.org/${encodedName}/latest`;

  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Registry responded with status ${response.status}`);
    }

    const data = (await response.json()) as { version?: string };
    return data.version || null;
  } catch (err: any) {
    throw new Error(`Failed to fetch: ${err.message}`);
  }
}

export async function checkUpdates(
  dependencies: Record<string, string>,
  options: {
    concurrency?: number;
    useCache?: boolean;
    cacheTtl?: number;
  } = {}
): Promise<NCUResult> {
  const startTime = Date.now();
  const concurrency = options.concurrency ?? 15;
  const useCache = options.useCache ?? true;
  const cacheTtl = options.cacheTtl ?? DEFAULT_CACHE_TTL;

  const cache = useCache ? loadCache(cacheTtl) : {};
  let cacheHits = 0;
  const newVersionsToCache: Record<string, string> = { ...cache };

  const depNames = Object.keys(dependencies);
  
  const tasks = depNames.map((name) => async (): Promise<DependencyInfo> => {
    const currentRange = dependencies[name];
    
    // Check cache first
    if (useCache && cache[name]) {
      cacheHits++;
      const latest = cache[name];
      const diffType = getDiffType(currentRange, latest);
      const upgradeVersion = diffType !== 'none' ? preservePrefix(currentRange, latest) : null;
      return {
        name,
        currentRange,
        latestVersion: latest,
        upgradeVersion,
        diffType,
        fromCache: true
      };
    }

    try {
      const latest = await fetchLatestVersion(name);
      if (!latest) {
        return { name, currentRange, latestVersion: null, upgradeVersion: null, diffType: 'none', error: 'Not found in registry' };
      }
      
      const diffType = getDiffType(currentRange, latest);
      const upgradeVersion = diffType !== 'none' ? preservePrefix(currentRange, latest) : null;

      if (useCache) {
        newVersionsToCache[name] = latest;
      }

      return {
        name,
        currentRange,
        latestVersion: latest,
        upgradeVersion,
        diffType
      };
    } catch (err: any) {
      return {
        name,
        currentRange,
        latestVersion: null,
        upgradeVersion: null,
        diffType: 'none',
        error: err.message
      };
    }
  });

  const details = await pLimit(concurrency, tasks);
  
  // Save updated cache if we fetched new packages
  if (useCache && Object.keys(newVersionsToCache).length > Object.keys(cache).length) {
    saveCache(newVersionsToCache);
  }

  const upgraded: Record<string, string> = {};
  let upgradedCount = 0;

  for (const info of details) {
    if (info.upgradeVersion) {
      upgraded[info.name] = info.upgradeVersion;
      upgradedCount++;
    }
  }

  return {
    upgraded,
    details,
    stats: {
      total: depNames.length,
      upgradedCount,
      timeMs: Date.now() - startTime,
      cacheHits
    }
  };
}
