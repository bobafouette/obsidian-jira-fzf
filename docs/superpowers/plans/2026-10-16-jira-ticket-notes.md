# Ticket Note Bridge Implementation Plan

> **Historical (v0.1.0).** Corrected where it drifted from the code: inline lines are plain text, collisions use `-2`, templates keep their frontmatter (v0.2.0), and the plugin is now named "Jira fzf". The README is the current reference.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Obsidian plugin that opens or creates notes for Jira Cloud tickets, inserts inline ticket links, refreshes ticket facts into note properties, and logs new ticket notes in the daily note; installable through BRAT.

**Architecture:** One CommonJS `main.js` with pure helpers (exported as `TicketNoteBridge._test`), a GET-only `JiraClient` that takes an injectable `request` function, two pickers, and the plugin class. Tests run under plain Node with a stubbed `obsidian` module. CI runs a dependency-free check script and the tests; a release workflow publishes the BRAT files from a `X.Y.Z` tag.

**Tech Stack:** JavaScript (CommonJS, no build), Obsidian plugin API (`requestUrl`, `SuggestModal`, `FuzzySuggestModal`, `processFrontMatter`), Jira Cloud REST API v3, `node --test` (Node 22), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-16-jira-ticket-notes-design.md`

## Global Constraints

- Plain CommonJS in a single `main.js`; no build step, no `package.json`, no dependencies.
- Mobile-safe: network only via `requestUrl`; no `require` other than `obsidian`, no `fetch`, `XMLHttpRequest`, `process`, `Buffer`, `__dirname`, Electron.
- `manifest.json`: `id` `ticket-note-bridge`, `name` `Ticket Note Bridge`, `author` `bobafouette`, `authorUrl` `https://github.com/bobafouette`, `minAppVersion` `1.4.0`, `isDesktopOnly` `false`, first version `0.1.0`.
- Description: "Open a Jira ticket as an Obsidian note on demand, link it inline, and log the work in your daily note. Read-only: never writes to Jira."
- **Read-only:** every Jira request uses method `GET`. Nothing is ever written to Jira.
- Jira Cloud REST v3 under `<site>/rest/api/3`, Basic auth `base64(email:apiToken)`.
- `data.json` is git-ignored and must never be committed.
- No personal details in the repository other than the GitHub handle `bobafouette` (manifest author, BRAT path). No mention of other projects.
- Default JQL: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
- Defaults: folder `Tickets`, separator `-`, daily heading `## Tickets`, log to daily note on, refresh on startup on.
- Commits end with the session's attribution lines.

## Review Focus

1. **Email with non-ASCII characters** (e.g. `josé@example.com`): `btoa` throws on non-Latin-1; the auth header must be base64 of the UTF-8 bytes. Test in Task 3.
2. **Site URL pasted from the browser** (`yoursite.atlassian.net/jira/your-work`, trailing `/`, no scheme): the plugin must reduce it to `https://yoursite.atlassian.net`. Test in Task 2.
3. **Summary that sanitises to nothing** (`""`, `"///"`, `"..."`): the note name must be just the key, never `IT-123-` or empty. Test in Task 2.
4. **Same `jira_key` in two notes** (a copied note) or a lower-case key typed by hand: lookup must be case-insensitive and deterministic (first by path), and refresh must update every note with that key. Test in Task 2 (`indexNotes`).
5. **A refresh batch containing a deleted or moved ticket**: the whole JQL query returns 400; the other tickets in that batch must still refresh, the deleted one gets `missing`, the moved one gets its new key. Test in Task 3 (`fetchTickets`).

---

## File Structure

| file | responsibility |
|---|---|
| `main.js` | helpers, `JiraClient`, pickers, plugin, settings tab |
| `test/obsidian-stub.js` | fake `obsidian` module for Node |
| `test/load-plugin.js` | loads `main.js` with the stub, exports `_test` |
| `test/helpers.test.js` | naming, JQL, mapping, diff, markdown helpers |
| `test/client.test.js` | `authHeader`, `paginate`, `JiraClient`, `fetchTickets` |
| `test/plugin.test.js` | plugin with an in-memory fake app: commands, ribbon, notes, templates, refresh, daily log, settings |
| `scripts/check.js` | syntax, mobile safety, read-only, manifest, secrets |
| `scripts/bump-version.js` | optional version bump |
| `.github/workflows/ci.yml`, `release.yml` | CI and BRAT release |
| `manifest.json`, `versions.json`, `styles.css`, `.gitignore` | plugin metadata |
| `README.md`, `CLAUDE.md` | user and contributor docs |
| `docs/superpowers/specs/…`, `docs/superpowers/plans/…` | spec and this plan |

Git: the repository starts empty; every task commits to `main` and pushes (`git push -u origin main`).

---

### Task 1: Repository and scaffolding

**Files:**
- Create: everything in the table above except `README.md` and `CLAUDE.md` (Task 5); `main.js` is a minimal plugin.
- Test: `test/plugin.test.js`

**Interfaces:**
- Produces: `main.js` exporting `module.exports = TicketNoteBridge` with `TicketNoteBridge._test = {}` (later tasks add helpers to it); `test/load-plugin.js` exporting `{ ...TicketNoteBridge._test, TicketNoteBridge }`; stub classes `Plugin` (with `addCommand` pushing to `this.commands`), `PluginSettingTab`, `Setting`, `Notice`, `Modal`, `FuzzySuggestModal`, `SuggestModal`, `MarkdownView`, `TFile`, `TFolder`, functions `normalizePath`, `requestUrl` (throws), `moment` (supports `YYYY MM DD HH mm ss`).

- [ ] **Step 1: Create the GitHub repository** `bobafouette/obsidian-jira-fzf`: public, empty (no README/licence), description = the manifest description. Add it to the session and clone it.
- [ ] **Step 2: Write `test/plugin.test.js`**

```js
test('plugin loads', async () => {
  const { TicketNoteBridge } = require('./load-plugin');
  const p = new TicketNoteBridge(fakeApp(), { id: 'ticket-note-bridge' });
  await p.onload();
  assert.ok(p instanceof TicketNoteBridge);
});
```
`fakeApp()` returns `{ workspace: { onLayoutReady: (f) => f(), getActiveFile: () => null }, metadataCache: {}, vault: { getMarkdownFiles: () => [] } }`.

- [ ] **Step 3: Run it, expect FAIL** — `node --test 'test/*.test.js'` → cannot find `main.js`.
- [ ] **Step 4: Create the scaffolding files**
  - `manifest.json` per Global Constraints; `versions.json` `{ "0.1.0": "1.4.0" }`; `styles.css` with a single comment; `.gitignore` `data.json`, `node_modules/`, `.DS_Store`.
  - `main.js`: `'use strict'`, `require('obsidian')`, empty `TicketNoteBridge extends Plugin` with `async onload() {}`, export as above.
  - `scripts/check.js`: four checks plus a fifth:
    - Syntax: `node --check main.js`.
    - Mobile safety: the forbidden patterns in Global Constraints, skipping `//` and `/* */` comment lines.
    - **Read-only:** a `main.js` line outside comments matching `/\bmethod\s*:\s*['"`](POST|PUT|PATCH|DELETE)\b/i` fails.
    - Manifest: required fields `id name version minAppVersion description author isDesktopOnly`, strict `X.Y.Z`, `isDesktopOnly === false`, id must not contain `obsidian`, `versions.json[version] === minAppVersion`.
    - Secrets: `data.json` must not be tracked; in tracked plus untracked-not-ignored files, a line matching `/\bATATT[A-Za-z0-9_\-=]{20,}/` fails unless it contains `check:allow-token`.
  - `scripts/bump-version.js <X.Y.Z> [minAppVersion]`: refuses non-semver or a version lower than the manifest's; updates `manifest.json` and `versions.json`, 2-space JSON with a trailing newline.
  - `ci.yml`: on push to any branch and on pull_request; Node 22; `node scripts/check.js`; `node --test 'test/*.test.js'`. Permissions `contents: read`.
  - `release.yml`: on tags `[0-9]+.[0-9]+.[0-9]+` and `release: published`; concurrency group per ref; `contents: write`; write the tag into `manifest.json`/`versions.json` (fail on a `v` prefix or a tag lower than the manifest); run checks and tests; `gh release upload … --clobber` if the release exists, else `gh release create "$TAG" main.js manifest.json styles.css --title "$TAG" --generate-notes`.
  - Copy the spec and this plan into `docs/superpowers/`.
- [ ] **Step 5: Run checks and tests, expect PASS** — `node scripts/check.js` → `All 5 checks passed.`; tests → 1 pass. Also verify the read-only check fires: temporarily add `requestUrl({ method: 'POST' })` to `main.js`, expect `✖ Read-only`, then remove it.
- [ ] **Step 6: Commit and push** — `chore: scaffold Ticket Note Bridge plugin`.

---

### Task 2: Pure helpers (naming, JQL, mapping, markdown)

**Files:**
- Modify: `main.js` (helpers section)
- Test: `test/helpers.test.js`

**Interfaces:**
- Produces (all in `_test`):
  - `normalizeSite(s: string) -> string` — trims; adds `https://` when no scheme; returns the origin only; `''` for empty input.
  - `noteFileName(key: string, summary: string, sep: string) -> string`
  - `isIssueKey(s: string) -> boolean` — `/^[A-Za-z][A-Za-z0-9_]*-\d+$/`
  - `escapeJqlString(s: string) -> string`
  - `textSearchJql(q: string) -> string` — `text ~ "<escaped>" ORDER BY updated DESC`
  - `keysJql(keys: string[]) -> string` — `key in (A-1, B-2)`, upper-cased, non-keys dropped
  - `chunk(arr: T[], n: number) -> T[][]`
  - `mapIssue(issue: object, site: string) -> Ticket`, `Ticket = { key, url, summary, status, statusCategory, priority, due }`
  - `noteProps(t: Ticket) -> { jira_key, jira_url, jira_summary, jira_status, jira_status_category, jira_priority, due }`
  - `propsDiff(fm: object, props: object) -> object` — changed entries only; missing, `null` and `''` compare equal
  - `indexNotes(files: TFile[], fmOf: (f) => object|undefined) -> Map<string, TFile[]>` — key upper-cased, each list sorted by `path`
  - `inlineLine(t: Ticket, noteLink: string|null) -> string`
  - `insertUnderHeading(data: string, heading: string, line: string) -> string`
  - `renderTemplate(tpl: string, t: Ticket) -> string`, `stripFrontmatter(s: string) -> string`, `defaultBody(t: Ticket) -> string`
  - constant `CATEGORY = { new: 'todo', indeterminate: 'in progress', done: 'done' }`

- [ ] **Step 1: Write the failing tests** (`T` is a fixture `{ key: 'IT-123', url: 'https://x.atlassian.net/browse/IT-123', summary: 'Fix the printer', status: 'In Progress', statusCategory: 'in progress', priority: 'High', due: '' }`)

```js
// normalizeSite
eq(normalizeSite(' yoursite.atlassian.net/ '), 'https://yoursite.atlassian.net');
eq(normalizeSite('https://yoursite.atlassian.net/jira/your-work?x=1'), 'https://yoursite.atlassian.net');
eq(normalizeSite(''), '');
// noteFileName
eq(noteFileName('IT-123', 'Fix the printer', '-'), 'IT-123-fix-the-printer');
eq(noteFileName('it-123', 'Fix the printer', ''), 'IT-123 fix the printer');
eq(noteFileName('IT-123', 'a/b:c*?"<>|#^[]\\ d', '-'), 'IT-123-a-b-c-d');
eq(noteFileName('IT-123', '...Hidden...', '-'), 'IT-123-hidden');
for (const s of ['', '///', '...']) eq(noteFileName('IT-123', s, '-'), 'IT-123');
const long = noteFileName('IT-123', 'word '.repeat(60), '-');
ok(long.length <= 100 && !long.endsWith('-'));
// keys and JQL
ok(isIssueKey('IT-123') && isIssueKey('it-1') && isIssueKey('A1_B-9'));
ok(!isIssueKey('IT123') && !isIssueKey('IT-') && !isIssueKey('I T-1'));
eq(escapeJqlString('say "hi" \\ x'), 'say \\"hi\\" \\\\ x');
eq(textSearchJql('printer "lab"'), 'text ~ "printer \\"lab\\"" ORDER BY updated DESC');
eq(keysJql(['it-1', 'B-2', 'nope']), 'key in (IT-1, B-2)');
deepEq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
deepEq(chunk([], 50), []);
// mapIssue
const raw = { key: 'IT-123', fields: { summary: 'Fix the printer', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, duedate: '2026-10-20' } };
deepEq(mapIssue(raw, 'https://x.atlassian.net'), { ...T, due: '2026-10-20' });
const bare = mapIssue({ key: 'IT-1', fields: { summary: 's', status: { name: 'Odd', statusCategory: { key: 'weird' } }, priority: null, duedate: null } }, 'https://x.atlassian.net');
eq(bare.statusCategory, 'todo'); eq(bare.priority, ''); eq(bare.due, '');
// noteProps / propsDiff
deepEq(Object.keys(noteProps(T)), ['jira_key', 'jira_url', 'jira_summary', 'jira_status', 'jira_status_category', 'jira_priority', 'due']);
deepEq(propsDiff({ ...noteProps(T), created: '2026-10-16 09:00' }, noteProps(T)), {});
deepEq(propsDiff({ jira_key: 'IT-123' }, { jira_key: 'IT-123', jira_priority: '' }), {});
deepEq(propsDiff({ jira_status: 'To Do' }, { jira_status: 'missing' }), { jira_status: 'missing' });
// indexNotes
const files = [{ path: 'b.md' }, { path: 'a.md' }, { path: 'c.md' }];
const fm = { 'a.md': { jira_key: 'it-1' }, 'b.md': { jira_key: 'IT-1' }, 'c.md': {} };
const idx = indexNotes(files, (f) => fm[f.path]);
deepEq(idx.get('IT-1').map((f) => f.path), ['a.md', 'b.md']); eq(idx.size, 1);
// inlineLine
eq(inlineLine(T, null), '[IT-123 Fix the printer](https://x.atlassian.net/browse/IT-123) · In Progress');
eq(inlineLine({ ...T, due: '2026-10-20' }, '[[IT-123-fix-the-printer]]'),
   '[IT-123 Fix the printer](https://x.atlassian.net/browse/IT-123) · In Progress · due 2026-10-20 · [[IT-123-fix-the-printer]]');
ok(inlineLine({ ...T, summary: 'Fix [prod] now' }, null).startsWith('[IT-123 Fix \\[prod\\] now]('));
// insertUnderHeading
eq(insertUnderHeading('', '## Tickets', '- l'), '## Tickets\n- l\n');
eq(insertUnderHeading('# Day\n\ntext\n', '## Tickets', '- l'), '# Day\n\ntext\n\n## Tickets\n- l\n');
eq(insertUnderHeading('## Tickets\n- a\n\n## Other\nx\n', '## Tickets', '- l'), '## Tickets\n- a\n- l\n\n## Other\nx\n');
// templates
eq(renderTemplate('{{key}}|{{summary}}|{{url}}|{{status}}|{{priority}}|{{due}}|{{other}}|{{constructor}}', T),
   'IT-123|Fix the printer|https://x.atlassian.net/browse/IT-123|In Progress|High||{{other}}|{{constructor}}');
eq(stripFrontmatter('---\na: 1\n---\nbody\n'), 'body\n');
eq(defaultBody(T), '# IT-123 Fix the printer\n\n');
```

- [ ] **Step 2: Run, expect FAIL** — `node --test test/helpers.test.js` → `normalizeSite is not a function`.
- [ ] **Step 3: Implement the helpers in `main.js`** and add them to `_test`.
  - Forbidden name characters: `/[\\/:*?"<>|#^[\]]/g`. Empty or whitespace separator means a space. Lower-case the summary only; collapse runs of whitespace or separator to one separator; strip leading and trailing dots, spaces and separators from the summary part; join `KEY + sep + summary` (or just `KEY`); cut to 100 characters and strip trailing separators again.
  - `normalizeSite` uses `new URL(...)`, returning `''` when that throws.
  - `inlineLine`: escape `[` and `]` in the summary, collapse whitespace; segments joined with ` · `; `due …` only when set.
  - `insertUnderHeading`: missing heading → append after the content with a blank line before it; existing heading → insert after the last non-blank line of its section (a section ends at the next heading of the same or a higher level).
- [ ] **Step 4: Run, expect PASS** — `node --test 'test/*.test.js'` and `node scripts/check.js`.
- [ ] **Step 5: Commit and push** — `feat: add naming, JQL and note helpers`.

---

### Task 3: Jira client (GET only) and ticket fetching

**Files:**
- Modify: `main.js` (client section)
- Test: `test/client.test.js`

**Interfaces:**
- Consumes: `normalizeSite`, `keysJql`, `chunk`, `isIssueKey` (Task 2).
- Produces (all in `_test`):
  - `authHeader(email: string, token: string) -> string` — `'Basic ' + base64(utf8(email + ':' + token))`, using `TextEncoder` and `btoa`.
  - `class JiraError extends Error { status: number }`
  - `paginate(fetchPage: (token?: string) => Promise<{issues, nextPageToken?, isLast?}>, cap = 500) -> Promise<object[]>`
  - `class JiraClient { constructor({ site, email, token }, request = requestUrl); get(path, params?) -> Promise<json>; search(jql, { maxResults = 100, cap = 500 } = {}) -> Promise<issue[]>; issue(key) -> Promise<issue|null>; myself() -> Promise<{displayName}> }`
  - `fetchTickets(client, keys: string[]) -> Promise<{ found: Map<string, issue>, missing: Set<string> }>` — keyed by the **requested** upper-case key.
  - `FIELDS = 'summary,status,priority,duedate'`

- [ ] **Step 1: Write the failing tests** (`fakeRequest(responses)` records each call's argument in its own `calls` and in a file-level `allCalls`, and returns the next `{ status, json }`, or throws when the entry is an `Error`)

```js
eq(authHeader('me@example.com', 'tok'), 'Basic bWVAZXhhbXBsZS5jb206dG9r');
eq(authHeader('josé@example.com', 't'), 'Basic ' + Buffer.from('josé@example.com:t', 'utf8').toString('base64'));

// paginate
const pages = { undefined: { issues: [1, 2], nextPageToken: 'a' }, a: { issues: [3], nextPageToken: 'b', isLast: true } };
deepEq(await paginate(async (t) => pages[t]), [1, 2, 3]);
deepEq(await paginate(async () => ({ issues: [1] })), [1]);              // no token → stop
eq((await paginate(async (t) => ({ issues: Array(100).fill(0), nextPageToken: 'n' }), 250)).length, 250);

// JiraClient
const req = fakeRequest([{ status: 200, json: { issues: [{ key: 'IT-1' }], isLast: true } }]);
const c = new JiraClient({ site: 'x.atlassian.net/', email: 'me@example.com', token: 'tok' }, req);
await c.search('a = "b"');
const call = req.calls[0];
eq(call.method, 'GET');
eq(call.headers.Authorization, 'Basic bWVAZXhhbXBsZS5jb206dG9r');
eq(call.headers.Accept, 'application/json');
eq(call.throw, false);
ok(call.url.startsWith('https://x.atlassian.net/rest/api/3/search/jql?'));
const q = new URL(call.url).searchParams;
eq(q.get('jql'), 'a = "b"'); eq(q.get('fields'), FIELDS); eq(q.get('maxResults'), '100');

eq(await new JiraClient(cfg, fakeRequest([{ status: 404, json: {} }])).issue('IT-9'), null);
await rejects(new JiraClient(cfg, fakeRequest([{ status: 401, json: {} }])).myself(), /Jira rejected the credentials \(check email and API token\)/);
await rejects(new JiraClient(cfg, fakeRequest([{ status: 400, json: { errorMessages: ['Bad', 'JQL'] } }])).search('x'), (e) => e.status === 400 && e.message === 'Bad; JQL');
await rejects(new JiraClient(cfg, fakeRequest([{ status: 500, json: {} }])).myself(), /Jira returned HTTP 500/);
await rejects(new JiraClient(cfg, fakeRequest([new Error('offline')])).myself(), /Can't reach Jira/);

// fetchTickets with a fake client
const store = { 'IT-1': { key: 'IT-1' }, 'IT-2': { key: 'OPS-7' } };   // IT-2 moved, IT-3 deleted
const fake = {
  searches: [],
  async search(jql) { this.searches.push(jql); if (jql.includes('IT-3')) throw new JiraError('gone', 400); return [store['IT-1']]; },
  async issue(k) { return store[k] || null; },
};
const r = await fetchTickets(fake, ['IT-1', 'IT-2', 'IT-3']);
eq(r.found.get('IT-1').key, 'IT-1'); eq(r.found.get('IT-2').key, 'OPS-7');
deepEq([...r.missing], ['IT-3']);
const counting = { searches: [], async search(j) { this.searches.push(j); return []; }, async issue() { return null; } };
const many = await fetchTickets(counting, Array.from({ length: 120 }, (_, i) => `IT-${i + 1}`));
eq(many.missing.size, 120);
eq(counting.searches.length, 3);                                     // batches of 50, 50, 20
ok(counting.searches.every((j) => j.split(',').length <= 50));

// read-only: every call any test made used GET
ok(allCalls.every((c) => c.method === 'GET'));
```

- [ ] **Step 2: Run, expect FAIL** — `node --test test/client.test.js` → `authHeader is not a function`.
- [ ] **Step 3: Implement in `main.js`**
  - `get` builds `${site}/rest/api/3${path}` plus `URLSearchParams` and calls `request({ url, method: 'GET', headers, throw: false })`.
  - Errors: a thrown `request` → `JiraError("Can't reach Jira", 0)`; 401 or 403 → the credentials message; any other non-2xx → `errorMessages.join('; ')`, or `Jira returned HTTP <status>`.
  - `search` paginates `/search/jql` with `jql`, `fields`, `maxResults` and `nextPageToken`.
  - `issue(key)` calls `/issue/{encodeURIComponent(key)}?fields=…` and returns `null` on 404.
  - `fetchTickets`:
    - Batches of 50 keys via `keysJql`. Results map to the requested key by the returned key.
    - On a `JiraError` with status 400, fall back to `issue()` per key in that batch. A non-null result whose key differs is still stored under the requested key.
    - A key missing from a successful search, or a `null` from `issue()`, goes into `missing`.
    - Other errors propagate.
- [ ] **Step 4: Run, expect PASS** — all tests and `node scripts/check.js`.
- [ ] **Step 5: Commit and push** — `feat: add read-only Jira client and ticket fetching`.

---

### Task 4: Plugin: settings, pickers, commands, refresh, daily log

**Files:**
- Modify: `main.js` (modals, plugin, settings tab), `test/obsidian-stub.js` (add anything new the plugin touches)
- Test: `test/plugin.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–3.
- Produces:
  - `DEFAULTS = { site: '', email: '', token: '', jql: <default JQL>, folder: 'Tickets', fileNameSeparator: '-', template: '', logToDaily: true, dailyHeading: '## Tickets', refreshOnStartup: true }`
  - Command ids: `open-ticket-note`, `open-ticket-note-search`, `insert-ticket-inline`, `insert-ticket-inline-search`, `open-ticket-in-jira`, `refresh-ticket-notes`.
  - `class TicketPicker extends FuzzySuggestModal`: items are `Ticket`s; text `"📝 IT-123 Fix the printer · In Progress"`, where 📝 is shown only when a note exists. Empty state "No tickets match your JQL".
  - `class TicketSearchModal extends SuggestModal`:
    - `getSuggestions(q)` returns a Promise. Under 2 characters → `[]`. Waits 300 ms; a call superseded by a newer one resolves to the newest results.
    - A query matching `isIssueKey` → `client.issue`; otherwise `client.search(textSearchJql(q), { maxResults: 20, cap: 20 })`.
    - A `JiraError` is shown as the empty-state text.
  - Plugin methods: `client(quiet = false) -> JiraClient|null` (returns `null` when site, email or token is missing; shows "Set your Jira site, email and API token in settings" unless `quiet`), `notesIndex() -> Map`, `openOrCreate(t: Ticket)`, `createNote(t) -> TFile`, `logToDaily(file)`, `insertInline(editor, file, t)`, `refreshAll(verbose: boolean)`.

- [ ] **Step 1: Write the failing test** — extend `test/plugin.test.js`:

```js
test('registers the six commands with the agreed ids', async () => {
  const p = new TicketNoteBridge(fakeApp(), manifest);
  await p.onload();
  deepEq(p.commands.map((c) => c.id).sort(), ['insert-ticket-inline', 'insert-ticket-inline-search',
    'open-ticket-in-jira', 'open-ticket-note', 'open-ticket-note-search', 'refresh-ticket-notes']);
});
test('settings default to the spec values', async () => {
  const p = new TicketNoteBridge(fakeApp(), manifest); await p.onload();
  eq(p.settings.jql, 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  eq(p.settings.folder, 'Tickets'); eq(p.settings.dailyHeading, '## Tickets');
});
test('startup refresh without credentials is silent', async () => {
  const notices = require('./obsidian-stub').Notice.log = [];
  const p = new TicketNoteBridge(fakeApp(), manifest); await p.onload();
  eq(notices.length, 0);
});
```
The stub `Notice` constructor pushes its message to `Notice.log` when it is an array.

- [ ] **Step 2: Run, expect FAIL** — the command list is empty.
- [ ] **Step 3: Implement the plugin**
  - `onload`: load settings; register the commands; add the settings tab; on layout ready, if `refreshOnStartup`, run `refreshAll(false)` inside a `try` that swallows errors; `refreshAll(false)` calls `client(true)`.
  - Inline commands use `editorCallback`.
  - `open-ticket-in-jira` uses `checkCallback`: available only when the active file's frontmatter has `jira_url`; it opens the URL with `window.open`.
  - `notesIndex()`: `indexNotes(vault.getMarkdownFiles(), (f) => metadataCache.getFileCache(f)?.frontmatter)`.
  - `openOrCreate(t)`: the first indexed file for `t.key`, else `createNote` then `logToDaily`; then open it with `workspace.getLeaf(false).openFile(file)`.
  - `createNote(t)`:
    1. Create the folder if it is missing.
    2. Name the file with `noteFileName(t.key, t.summary, sep)`; on a collision, `noteFileName(t.key, t.summary, sep, n)` appends `-2`, `-3`, ….
    3. Body: `renderTemplate(templateText, t)` if a template is set and exists (its frontmatter is kept and merged in step 4; if it doesn't parse it is stripped), else `defaultBody(t)` with a notice when the template is missing.
    4. Write the frontmatter with `processFrontMatter`: `noteProps(t)` plus `created: moment().format('YYYY-MM-DD HH:mm')`.
  - `logToDaily(file)`:
    - Skip unless `logToDaily` is on.
    - The daily path comes from `internalPlugins.getPluginById('daily-notes').instance.options` (`folder`, `format`, default `YYYY-MM-DD`).
    - If today's note doesn't exist, show the notice "Today's daily note doesn't exist yet, so this wasn't logged."
    - Otherwise `vault.process` inserts ``- ${HH:mm} ${generateMarkdownLink(file, daily.path)}`` with `insertUnderHeading`, unless the link is already present.
  - `insertInline(editor, file, t)`:
    1. Insert `inlineLine(t, noteLink)` as plain text (no list marker, no child bullet), where `noteLink` is a markdown link from `file` (the editor's `view.file`) to the ticket's note, if one exists.
    3. Place the cursor at the end.
  - `refreshAll(verbose)`:
    1. `index = notesIndex()`, then `fetchTickets(client, [...index.keys()])`.
    2. Found tickets: `props = noteProps(mapIssue(issue, site))`. Missing tickets: `{ jira_status: 'missing' }`.
    3. For every file of every key, run `processFrontMatter` only when `propsDiff` is non-empty, and assign only the diff keys.
    4. When verbose, show the notice `Refreshed N ticket notes (M changed)`.
  - Error notices use the `JiraError` message; startup (non-verbose) failures show nothing.
  - Settings tab:
    - Site URL: saved through `normalizeSite`.
    - Email.
    - API token: a password field, with a **Test** button that calls `myself()` and shows the notice `Connected as <displayName>`.
    - JQL as a text area, then folder, separator, template, log toggle, daily heading, startup toggle.
- [ ] **Step 4: Run, expect PASS** — all tests and `node scripts/check.js`.
- [ ] **Step 5: Commit and push** — `feat: add commands, pickers, refresh and daily log`.

---

### Task 5: Documentation and first release

**Files:**
- Create: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write `README.md`**
  - Opening line: "Jira holds the ticket. Obsidian holds the thinking. Read-only: this plugin never writes to Jira."
  - Install with BRAT (`bobafouette/obsidian-jira-fzf`) or manually.
  - Getting a classic Atlassian API token (id.atlassian.com → Security → API tokens). Scoped tokens are not supported.
  - The six commands; the note properties table; the template placeholders.
  - Privacy: the plugin sends GET requests to your Jira site only, and the token is stored in plain text in `data.json`.
  - "Not yet tested inside real Obsidian against a live site"; development commands.
  - No personal details beyond the handle.
- [ ] **Step 2: Write `CLAUDE.md`**: purpose, the read-only rule, the constraints from Global Constraints, the API endpoints used, the test and check commands, the release process, and known gaps (inline links are snapshots; Data Center and scoped tokens are not supported).
- [ ] **Step 3: Verify** — `node scripts/check.js` and `node --test 'test/*.test.js'` pass; a search of the working tree (excluding `.git`) for the user's real name, email domain and other project names, supplied at run time and never written into the repo, returns nothing.
- [ ] **Step 4: Commit and push** — `docs: add README and project context`.
- [ ] **Step 5: Ask the user before tagging**, then push tag `0.1.0`. Check that the Release workflow publishes `main.js`, `manifest.json` and `styles.css` and that CI is green.
