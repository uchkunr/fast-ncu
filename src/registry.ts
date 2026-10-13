import { setTimeout as sleep } from "node:timers/promises";

export interface RegistryOptions {
  registry?: string;
  fetch?: typeof fetch;
}

export interface Registry {
  /** The `latest` dist-tag, or null when the package doesn't exist. */
  latest(name: string): Promise<string | null>;
  /** Every published, non-deprecated version; empty when the package doesn't exist. */
  versions(name: string): Promise<string[]>;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
// The abbreviated packument: versions and dist-tags without readmes or history.
const ABBREVIATED = "application/vnd.npm.install-v1+json";
const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 30_000;

type Packument = { versions?: Record<string, { deprecated?: string }> };

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
      const body = await get<{ version?: string }>(
        `/${encode(name)}/latest`,
        "application/json",
      );
      return body?.version ?? null;
    },
    async versions(name) {
      const doc = await get<Packument>(`/${encode(name)}`, ABBREVIATED);
      return Object.entries(doc?.versions ?? {})
        .filter(([, v]) => !v.deprecated)
        .map(([version]) => version);
    },
  };
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
