import { intersects, satisfies, subset, validRange } from "semver";
import type { DependencyInfo } from "./index.js";

export interface Project {
  /** Every dependency's range as it will be after the upgrade is applied. */
  ranges: Record<string, string>;
  /** The project's own `engines.node`, if declared. */
  nodeRange?: string;
  /** The Node that is running, used when the project declares no engines. */
  nodeVersion?: string;
}

/**
 * Things worth knowing before applying the offered upgrades, one line each:
 * deprecated versions, Node requirements the project doesn't meet, and peer
 * dependencies that the project's (post-upgrade) ranges don't satisfy.
 */
export interface Advice {
  /** The dependency the message is about. */
  name: string;
  message: string;
}

export function advise(details: DependencyInfo[], project: Project): Advice[] {
  const notes: Advice[] = [];

  for (const d of details) {
    if (!d.upgradeVersion || !d.meta) continue;
    const label = `${d.name} ${d.meta.version}`;
    const note = (message: string) => notes.push({ name: d.name, message });

    if (d.meta.deprecated) {
      note(`${label} is deprecated: ${firstLine(d.meta.deprecated)}`);
    }

    const node = d.meta.engines?.node;
    if (node && validRange(node)) {
      if (project.nodeRange && validRange(project.nodeRange)) {
        if (!subset(project.nodeRange, node)) {
          note(
            `${label} needs Node ${node}; your engines allow ${project.nodeRange}`,
          );
        }
      } else if (project.nodeVersion && !satisfies(project.nodeVersion, node)) {
        note(`${label} needs Node ${node}; you run ${project.nodeVersion}`);
      }
    }

    for (const [peer, range] of Object.entries(d.meta.peerDependencies ?? {})) {
      if (d.meta.peerDependenciesMeta?.[peer]?.optional) continue;
      const have = project.ranges[peer];
      if (!have || !validRange(have) || !validRange(range)) continue;
      if (!intersects(have, range)) {
        note(`${label} wants ${peer} ${range}; you'd have ${have}`);
      }
    }
  }

  return notes;
}

const firstLine = (text: string) => {
  const line = text.split("\n")[0]!.trim();
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
};
