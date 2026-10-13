import { setTimeout as sleep } from "node:timers/promises";

export interface LookupOptions {
  registry?: string;
  fetch?: typeof fetch;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Returns a function that resolves a package name to its `latest` version
 * (`null` when the package doesn't exist). All lookups made through one
 * instance share a pause: when the registry answers 429, every in-flight
 * worker backs off, not just the one that got the response.
 */
export function createLookup({
  registry = DEFAULT_REGISTRY,
  fetch: fetchImpl = fetch,
}: LookupOptions = {}) {
  let pausedUntil = 0;

  return async function latestVersion(name: string): Promise<string | null> {
    const url = `${registry}/${name.replace("/", "%2F")}/latest`;

    for (let attempt = 1; ; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);

      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt === ATTEMPTS) throw new Error(describe(err));
        await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) {
        const body = (await res.json()) as { version?: string };
        return body.version ?? null;
      }
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
