# Ticket Note Bridge

Jira holds the ticket. Obsidian holds the thinking. Read-only: this plugin never writes to Jira.

![Fuzzy-finding a ticket and opening its note](assets/fzf.gif)

Pick a Jira Cloud ticket from inside Obsidian and either open it as a note (created on demand) or drop a one-line link to it into whatever you are writing. Ticket notes keep their Jira facts (status, priority, due date) up to date; everything else in the note is yours.

## Install

**BRAT (recommended):** install the BRAT plugin, then add the beta plugin `bobafouette/obsidian-jira-fzf`.

**Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest release and copy them into `<vault>/.obsidian/plugins/ticket-note-bridge/`. Restart Obsidian and enable the plugin.

## Set up

1. Create a classic API token: go to id.atlassian.com, then Security, API tokens, Create API token. Scoped tokens are not supported.
2. In the plugin settings, fill in your site URL (for example `https://yoursite.atlassian.net`), your Atlassian account email and the token.
3. Press **Test**. You should see "Connected as <your name>".

Other settings: the JQL for "my tickets" (default `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`), the notes folder (`Tickets`), the file name separator (`-`), an optional template note, whether to log to the daily note (on), the daily note heading (`## Tickets`) and whether to refresh on startup (on).

## Commands

| Command | What it does |
|---|---|
| Open ticket note (my tickets) | Picker over your JQL results. A note marker shows which tickets already have a note. Opens the note, or creates it and logs it in today's daily note. |
| Open ticket note (search) | Same, but the picker searches Jira as you type (2+ characters, a key like `IT-123` or free text). |
| Insert ticket inline (my tickets) | Inserts `- [KEY Summary](url) · Status · due date · [[note]]` at the cursor, plus an indented child bullet. The due date and the note link appear only when they exist. |
| Insert ticket inline (search) | Same, with search. |
| Open this note's ticket in Jira | Opens the active note's `jira_url`. Available only on notes whose `jira_url` is an http(s) link. |
| Refresh all ticket notes from Jira | Updates the properties of every note that has `jira_key`. Also runs on startup. |

A new note is named `KEY-summary-in-lower-case.md` in the notes folder. Logging to the daily note happens only when a note is created, once per note, as `- HH:mm [[note]]` under the configured heading.

## Note properties

| Property | Value | Written |
|---|---|---|
| `jira_key` | Ticket key | creation, refresh (moved tickets) |
| `jira_url` | `<site>/browse/<key>` | creation, refresh (moved tickets) |
| `jira_summary` | Summary | creation, refresh |
| `jira_status` | Status name, or `missing` | creation, refresh |
| `jira_status_category` | `todo`, `in progress` or `done` | creation, refresh |
| `jira_priority` | Priority name, or empty | creation, refresh |
| `due` | Due date `YYYY-MM-DD`, or empty | creation, refresh |
| `created` | Local `YYYY-MM-DD HH:mm` | creation only |

Notes are never renamed when the summary changes.

## Template

Set a template note in the settings to control the body of new ticket notes. Placeholders: `{{key}}`, `{{summary}}`, `{{url}}`, `{{status}}`, `{{priority}}`, `{{due}}`. Unknown placeholders are left as they are. The template's own frontmatter is dropped, since the plugin writes the properties above. Without a template the body is `# KEY Summary`.

## How refresh works

- It runs when Obsidian starts (if enabled, silently) and on demand with the refresh command.
- A note is written only when a value actually changed, to avoid needless sync churn.
- A ticket that no longer exists or is not visible to you gets `jira_status: missing`; its other properties are left alone.
- If a ticket moved to another project, `jira_key` and `jira_url` are updated.

## Privacy

- The plugin sends only GET requests, and only to your Jira site. Nothing is ever written to Jira: no comments, links, edits or transitions.
- Your API token is stored in plain text in the plugin's `data.json`. If your vault is in Git, add `.obsidian/plugins/ticket-note-bridge/data.json` to `.gitignore`.

## Limitations

- Jira Cloud only (no Data Center or Server).
- Inline lines are snapshots; they do not refresh.
- The daily log uses the core Daily notes settings, and is skipped (with a notice) if today's note does not exist.
- Not yet tested inside real Obsidian against a live site.

## Development

No build step and no dependencies.

```
node scripts/check.js
node --test 'test/*.test.js'
```

Releases: push a tag `X.Y.Z` (no `v`) or publish a release on GitHub; the workflow writes the version into `manifest.json` and `versions.json` and attaches `main.js`, `manifest.json` and `styles.css`. `node scripts/bump-version.js X.Y.Z` is optional (it keeps the repository's manifest current, and is needed to change `minAppVersion`).
