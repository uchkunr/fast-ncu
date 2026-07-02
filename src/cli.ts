#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { checkUpdates, DependencyInfo } from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`
${pc.bold("fast-ncu")} (${pc.bold("fncu")}) - An extremely fast alternative to npm-check-updates

${pc.bold("Usage:")}
  fncu [options]

${pc.bold("Options:")}
  -u, --upgrade          Overwrite package.json with upgraded versions
  --concurrency <num>    Number of concurrent registry requests (default: 15)
  --no-cache             Disable local caching
  -v, --version          Show version of fast-ncu / fncu
  -h, --help             Show help
`);
}

function printVersion() {
  const pkgPath = path.join(__dirname, "../package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    console.log(`v${pkg.version}`);
  } catch {
    console.log("v1.0.0");
  }
}

function colorizeVersionDiff(
  current: string,
  upgrade: string,
  type: "major" | "minor" | "patch" | "none",
): string {
  if (type === "none" || !upgrade) return pc.gray(current);

  // Find where the difference starts to colorize it (like major is red, minor yellow, patch green)
  if (type === "major") {
    return `${pc.gray(current)}  →  ${pc.red(upgrade)}`;
  } else if (type === "minor") {
    return `${pc.gray(current)}  →  ${pc.yellow(upgrade)}`;
  } else if (type === "patch") {
    return `${pc.gray(current)}  →  ${pc.green(upgrade)}`;
  }
  return `${pc.gray(current)}  →  ${upgrade}`;
}

function detectPackageManager(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (
    fs.existsSync(path.join(cwd, "bun.lockb")) ||
    fs.existsSync(path.join(cwd, "bun.lock"))
  )
    return "bun";
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm";

  // Check user agent if lockfiles are missing (e.g. running global/npx)
  const userAgent = process.env.npm_config_user_agent || "";
  if (userAgent.includes("pnpm")) return "pnpm";
  if (userAgent.includes("yarn")) return "yarn";
  if (userAgent.includes("bun")) return "bun";

  return "npm";
}

function printUpgradesTable(upgradedDetails: DependencyInfo[]) {
  // Sort: major updates first, then minor, then patch
  const typeOrder = { major: 0, minor: 1, patch: 2, none: 3 };
  upgradedDetails.sort((a, b) => typeOrder[a.diffType] - typeOrder[b.diffType]);

  const headers = ["Package", "Current", "Latest", "Type"];

  // Calculate max lengths for each column
  const nameLen = Math.max(
    ...upgradedDetails.map((d) => d.name.length),
    headers[0].length,
  );
  const currentLen = Math.max(
    ...upgradedDetails.map((d) => d.currentRange.length),
    headers[1].length,
  );
  const upgradeLen = Math.max(
    ...upgradedDetails.map((d) => d.upgradeVersion || "").map((v) => v.length),
    headers[2].length,
  );
  const typeLen = Math.max(
    ...upgradedDetails.map((d) => d.diffType.length),
    headers[3].length,
  );

  // Draw borders
  const topBorder = `┌─${"─".repeat(nameLen)}─┬─${"─".repeat(currentLen)}─┬─${"─".repeat(upgradeLen)}─┬─${"─".repeat(typeLen)}─┐`;
  const midBorder = `├─${"─".repeat(nameLen)}─┼─${"─".repeat(currentLen)}─┼─${"─".repeat(upgradeLen)}─┼─${"─".repeat(typeLen)}─┤`;
  const botBorder = `└─${"─".repeat(nameLen)}─┴─${"─".repeat(currentLen)}─┴─${"─".repeat(upgradeLen)}─┴─${"─".repeat(typeLen)}─┘`;

  // Print Header
  console.log(topBorder);
  console.log(
    `│ ${pc.bold(headers[0].padEnd(nameLen))} │ ${pc.bold(headers[1].padEnd(currentLen))} │ ${pc.bold(headers[2].padEnd(upgradeLen))} │ ${pc.bold(headers[3].padEnd(typeLen))} │`,
  );
  console.log(midBorder);

  // Print Rows
  for (const info of upgradedDetails) {
    const rawName = info.name.padEnd(nameLen);
    const rawCurrent = info.currentRange.padEnd(currentLen);
    const rawUpgrade = (info.upgradeVersion || "").padEnd(upgradeLen);
    const rawType = info.diffType.padEnd(typeLen);

    const nameCol = pc.cyan(rawName);
    const currentCol = pc.gray(rawCurrent);

    let upgradeCol = rawUpgrade;
    if (info.diffType === "major") upgradeCol = pc.red(rawUpgrade);
    else if (info.diffType === "minor") upgradeCol = pc.yellow(rawUpgrade);
    else if (info.diffType === "patch") upgradeCol = pc.green(rawUpgrade);

    let typeCol = rawType;
    if (info.diffType === "major") typeCol = pc.red(rawType);
    else if (info.diffType === "minor") typeCol = pc.yellow(rawType);
    else if (info.diffType === "patch") typeCol = pc.green(rawType);

    console.log(`│ ${nameCol} │ ${currentCol} │ ${upgradeCol} │ ${typeCol} │`);
  }
  console.log(botBorder);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  if (args.includes("-v") || args.includes("--version")) {
    printVersion();
    return;
  }

  const shouldUpgrade = args.includes("-u") || args.includes("--upgrade");
  const useCache = !args.includes("--no-cache");

  let concurrency = 15;
  const concurrencyIdx = args.indexOf("--concurrency");
  if (concurrencyIdx !== -1 && args[concurrencyIdx + 1]) {
    const val = parseInt(args[concurrencyIdx + 1], 10);
    if (!isNaN(val) && val > 0) {
      concurrency = val;
    }
  }

  const pkgJsonPath = path.resolve(process.cwd(), "package.json");

  if (!fs.existsSync(pkgJsonPath)) {
    console.error(
      pc.red("Error: package.json not found in the current directory."),
    );
    process.exit(1);
  }

  let pkgContent: any;
  try {
    pkgContent = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  } catch (err: any) {
    console.error(pc.red(`Error parsing package.json: ${err.message}`));
    process.exit(1);
  }

  const dependencies = {
    ...(pkgContent.dependencies || {}),
    ...(pkgContent.devDependencies || {}),
  };

  if (Object.keys(dependencies).length === 0) {
    console.log(pc.green("No dependencies found in package.json."));
    return;
  }

  const result = await checkUpdates(dependencies, {
    concurrency,
    useCache,
  });

  const upgradedDetails = result.details.filter((d) => d.diffType !== "none");
  const errorDetails = result.details.filter((d) => d.error);

  if (upgradedDetails.length === 0) {
    console.log(pc.green("Up to date!"));
  } else {
    // Print table of upgrades
    printUpgradesTable(upgradedDetails);

    if (shouldUpgrade) {
      // Overwrite package.json with updated versions
      if (pkgContent.dependencies) {
        for (const name of Object.keys(pkgContent.dependencies)) {
          if (result.upgraded[name]) {
            pkgContent.dependencies[name] = result.upgraded[name];
          }
        }
      }

      if (pkgContent.devDependencies) {
        for (const name of Object.keys(pkgContent.devDependencies)) {
          if (result.upgraded[name]) {
            pkgContent.devDependencies[name] = result.upgraded[name];
          }
        }
      }

      fs.writeFileSync(
        pkgJsonPath,
        JSON.stringify(pkgContent, null, 2) + "\n",
        "utf8",
      );
      const pm = detectPackageManager();
      console.log(
        "\n" +
          pc.green(
            `Upgraded package.json successfully! Run ${pc.cyan(`${pm} install`)} to apply changes.`,
          ),
      );
    } else {
      console.log(
        "\n" + "💡 Run " + pc.cyan("fncu -u") + " to upgrade package.json.",
      );
    }
    console.log(pc.dim("⚡ Done in " + result.stats.timeMs + "ms"));
  }

  if (upgradedDetails.length === 0 && errorDetails.length > 0) {
    console.log("\n" + pc.yellow("Warnings/Errors:"));
    for (const info of errorDetails) {
      console.log(`  ${pc.red(info.name)}: ${pc.dim(info.error)}`);
    }
  }
}

main().catch((err) => {
  console.error(pc.red(`Fatal Error: ${err.message}`));
  process.exit(1);
});
