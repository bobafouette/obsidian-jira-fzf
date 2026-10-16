# Ticket Note Bridge (obsidian-jira-fzf) — design

Date: 2026-10-16
Repository: `obsidian-jira-fzf` (public, new)

## Purpose

The plugin is for people who track work in Jira Cloud and think in
Obsidian. They want to reach a Jira ticket from Obsidian without retyping it:
link it inline in the daily log, or give it a dedicated note when it needs
thought, and keep that note's ticket facts current.

Principle: **Jira is the source of the ticket's facts,
Obsidian holds the user's thinking.** Only tickets that need thought get a
note, created on demand; tickets are never mirrored wholesale.

**Hard rule: the plugin never writes to Jira.** Tickets are visible to
others, so no `obsidian://` links, comments, field edits or transitions.
Every Jira request is a read.

## Success criteria

- From the picker, the user can open or create a ticket note in a few keystrokes,
  on desktop and Android.
- Inline links are a single line with key, summary, status and a link to the
  ticket's note when one exists.
- Each ticket note's properties reflect Jira after a refresh (manual or startup),
  and the refresh writes files only when a value changed (Obsidian Sync churn).
- No request other than GET is ever sent to Jira (checked by a test and by
  `scripts/check.js`).
- Installs and updates through BRAT from GitHub releases.

## Out of scope (v1)

- Any write to Jira (permanent, see above).
- Creating a Jira ticket from a note.
- Jira Data Center / Server (PAT auth, REST v2).
- Copying the ticket description, comments or assignee into the note.
- Atlassian scoped API tokens (they require the `api.atlassian.com/ex/jira/{cloudId}`
  base URL); classic API tokens only.
- Periodic Notes daily-note overrides (core Daily notes settings only).

## Constraints

- Plain CommonJS JavaScript in a single `main.js`, no build step, no `package.json`.
- Works on Obsidian mobile: network only through `requestUrl`, no Node or Electron
  APIs, `isDesktopOnly: false`, `minAppVersion` 1.4.0.
- Jira Cloud REST API v3, base `<site>/rest/api/3`, Basic auth
  `base64(email:apiToken)` (`btoa`, available on desktop and mobile).
- Credentials in plain text in `data.json`; `data.json` git-ignored.
- `obsidian://` URIs are not produced at all (nothing is written back).

## Approach

A self-contained repository: one `main.js`, a check script, a stubbed `obsidian`
module for tests, and CI and release workflows. Helpers (file-name sanitising,
insert under heading, daily note path) live in `main.js`.

Rejected: an external shared helper library (needs a bundler, which breaks the
no-build-step constraint).

## Plugin identity

- `id`: `ticket-note-bridge`, `name`: Ticket Note Bridge
- `author`: `bobafouette` (GitHub handle); `authorUrl`: `https://github.com/bobafouette`.
  No other personal details anywhere in the repository.
- BRAT install path in the README: `bobafouette/obsidian-jira-fzf`.
- Description: "Open a Jira ticket as an Obsidian note on demand, link it inline,
  and log the work in your daily note. Read-only: never writes to Jira."

## Commands

| id | name | behaviour |
|---|---|---|
| `open-ticket-note` | Open ticket note (my tickets) | Picker over the configured JQL. 📝 marks tickets that have a note. Choose → open the note, or create it and log it in today's daily note. Shows "No tickets match your JQL" when empty. |
| `open-ticket-note-search` | Open ticket note (search) | Same, but the picker searches Jira as you type (see Search). |
| `insert-ticket-inline` | Insert ticket inline (my tickets) | Inserts the inline line at the cursor (editor command). |
| `insert-ticket-inline-search` | Insert ticket inline (search) | Same, with search. |
| `open-ticket-in-jira` | Open this note's ticket in Jira | Uses the active note's `jira_url` (editor/file check command, only when the note has `jira_key`). |
| `refresh-ticket-notes` | Refresh all ticket notes from Jira | Updates every note having `jira_key`. Also runs on startup when enabled (silent on failure). |

### Note lookup

A ticket's note is found by scanning `metadataCache` for files whose frontmatter
`jira_key` equals the ticket key (case-insensitive). The scan builds a
`Map<KEY, TFile>` per command invocation. No link is stored in Jira, so this is
the only lookup; renaming or moving a note needs no handling.

### Opening / creating a note

1. If a note exists for the key, open it.
2. Otherwise create `<folder>/<fileName>.md`:
   - `fileName = KEY + sep + sanitize(lowercase(summary))`, e.g.
     `IT-123-fix-the-printer`. Key keeps its case. Sanitising: forbidden characters and spaces →
     separator, separators collapsed, leading/trailing dots and separators stripped. Empty separator keeps
     spaces (`IT-123 fix the printer`). Total base name capped at 100 characters.
   - If the path already exists (a non-ticket note with that name), append
     ` 2`, ` 3`, …
   - Folder is created if missing.
   - Frontmatter (see Note properties) + body from the template, or the default
     body `# <KEY> <summary>\n\n`.
3. Log `- HH:mm [[<note basename>]]` under the daily heading in today's daily
   note, once per note per day (skip if a line linking that note is already
   under the heading). Skip if logging is disabled or today's note doesn't exist.
   Logging happens only when the note is created; opening an existing note from
   the picker does not log it.

### Inline line

```
- [IT-123 Fix the printer](https://site.atlassian.net/browse/IT-123) · In Progress · [[IT-123-fix-the-printer]]
	- |
```

- Status is the status name. Due date, when set, is appended as `· due 2026-10-20`
  before the note link.
- The note link segment appears only if a note exists.
- `[`, `]` in the summary are escaped with a backslash so the markdown link holds.
- The child bullet is indented with the editor's indent (tab by default) and the
  cursor is placed after `- `.
- Inline lines are snapshots; they are not refreshed.

## Jira API usage

All requests: `requestUrl({ url, method: 'GET', headers: { Authorization, Accept: 'application/json' }, throw: false })`.
Site URL is normalised (trim, strip trailing `/`, add `https://` if missing).

| purpose | request |
|---|---|
| Test connection | `GET /rest/api/3/myself` → show `displayName` |
| List (my tickets) | `GET /rest/api/3/search/jql?jql=…&fields=summary,status,priority,duedate&maxResults=100[&nextPageToken=…]`, follow `nextPageToken` until `isLast` or absent, stop at 500 tickets total |
| Get one | `GET /rest/api/3/issue/{key}?fields=summary,status,priority,duedate` |
| Refresh batch | search with `key in (K1, K2, …)`, 50 keys per batch |

Default JQL: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.

### Search (as you type)

Picker is a `SuggestModal` whose `getSuggestions` returns a Promise, debounced
300 ms, minimum 2 characters, latest query wins (stale responses dropped).

- Query matching `/^[A-Za-z][A-Za-z0-9_]*-\d+$/` → `GET issue/{KEY}`; 404 → no results.
- Otherwise JQL `text ~ "<escaped>" ORDER BY updated DESC`, `maxResults=20`.
  Escaping: backslash and double quote are backslash-escaped; JQL `text ~` special
  characters are left to Jira (a 400 shows Jira's message in the empty state).

### Ticket mapping

`mapIssue(issue, site)` →

```
{ key, url: <site>/browse/<key>, summary, status: status.name,
  statusCategory: { new: 'todo', indeterminate: 'in progress', done: 'done' }[status.statusCategory.key] ?? 'todo',
  priority: priority?.name ?? '', due: duedate ?? '' }
```

### Refresh

1. Collect `{key → file}` from notes with `jira_key`.
2. For each batch of 50 keys, search `key in (…)` with `maxResults=100`.
3. If the batch returns 400 (a key no longer exists or isn't visible), fetch
   that batch's keys one by one with `GET issue/{key}`:
   - 404 → set `jira_status: missing` (other properties left as they were).
   - Returned key differs from the requested one (ticket moved project) →
     update `jira_key` and `jira_url` too.
4. For each ticket, compute the property diff; call
   `fileManager.processFrontMatter` only if at least one value differs.
5. Verbose run shows a notice "Refreshed N ticket notes (M changed)".

## Note properties

| property | source | written |
|---|---|---|
| `jira_key` | key | create, refresh (moved tickets) |
| `jira_url` | `<site>/browse/<key>` | create, refresh (moved tickets) |
| `jira_summary` | summary | create, refresh |
| `jira_status` | status name, or `missing` | create, refresh |
| `jira_status_category` | `todo` / `in progress` / `done` | create, refresh |
| `jira_priority` | priority name or empty | create, refresh |
| `due` | duedate `YYYY-MM-DD` or empty | create, refresh |
| `created` | local `YYYY-MM-DD HH:mm` at note creation | create only |

The file is never renamed when the summary changes.

## Template

Optional vault path to a template note. Placeholders `{{key}}`, `{{summary}}`,
`{{url}}`, `{{status}}`, `{{priority}}`, `{{due}}` are replaced; unknown
`{{…}}` and inherited-key names (e.g. `{{constructor}}`) are left untouched.
The template's own frontmatter, if any, is dropped (the plugin writes its own).

## Settings

| setting | default |
|---|---|
| Site URL | empty (e.g. `https://yoursite.atlassian.net`) |
| Email | empty |
| API token (password field) + **Test** button | empty |
| JQL for "my tickets" | default JQL above |
| Folder | `Tickets` |
| File name separator | `-` |
| Template | empty |
| Log to daily note | on |
| Daily note heading | `## Tickets` |
| Refresh on startup | on |

## Errors

- Missing site/email/token → notice "Set your Jira site, email and API token in
  settings" and the command stops.
- 401 / 403 → notice "Jira rejected the credentials (check email and API token)".
- Other non-2xx → notice with Jira's `errorMessages` joined, or the HTTP status.
- Network failure → notice "Can't reach Jira".
- Startup refresh never shows a notice.

## Code layout (`main.js`)

- Pure helpers (exported via `TicketNoteBridge._test`): `normalizeSite`,
  `authHeader`, `sanitizeName`, `noteFileName`, `escapeJqlString`, `searchJql`,
  `isIssueKey`, `chunk`, `mapIssue`, `noteProps`, `propsDiff`, `inlineLine`,
  `insertUnderHeading`, `renderTemplate`, `defaultBody`, `paginate(fetchPage)`.
- `JiraClient` (thin): `get(path, params)`, `search(jql, opts)`, `issue(key)`,
  `myself()`. Takes a `request` function (defaults to `requestUrl`) so tests
  can inject a fake. Only implements GET.
- `TicketPicker` (fuzzy over a fixed list) and `TicketSearchModal` (async search).
- `TicketNoteBridge` plugin: commands, note lookup/creation, refresh, daily log.
- `BridgeSettingTab`.

## Testing

Node built-ins only: `node --test 'test/*.test.js'`, with the `obsidian` module
stubbed (`test/obsidian-stub.js`, `test/load-plugin.js`).

- Unit tests for every pure helper listed above, including: separator variants,
  forbidden characters, length cap, key case preserved; JQL escaping of quotes
  and backslashes; key detection; status category mapping incl. unknown;
  diff returns empty when nothing changed; inline line with/without due and
  note, bracket escaping; insert under an existing / missing heading and in an
  empty file; template placeholders incl. unknown and inherited names.
- `paginate` with a fake page fetcher: multiple pages, `isLast`, missing token,
  500 cap.
- `JiraClient` with a fake `request`: URL and query encoding, auth header, error
  mapping (401, 400 with `errorMessages`, network throw), and **every request
  uses method GET**.

## CI and release

- `scripts/check.js` (adapted): `main.js` syntax, mobile safety (no `require` other
  than `obsidian`, no `fetch`/`XMLHttpRequest`, no Node built-ins), manifest and
  `versions.json` consistency, no secrets (token-like strings, Atlassian token
  prefix `ATATT`), and read-only check: `main.js` must not contain
  `method: 'POST'|'PUT'|'DELETE'|'PATCH'`.
- `.github/workflows/ci.yml`: on push and PR, run the check script and the tests.
- `.github/workflows/release.yml`: on a published release or a pushed `X.Y.Z`
  tag, write the tag version into `manifest.json` / `versions.json` and attach
  `main.js`, `manifest.json`, `styles.css` (BRAT).
- `scripts/bump-version.js X.Y.Z` optional (keeps the repo's manifest current; needed to change `minAppVersion`).
- First release: `0.1.0`.

## Repository contents

```
.github/workflows/ci.yml
.github/workflows/release.yml
.gitignore            # data.json, node_modules, .DS_Store
CLAUDE.md             # project context for contributors
README.md             # install (BRAT / manual), API token how-to, commands, properties, privacy
docs/superpowers/specs/2026-10-16-jira-ticket-notes-design.md
main.js
manifest.json
scripts/bump-version.js
scripts/check.js
styles.css
test/helpers.test.js
test/client.test.js
test/load-plugin.js
test/obsidian-stub.js
versions.json
```

## Verification limits

Nothing can be tested inside real Obsidian or against a live
Jira site from the build environment. The README says so, and the first release
is checked manually on desktop and Android against a real site.
