/** What is kept about a package version besides its number: enough to warn before an upgrade. */
export interface PackageMeta {
  /** Normalised https URL of the source repository, when the manifest has one. */
  repository?: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  deprecated?: string;
}

export interface VersionInfo extends PackageMeta {
  version: string;
}
