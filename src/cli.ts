#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pc from 'picocolors';
import { checkUpdates } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`
${pc.bold('fast-ncu')} - An extremely fast alternative to npm-check-updates

${pc.bold('Usage:')}
  npx fast-ncu [options]

${pc.bold('Options:')}
  -u, --upgrade          Overwrite package.json with upgraded versions
  --concurrency <num>    Number of concurrent registry requests (default: 15)
  --no-cache             Disable local caching
  -v, --version          Show version of fast-ncu
  -h, --help             Show help
`);
}

function printVersion() {
  const pkgPath = path.join(__dirname, '../package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(`fast-ncu v${pkg.version}`);
  } catch {
    console.log('fast-ncu v1.0.0');
  }
}

function colorizeVersionDiff(current: string, upgrade: string, type: 'major' | 'minor' | 'patch' | 'none'): string {
  if (type === 'none' || !upgrade) return pc.gray(current);
  
  // Find where the difference starts to colorize it (like major is red, minor yellow, patch green)
  if (type === 'major') {
    return `${pc.gray(current)}  →  ${pc.red(upgrade)}`;
  } else if (type === 'minor') {
    return `${pc.gray(current)}  →  ${pc.yellow(upgrade)}`;
  } else if (type === 'patch') {
    return `${pc.gray(current)}  →  ${pc.green(upgrade)}`;
  }
  return `${pc.gray(current)}  →  ${upgrade}`;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  if (args.includes('-v') || args.includes('--version')) {
    printVersion();
    return;
  }

  const shouldUpgrade = args.includes('-u') || args.includes('--upgrade');
  const useCache = !args.includes('--no-cache');
  
  let concurrency = 15;
  const concurrencyIdx = args.indexOf('--concurrency');
  if (concurrencyIdx !== -1 && args[concurrencyIdx + 1]) {
    const val = parseInt(args[concurrencyIdx + 1], 10);
    if (!isNaN(val) && val > 0) {
      concurrency = val;
    }
  }

  const pkgJsonPath = path.resolve(process.cwd(), 'package.json');
  
  if (!fs.existsSync(pkgJsonPath)) {
    console.error(pc.red('Error: package.json not found in the current directory.'));
    process.exit(1);
  }

  let pkgContent: any;
  try {
    pkgContent = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch (err: any) {
    console.error(pc.red(`Error parsing package.json: ${err.message}`));
    process.exit(1);
  }

  const dependencies = {
    ...(pkgContent.dependencies || {}),
    ...(pkgContent.devDependencies || {})
  };

  if (Object.keys(dependencies).length === 0) {
    console.log(pc.green('No dependencies found in package.json.'));
    return;
  }

  console.log(pc.cyan(`Checking dependencies for updates (concurrency: ${concurrency})...\n`));

  const result = await checkUpdates(dependencies, {
    concurrency,
    useCache
  });
  
  const upgradedDetails = result.details.filter(d => d.diffType !== 'none');
  const errorDetails = result.details.filter(d => d.error);

  if (upgradedDetails.length === 0) {
    console.log(pc.green('All dependencies are up to date! 🎉'));
  } else {
    const maxNameLen = Math.max(...upgradedDetails.map(d => d.name.length), 10);
    
    // Sort: major updates first, then minor, then patch
    const typeOrder = { major: 0, minor: 1, patch: 2, none: 3 };
    upgradedDetails.sort((a, b) => typeOrder[a.diffType] - typeOrder[b.diffType]);

    for (const info of upgradedDetails) {
      const paddedName = info.name.padEnd(maxNameLen + 2);
      const versionOutput = colorizeVersionDiff(
        info.currentRange, 
        info.upgradeVersion || '', 
        info.diffType
      );
      console.log(`  ${pc.bold(paddedName)} ${versionOutput}`);
    }

    console.log('');

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

      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgContent, null, 2) + '\n', 'utf8');
      console.log(pc.green(`Upgraded package.json successfully! Run ${pc.cyan('npm install')} to apply changes.`));
    } else {
      console.log(`Run ${pc.cyan('npx fast-ncu -u')} to upgrade package.json.`);
    }
  }

  if (errorDetails.length > 0) {
    console.log('\n' + pc.yellow('Warnings/Errors:'));
    for (const info of errorDetails) {
      console.log(`  ${pc.red(info.name)}: ${pc.dim(info.error)}`);
    }
  }

  const timeSec = (result.stats.timeMs / 1000).toFixed(2);
  const cacheHitStr = result.stats.cacheHits > 0 ? ` (${result.stats.cacheHits} cache hits)` : '';
  console.log(`\nChecked ${result.stats.total} packages in ${timeSec}s${cacheHitStr}.`);
}

main().catch((err) => {
  console.error(pc.red(`Fatal Error: ${err.message}`));
  process.exit(1);
});
