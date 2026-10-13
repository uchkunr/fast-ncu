#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { checkUpdates, type DependencyInfo } from "./index.js";

const HELP = `${pc.bold("fncu")}: find newer versions of your dependencies

  -u, --upgrade    write upgrades to package.json
  -v, --version    print version
  -h, --help       print help`;

const DEP_FIELDS = ["dependencies", "devDependencies"] as const;
const ORDER = { major: 0, minor: 1, patch: 2, none: 3 };
const COLOR = {
  major: pc.red,
  minor: pc.yellow,
  patch: pc.green,
  none: pc.gray,
};
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

function fail(message: string): never {
  console.error(pc.red(message));
  process.exit(1);
}

function parseOptions() {
  try {
    return parseArgs({
      options: {
        upgrade: { type: "boolean", short: "u" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
  } catch (err) {
    // parseArgs messages are long; the first sentence says what's wrong.
    fail(`${(err as Error).message.split(". ")[0]}. See fncu --help`);
  }
}

function packageManager(): string {
  const lockfile = LOCKFILES.find(([file]) => fs.existsSync(file));
  if (lockfile) return lockfile[1];
  // e.g. "pnpm/9.12.0 npm/? node/v22.11.0" when run through a package manager
  const agent = process.env.npm_config_user_agent?.split("/")[0] ?? "";
  return ["pnpm", "yarn", "bun"].includes(agent) ? agent : "npm";
}

function printTable(rows: DependencyInfo[]) {
  const header = ["Package", "Current", "Latest", "Type"];
  const cells = rows.map((d) => [
    d.name,
    d.currentRange,
    d.upgradeVersion ?? "",
    d.diffType,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...cells.map((c) => c[i].length)),
  );
  const border = (left: string, mid: string, right: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  const line = (cols: string[], paint: (text: string, i: number) => string) =>
    `│${cols.map((c, i) => ` ${paint(c.padEnd(widths[i]), i)} `).join("│")}│`;

  console.log(border("┌", "┬", "┐"));
  console.log(line(header, pc.bold));
  console.log(border("├", "┼", "┤"));
  rows.forEach((d, r) => {
    const paints = [pc.cyan, pc.gray, COLOR[d.diffType], COLOR[d.diffType]];
    console.log(line(cells[r], (text, i) => paints[i](text)));
  });
  console.log(border("└", "┴", "┘"));
}

async function main() {
  const options = parseOptions();

  if (options.help) return console.log(HELP);
  if (options.version) {
    const pkgUrl = new URL("../package.json", import.meta.url);
    return console.log(JSON.parse(fs.readFileSync(pkgUrl, "utf8")).version);
  }

  const file = path.resolve("package.json");
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException;
    fail(
      code === "ENOENT"
        ? "No package.json here"
        : `Bad package.json: ${message}`,
    );
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (Object.keys(deps).length === 0) return console.log("No dependencies");

  const result = await checkUpdates(deps);
  const upgrades = result.details
    .filter((d) => d.diffType !== "none")
    .sort((a, b) => ORDER[a.diffType] - ORDER[b.diffType]);
  const failed = result.details.filter((d) => d.error);
  const time = pc.dim(`${result.stats.timeMs}ms`);

  if (upgrades.length === 0) {
    console.log(`${pc.green("Up to date")} ${time}`);
  } else {
    printTable(upgrades);
    if (options.upgrade) {
      for (const field of DEP_FIELDS) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          if (result.upgraded[name]) pkg[field]![name] = result.upgraded[name];
        }
      }
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
      const install = pc.cyan(`${packageManager()} install`);
      console.log(`\n${pc.green("Updated.")} Run ${install} ${time}`);
    } else {
      console.log(`\nRun ${pc.cyan("fncu -u")} to upgrade ${time}`);
    }
  }

  if (failed.length > 0) {
    console.log(pc.yellow(`\nCouldn't check ${failed.length}:`));
    for (const d of failed) console.log(`  ${d.name} ${pc.dim(d.error!)}`);
  }
}

main().catch((err: Error) => fail(err.message));
