/**
 * Keeps the dependencies whose name matches one of the patterns. A pattern is a
 * package name, where `*` matches anything: `react`, `@types/*`, `eslint*`.
 * No patterns means everything.
 */
export function selectDependencies<T>(
  deps: Record<string, T>,
  patterns: string[],
): Record<string, T> {
  if (patterns.length === 0) return deps;
  const matchers = patterns.map(toRegExp);
  return Object.fromEntries(
    Object.entries(deps).filter(([name]) => matchers.some((m) => m.test(name))),
  );
}

function toRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}
