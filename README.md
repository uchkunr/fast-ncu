# fast-ncu

[![npm](https://img.shields.io/npm/v/fast-ncu.svg)](https://www.npmjs.com/package/fast-ncu)
[![license](https://img.shields.io/npm/l/fast-ncu.svg)](LICENSE)

A small, fast alternative to [npm-check-updates](https://github.com/raineorshine/npm-check-updates) for the
everyday case: find the latest version of every dependency in `package.json` and bump it.

![fncu lists available upgrades, writes them to package.json from the cache, then reports the project is up to date](https://raw.githubusercontent.com/uchkunr/fast-ncu/master/media/demo.gif)

## Install

```bash
npm install -g fast-ncu
```

This gives you `fncu` (and the longer `fast-ncu`). Requires Node.js 18 or newer.

## Usage

```bash
fncu      # list available upgrades
fncu -u   # write them to package.json
```

`-u` keeps your range operator (`^6.0.0` becomes `^7.8.5`), leaves `file:`, `workspace:`, git and `npm:`
specifiers alone (they aren't sent to the registry at all), and tells you which package manager to run
`install` with.

## Why it's faster

npm-check-updates downloads each package's packument, the document listing every version ever published.
For `typescript` that's 8.7 MB, even in the abbreviated format npm clients use. fast-ncu only needs the
`latest` dist-tag, so it requests `/<name>/latest` instead (4.8 KB), runs 30 of those requests in
parallel and caches the results for 5 minutes.

On the npm-check-updates repository (78 dependencies), a cold run took 0.88 s against 2.75 s for ncu.
The details are in [How I sped up npm-check-updates by 3x](https://uchkun.io/blog/speeding-up-npm-check-updates).

## Limitations

fast-ncu covers the common case. Use npm-check-updates if you need:

- private registries: only registry.npmjs.org is queried and `.npmrc` isn't read
- targets other than `latest`, filters or pre-release channels
- workspaces, `peerDependencies` or `optionalDependencies`
- compound ranges kept intact: `>=1.0.0 <2.0.0`, `1.x` and `^4.0.0 || ^5.0.0` collapse to a single version

## License

[MIT](LICENSE)
