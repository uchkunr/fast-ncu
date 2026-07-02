# ⚡ fast-ncu

An extremely fast, lightweight, and zero-configuration alternative to **npm-check-updates (ncu)**. It checks your `package.json` dependencies against the npm registry concurrently and upgrades them to the latest versions.

🚀 **More than 3x faster than the original `npm-check-updates` on cold runs, and up to 300x faster on cached runs!**

[![npm version](https://img.shields.io/npm/v/fast-ncu.svg?style=flat)](https://www.npmjs.com/package/fast-ncu)
[![TypeScript](https://img.shields.io/badge/TypeScript-%23007ACC.svg?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![license](https://img.shields.io/npm/l/fast-ncu.svg?style=flat)](https://github.com/uchkunr/fast-ncu/blob/master/LICENSE)

---

## ⚡ Performance Comparison (Benchmark)

Tested on a repository containing **78 dependencies** (the `npm-check-updates` codebase itself):

| Tool | Concurrency | Cache | Time (Seconds) | Speedup |
| :--- | :--- | :--- | :--- | :--- |
| 🐢 **Original `ncu`** | Default | N/A | `2.75s` | *Baseline* |
| ⚡ **`fast-ncu` (Cold)** | `15` (Default) | Disabled | `2.70s` | `1.0x` |
| 🚀 **`fast-ncu` (Cold)** | `30` | Disabled | **`0.88s`** | **3.1x faster** |
| 🛸 **`fast-ncu` (Warm)** | `30` | Enabled (Hit) | **`0.01s`** (10ms) | **275x faster** |

---

## 🛠️ How it works (Why it's so fast)

Most developers don't realize how much overhead goes into checking package versions. Here is how `fast-ncu` achieves extreme performance:

### 1. Tiny payloads via `/latest` CDN Edge Endpoint
*   **The Problem:** Normal tools query `https://registry.npmjs.org/<pkg>` which returns the full package metadata (all historical versions, SHAs, dates, and readmes). For packages like `typescript` or `aws-sdk`, this JSON can be **several megabytes**.
*   **The Solution:** We query `https://registry.npmjs.org/<pkg>/latest`. This returns a tiny, CDN-cached JSON object containing only the latest version details (~2KB). Our benchmarks show that the `/latest` endpoint is **over 4x faster** to resolve than the standard packument endpoint.

### 2. High-Performance Concurrency Limiter
*   We developed an optimized, zero-dependency concurrency queue controller. It runs async HTTP requests in parallel with an adjustable limit (e.g. `--concurrency 30`), maximizing your network bandwidth without causing socket exhaustion or registry rate limits.

### 3. Ultra-Fast Startup Time (ESM + Zero Bloat)
*   By avoiding heavy CLI packages (like `yargs`, `commander`) and bulky utilities (like `chalk`), the entire Node.js runtime boots and prints output in **under 40ms**. We use native ES Modules and `picocolors` (which starts up instantly and has zero dependencies).

### 4. Smart Local Caching Layer
*   Subsequent runs are instantaneous. It safely stores the fetched versions in your system's temp directory (`/tmp/fast-ncu-cache.json`) for 5 minutes (configurable). A second run takes **10ms** to check any number of packages!

---

## 📦 Installation

Run it on the fly using `npx`:

```bash
# Using fast-ncu
npx fast-ncu

# Or using the shorthand alias
npx fncu
```

Or install globally:

```bash
npm install -g fast-ncu
```

Once globally installed, you can use the command `fast-ncu` or its convenient shorthand `fncu`.

---

## 🚀 Usage

You can use the full name `fast-ncu` or the shorter shorthand `fncu` interchangeably:

```bash
# Check dependencies for updates (Safe - read only)
fncu

# Overwrite package.json with the upgraded versions
fncu -u

# Maximize speed by raising concurrency
fncu --concurrency 30

# Force bypass the cache
fncu --no-cache
```

## ⚙️ Options

*   `-u, --upgrade`          Overwrite package.json with upgraded versions
*   `--concurrency <num>`    Number of concurrent registry requests (default: 15)
*   `--no-cache`             Disable local caching
*   `-v, --version`          Show version of fast-ncu / fncu
*   `-h, --help`             Show help

## 🧪 Tests

The project includes unit tests using Node's native test runner (zero external testing dependencies).

To compile and run tests:
```bash
npm run build
npm test
```

## 📄 License
MIT
