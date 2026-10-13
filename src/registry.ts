import { setTimeout as sleep } from "node:timers/promises";
import { repositoryUrl } from "./links.js";
import type { VersionInfo } from "./types.js";

export interface RegistryOptions {
  registry?: string;
  fetch?: typeof fetch;
}

export interface Registry {
  /** The version behind the `latest` dist-tag, or null when the package doesn't exist. */
  latest(name: string): Promise<VersionInfo | null>;
  /** Every published version, deprecated ones flagged; empty when the package doesn't exist. */
  versions(name: string): Promise<VersionInfo[]>;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
// The abbreviated packument: versions and dist-tags without readmes or history.
const ABBREVIATED = "application/vnd.npm.install-v1+json";
const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 30_000;

interface Manifest {
  version?: string;
  repository?: unknown;
  homepage?: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  deprecated?: string;
}

/**
 * All requests made through one registry share a pause: when it answers 429,
 * every in-flight worker backs off, not just the one that got the response.
 */
export function createRegistry({
  registry = DEFAULT_REGISTRY,
  fetch: fetchImpl = fetch,
}: RegistryOptions = {}): Registry {
  let pausedUntil = 0;

  async function get<T>(path: string, accept: string): Promise<T | null> {
    for (let attempt = 1; ; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);

      let res: Response;
      try {
        res = await fetchImpl(`${registry}${path}`, {
          headers: { accept },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt === ATTEMPTS) throw new Error(describe(err));
        await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) return null;

      const retryable = res.status === 429 || res.status >= 500;
      const delay =
        retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt);
      if (!retryable || attempt === ATTEMPTS || delay > MAX_RETRY_AFTER_MS) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (res.status === 429) {
        pausedUntil = Math.max(pausedUntil, Date.now() + delay);
      } else {
        await sleep(delay);
      }
    }
  }

  const encode = (name: string) => name.replace("/", "%2F");

  return {
    async latest(name) {
      const manifest = await get<Manifest>(
        `/${encode(name)}/latest`,
        "application/json",
      );
      return manifest ? toInfo(manifest) : null;
    },
    async versions(name) {
      const doc = await get<{ versions?: Record<string, Manifest> }>(
        `/${encode(name)}`,
        ABBREVIATED,
      );
      return Object.values(doc?.versions ?? {})
        .map(toInfo)
        .filter((v): v is VersionInfo => v !== null);
    },
  };
}

// Keeps only what an upgrade decision needs; undefined fields are left out so
// the cache file stays small.
function toInfo(m: Manifest): VersionInfo | null {
  if (!m.version) return null;
  const info: VersionInfo = { version: m.version };
  const repository = repositoryUrl(m.repository) ?? repositoryUrl(m.homepage);
  if (repository) info.repository = repository;
  if (m.engines?.node) info.engines = { node: m.engines.node };
  if (m.peerDependencies && Object.keys(m.peerDependencies).length > 0) {
    info.peerDependencies = m.peerDependencies;
    if (m.peerDependenciesMeta)
      info.peerDependenciesMeta = m.peerDependenciesMeta;
  }
  if (m.deprecated) info.deprecated = m.deprecated;
  return info;
}

// 500 ms, 1 s, 2 s... plus up to 200 ms of jitter so retries don't line up.
const backoff = (attempt: number) =>
  500 * 2 ** (attempt - 1) + Math.random() * 200;

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// Node wraps network failures as TypeError("fetch failed") with the real error
// (and its code, e.g. ECONNREFUSED) on `cause`; Bun puts the code on the error itself.
function describe(err: unknown): string {
  const e = err as {
    name?: string;
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  if (e.name === "TimeoutError") return "timed out";
  return (
    e.cause?.code ?? e.code ?? e.cause?.message ?? e.message ?? String(err)
  );
}
