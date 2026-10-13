const HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/**
 * Turns the many shapes of package.json `repository` into a plain https URL:
 * "git+https://github.com/o/r.git", "git@github.com:o/r.git", "github:o/r",
 * "o/r", { url }. Returns undefined for anything that isn't a web URL.
 */
export function repositoryUrl(repository: unknown): string | undefined {
  const raw =
    typeof repository === "string"
      ? repository
      : (repository as { url?: unknown } | undefined)?.url;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;

  const url = raw.trim();
  const short = url.match(
    /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/,
  );
  if (short) return `https://${HOSTS[short[1] ?? "github"]}/${short[2]}`;

  const stripped = url.replace(/^git\+/, "").replace(/\.git$/, "");
  const scp = stripped.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/); // git@github.com:o/r
  if (scp) return `https://${scp[1]}/${scp[2]}`;

  const https = stripped
    .replace(/^(?:git|ssh)(?:\+ssh)?:\/\/(?:git@)?/, "https://")
    .replace(/^http:\/\//, "https://");
  return https.startsWith("https://") ? https : undefined;
}

/** Where a human reads what changed: the releases page on GitHub/GitLab, the repo otherwise. */
export function releaseNotesUrl(repository: string): string {
  const url = repository.replace(/\/+$/, "");
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url))
    return `${url}/releases`;
  if (/^https:\/\/gitlab\.com\/.+$/.test(url)) return `${url}/-/releases`;
  return url;
}
