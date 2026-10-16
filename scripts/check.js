#!/usr/bin/env node
// Repository checks for Ticket Note Bridge. Dependency-free, CommonJS, Node 22.
// Usage: node scripts/check.js   (exits 1 if any check fails)
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');

// ---------------------------------------------------------------- helpers

function readJson(rel, errors) {
  const file = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    errors.push(`${rel}: cannot read (${e.code || e.message})`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    errors.push(`${rel}: invalid JSON (${e.message})`);
    return null;
  }
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** NUL-separated git file list -> array of paths. */
function gitFiles(args) {
  return git([...args, '-z']).toString('utf8').split('\0').filter(Boolean);
}

// ---------------------------------------------------------------- checks

/** a. main.js parses. */
function checkSyntax() {
  const r = spawnSync(process.execPath, ['--check', MAIN], { encoding: 'utf8' });
  if (r.error) return [`could not run node --check: ${r.error.message}`];
  if (r.status !== 0) return [`node --check main.js failed:\n${(r.stderr || r.stdout).trim()}`];
  return [];
}

/** b. main.js uses nothing that breaks on Obsidian mobile (no Node/Electron APIs). */
function checkMobileSafety() {
  const rules = [
    { re: /\brequire\s*\(\s*(?!['"]obsidian['"]\s*\))/, msg: "require() of a module other than 'obsidian'" },
    { re: /(?<![\w$.])fetch\s*\(|\b(?:window|globalThis|self)\.fetch\b/, msg: 'fetch() (use requestUrl)' },
    { re: /\bXMLHttpRequest\b/, msg: 'XMLHttpRequest (use requestUrl)' },
    { re: /(?<![\w$.])process\./, msg: 'Node global process' },
    { re: /(?<![\w$.])Buffer\b/, msg: 'Node global Buffer' },
    { re: /(?<![\w$.])__dirname\b/, msg: 'Node global __dirname' },
    { re: /\belectron\b/i, msg: 'Electron API' },
  ];
  const errors = [];
  const lines = fs.readFileSync(MAIN, 'utf8').split(/\r?\n/);
  let inBlockComment = false;
  lines.forEach((raw, i) => {
    let line = raw;
    // Simple comment skipping: whole-line // comments and /* ... */ blocks.
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      inBlockComment = false;
      line = line.slice(end + 2);
    }
    const t = line.trim();
    if (t.startsWith('//')) return;
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/', 2);
      if (end === -1) { inBlockComment = true; return; }
      line = t.slice(end + 2);
    }
    for (const { re, msg } of rules) {
      if (re.test(line)) errors.push(`main.js:${i + 1}: ${msg}: ${raw.trim()}`);
    }
  });
  return errors;
}

/** c. manifest.json / versions.json are consistent and publishable. */
function checkManifest() {
  const errors = [];
  const m = readJson('manifest.json', errors);
  if (m) {
    const required = ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'isDesktopOnly'];
    for (const k of required) {
      if (!(k in m)) errors.push(`manifest.json: missing field "${k}"`);
      else if (k !== 'isDesktopOnly' && (typeof m[k] !== 'string' || !m[k].trim())) {
        errors.push(`manifest.json: field "${k}" must be a non-empty string`);
      }
    }
    if (typeof m.version === 'string' && !/^\d+\.\d+\.\d+$/.test(m.version)) {
      errors.push(`manifest.json: version "${m.version}" is not strict semver X.Y.Z`);
    }
    if ('isDesktopOnly' in m && m.isDesktopOnly !== false) {
      errors.push('manifest.json: isDesktopOnly must be false (plugin must run on Android)');
    }
    if (typeof m.id === 'string' && /obsidian/i.test(m.id)) {
      errors.push(`manifest.json: id "${m.id}" must not contain "obsidian"`);
    }
  }
  const v = readJson('versions.json', errors);
  if (m && v && typeof m.version === 'string') {
    if (!(m.version in v)) {
      errors.push(`versions.json: no entry for manifest version "${m.version}"`);
    } else if (v[m.version] !== m.minAppVersion) {
      errors.push(`versions.json: "${m.version}" maps to "${v[m.version]}" but manifest.minAppVersion is "${m.minAppVersion}"`);
    }
  }
  return errors;
}

/** d. Main file never writes to Jira: every request must be a GET. */
function checkReadOnly() {
  const errors = [];
  const re = /\bmethod\s*:\s*['"`](POST|PUT|PATCH|DELETE)\b/i;
  const lines = fs.readFileSync(MAIN, 'utf8').split(/\r?\n/);
  let inBlock = false;
  lines.forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      inBlock = false;
      line = line.slice(end + 2);
    }
    const t = line.trim();
    if (t.startsWith('//')) return;
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/', 2);
      if (end === -1) { inBlock = true; return; }
      line = t.slice(end + 2);
    }
    if (re.test(line)) errors.push(`main.js:${i + 1}: non-GET request (the plugin is read-only): ${raw.trim()}`);
  });
  return errors;
}

/** e. No Jira API token committed. */
function checkSecrets() {
  const errors = [];
  if (gitFiles(['ls-files', '--', 'data.json']).length) {
    errors.push('data.json is tracked by git (it holds the Jira API token): git rm --cached data.json');
  }
  // Tracked files plus untracked-but-not-ignored ones (about to be committed).
  const files = gitFiles(['ls-files', '--cached', '--others', '--exclude-standard']);
  const tokenRe = /\bATATT[A-Za-z0-9_\-=]{20,}/;
  for (const rel of files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(ROOT, rel));
    } catch {
      continue; // deleted in the working tree, symlink to nowhere, etc.
    }
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      if (tokenRe.test(line) && !line.includes('check:allow-token')) {
        errors.push(`${rel}:${i + 1}: looks like a Jira API token (ATATT...); add "check:allow-token" on the line if it is not a secret`);
      }
    });
  }
  return errors;
}

// ---------------------------------------------------------------- runner

const CHECKS = [
  ['Syntax (node --check main.js)', checkSyntax],
  ['Mobile safety (main.js)', checkMobileSafety],
  ['Read-only (main.js)', checkReadOnly],
  ['Manifest / versions.json', checkManifest],
  ['Secrets', checkSecrets],
];

let failed = 0;
for (const [name, fn] of CHECKS) {
  let errors;
  try {
    errors = fn();
  } catch (e) {
    errors = [`check crashed: ${e.message}`];
  }
  if (errors.length) {
    failed++;
    console.log(`✖ ${name}`);
    for (const e of errors) console.log(`    ${e.replace(/\n/g, '\n    ')}`);
  } else {
    console.log(`✔ ${name}`);
  }
}

if (failed) {
  console.log(`\n${failed} of ${CHECKS.length} checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${CHECKS.length} checks passed.`);
