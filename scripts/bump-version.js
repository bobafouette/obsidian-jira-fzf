#!/usr/bin/env node
// Bump the plugin version for a release.
// Usage: node scripts/bump-version.js <version> [minAppVersion]
// Updates manifest.json (version, and minAppVersion if given) and versions.json.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");
const versionsPath = path.join(root, "versions.json");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

function parse(v) {
  const m = SEMVER.exec(v);
  return m ? m.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    fail(`cannot read ${path.basename(p)}: ${e.message}`);
  }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

const [version, minAppArg] = process.argv.slice(2);
if (!version) fail("usage: node scripts/bump-version.js <version> [minAppVersion]");

const next = parse(version);
if (!next) fail(`"${version}" is not a strict X.Y.Z version (no "v" prefix)`);
if (minAppArg !== undefined && !parse(minAppArg)) {
  fail(`minAppVersion "${minAppArg}" is not a strict X.Y.Z version`);
}

const manifest = readJson(manifestPath);
const versions = readJson(versionsPath);

const current = parse(manifest.version);
if (!current) fail(`manifest.json version "${manifest.version}" is not X.Y.Z`);
if (compare(next, current) <= 0) {
  fail(`${version} is not greater than current version ${manifest.version}`);
}

manifest.version = version;
if (minAppArg !== undefined) manifest.minAppVersion = minAppArg;
versions[version] = manifest.minAppVersion;

writeJson(manifestPath, manifest);
writeJson(versionsPath, versions);

console.log(`Bumped to ${version} (minAppVersion ${manifest.minAppVersion}).`);
console.log("Next:");
console.log(`  git commit -am "Release ${version}"`);
console.log(`  git tag ${version}`);
console.log(`  git push && git push origin ${version}`);
