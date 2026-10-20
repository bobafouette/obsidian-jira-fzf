# Ticket Note Bridge — project context

## Why this exists
For people who track work in Jira Cloud and think in Obsidian. They want to reach a
ticket from Obsidian without retyping it: link it inline in a log, or give it a
dedicated note when it needs thought, with the ticket's facts kept current.

## Design principle (don't drift from it)
- **Jira = the ticket's facts.** **Obsidian = the thinking.**
- Only tickets that need thought get a note, created on demand. Never mirror tickets wholesale.
- **Absolute rule: read-only.** The plugin never writes to Jira. Every Jira request
  is `GET`. No comments, field edits, transitions, `obsidian://` back-links. A test and
  `scripts/check.js` enforce it (no `method: 'POST'|'PUT'|'DELETE'|'PATCH'` in `main.js`).

## What the plugin does (v0.1.0)
- **Open ticket note** (my tickets / search): picker, then open or create
  `<folder>/<KEY>-<sanitized lower-case summary>.md` with frontmatter `jira_key`, `jira_url`,
  `jira_summary`, `jira_status`, `jira_status_category`, `jira_priority`, `due`, `created`.
  On creation only, logs `- HH:mm [[note]]` under a heading in today's daily note (once per note).
- **Insert ticket inline** (my tickets / search): `[KEY summary](url) · status · due … · [[note]]`
  at the cursor, as plain text (no list marker, no child bullet).
- **Open this note's ticket in Jira**.
- **Refresh all ticket notes**: also on startup (silent). Writes only when values change.
  Missing tickets get `jira_status: missing`; moved tickets get the new key and URL.
- Notes are found by scanning the metadata cache for `jira_key`; nothing is stored in Jira.

## Technical constraints
- Plain CommonJS JavaScript in a single `main.js`, no build step, no `package.json`, no dependencies.
- Mobile-safe: network only via `requestUrl`; no `require` other than `obsidian`, no
  `fetch`/`XMLHttpRequest`/Node/Electron APIs; `isDesktopOnly: false`, `minAppVersion` 1.4.0.
- Jira Cloud REST v3 under `<site>/rest/api/3`, Basic auth `base64(email:apiToken)`:
  - `GET /myself` (Test button)
  - `GET /search/jql?jql=…&fields=…&maxResults=…&nextPageToken=…` (follow `nextPageToken`, cap 500)
  - `GET /issue/{key}` (single lookup, 404 means missing)
- Default JQL: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
- Token stored in plain text in `data.json`, which is git-ignored. Never commit it.
- No personal details in the repo other than the GitHub handle `bobafouette`.

## Tests, CI, release
- Pure helpers and `JiraClient` are unit-tested with a stubbed `obsidian` module
  (`test/`): `node --test 'test/*.test.js'` (Node built-ins only).
- `node scripts/check.js`: syntax, mobile safety, read-only check, manifest/versions.json
  consistency, secrets.
- CI (`.github/workflows/ci.yml`) runs both on push and PR.
- Pushing a tag `X.Y.Z` (no `v`) or publishing a GitHub release runs `release.yml`, which writes
  the version into manifest.json/versions.json and attaches main.js, manifest.json, styles.css
  (BRAT). `node scripts/bump-version.js X.Y.Z` is optional (needed to change `minAppVersion`).

## Status / known gaps
- Nothing has been tested inside real Obsidian or against a live Jira site. Verify there first.
- Inline links are snapshots; they are not refreshed.
- Jira Data Center/Server (PAT, REST v2) and scoped API tokens are unsupported.
- The startup refresh may skip notes whose metadata cache is not ready yet.
- No Periodic Notes override: the daily note comes from the core Daily notes settings.
