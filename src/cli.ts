#!/usr/bin/env node

import fs from "node:fs";
import { parseArgs } from "node:util";
import { version } from "../package.json";
import { checkUpdates, type DependencyInfo } from "./index.js";

// The usual rules: NO_COLOR disables, FORCE_COLOR overrides, otherwise only on a TTY.
const colors =
  process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== "0"
    : !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
const paint = (open: number, close: number) => (text: string) =>
  colors ? `\x1b[${open}m${text}\x1b[${close}m` : text;
const bold = paint(1, 22);
const dim = paint(2, 22);
const red = paint(31, 39);
const green = paint(32, 39);
const yellow = paint(33, 39);
const cyan = paint(36, 39);
const gray = paint(90, 39);

const HELP = `${bold("fncu")}: find newer versions of your dependencies

  -u, --upgrade    write upgrades to package.json
  -v, --version    print version
  -h, --help       print help`;

const DEP_FIELDS = ["dependencies", "devDependencies"] as const;
const ORDER = { major: 0, minor: 1, patch: 2, none: 3 };
const COLOR = { major: red, minor: yellow, patch: green, none: gray };
const LOCKFILES: [file: string, manager: string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

type Manifest = Record<string, Record<string, string> | undefined>;

function fail(message: string): never {
  console.error(red(message));
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

// Keeps the file's own indentation, line endings and trailing newline, so an
// upgrade shows up in the diff as the changed versions and nothing else.
function serializeLike(original: string, manifest: Manifest): string {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? "  ";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /\r?\n$/.test(original) ? eol : "";
  return (
    JSON.stringify(manifest, null, indent).replaceAll("\n", eol) + trailing
  );
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
    Math.max(h.length, ...cells.map((c) => c[i]!.length)),
  );
  const border = (left: string, mid: string, right: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  const line = (cols: string[], paint: (text: string, i: number) => string) =>
    `│${cols.map((c, i) => ` ${paint(c.padEnd(widths[i]!), i)} `).join("│")}│`;

  console.log(border("┌", "┬", "┐"));
  console.log(line(header, bold));
  console.log(border("├", "┼", "┤"));
  rows.forEach((d, r) => {
    const paints = [cyan, gray, COLOR[d.diffType], COLOR[d.diffType]];
    console.log(line(cells[r]!, (text, i) => paints[i]!(text)));
  });
  console.log(border("└", "┴", "┘"));
}

async function main() {
  const options = parseOptions();
  if (options.help) return console.log(HELP);
  if (options.version) return console.log(version);

  const file = "package.json";
  if (!fs.existsSync(file)) fail("No package.json here");
  let text: string;
  let manifest: Manifest;
  try {
    text = fs.readFileSync(file, "utf8");
    manifest = JSON.parse(text);
  } catch (err) {
    fail(`Bad package.json: ${(err as Error).message}`);
  }

  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  if (Object.keys(deps).length === 0) return console.log("No dependencies");

  const result = await checkUpdates(deps);
  const upgrades = result.details
    .filter((d) => d.diffType !== "none")
    .sort((a, b) => ORDER[a.diffType] - ORDER[b.diffType]);
  const failed = result.details.filter((d) => d.error);
  // "not found" is an answer from the registry; the others mean we couldn't ask it.
  const unreachable = failed.filter((d) => d.error !== "not found");
  const lookedUp = result.details.filter((d) => d.latestVersion || d.error);
  const allFailed =
    unreachable.length > 0 && unreachable.length === lookedUp.length;
  const time = dim(`${result.stats.timeMs}ms`);

  if (upgrades.length > 0) {
    printTable(upgrades);
    if (options.upgrade) {
      for (const field of DEP_FIELDS) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          if (result.upgraded[name])
            manifest[field]![name] = result.upgraded[name];
        }
      }
      fs.writeFileSync(file, serializeLike(text, manifest));
      const install = cyan(`${packageManager()} install`);
      console.log(`\n${green("Updated.")} Run ${install} ${time}`);
    } else {
      console.log(`\nRun ${cyan("fncu -u")} to upgrade ${time}`);
    }
  } else if (!allFailed) {
    console.log(
      failed.length > 0
        ? `No upgrades (${failed.length} not checked) ${time}`
        : `${green("Up to date")} ${time}`,
    );
  }

  if (failed.length > 0) {
    console.log(yellow(`\nCouldn't check ${failed.length}:`));
    for (const d of failed) console.log(`  ${d.name} ${dim(d.error!)}`);
  }
  // Not fail(): process.exit() can drop output still being flushed to a pipe.
  if (allFailed) {
    console.error(red("\nNo package could be checked"));
    process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(red(err.message));
  process.exitCode = 1;
});
