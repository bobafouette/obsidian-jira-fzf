# Jira fzf

Jira holds the ticket. Obsidian holds the thinking. Read-only: this plugin never writes to Jira.

![Fuzzy-finding a ticket and opening its note](assets/fzf.gif)

Pick a Jira Cloud ticket from inside Obsidian and either open it as a note (created on demand) or drop a one-line link to it into whatever you are writing. Ticket notes keep their Jira facts (status, priority, due date) up to date; everything else in the note is yours.

## Install (desktop and Android)

### With BRAT (recommended, gets updates)

1. Settings → Community plugins → Browse → install and enable **BRAT**.
2. Run the command **BRAT: Add a beta plugin for testing** and enter `bobafouette/obsidian-jira-fzf`.
3. Settings → Community plugins → enable **Jira fzf**, then set it up (below).

BRAT installs the latest GitHub release and keeps it updated. It works on Android too: do the same steps there, or let Obsidian Sync bring the plugin over (enable "Installed community plugins" and "Active community plugin list" in Sync's settings on both devices).

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy them into `<vault>/.obsidian/plugins/ticket-note-bridge/` (the folder name is the plugin id).
3. Restart Obsidian, then Settings → Community plugins → enable **Jira fzf**.
4. On Android, let your sync bring the folder over, then enable the plugin there too (plugin enablement is per device unless you sync your config folder).

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
| Insert ticket inline (my tickets) | Inserts `[KEY Summary](url) · Status · due date · [[note]]` at the cursor, with no list marker or extra lines. The due date and the note link appear only when they exist. |
| Insert ticket inline (search) | Same, with search. |
| Open this note's ticket in Jira | Opens the active note's `jira_url`. Available only on notes whose `jira_url` is an http(s) link. |
| Refresh all ticket notes from Jira | Updates the properties of every note that has `jira_key`. Also runs on startup. |

The ribbon icon (a ticket) runs **Open ticket note (my tickets)**. While the JQL runs, a "Loading Jira tickets…" notice shows. The pickers show the key and summary, with the status and due date on a second line.

A new note is named `KEY-summary-in-lower-case.md` in the notes folder. If a different note already has that name, the separator and a number are appended (`IT-123-fix-the-printer-2.md`). Logging to the daily note happens only when a note is created, once per note, as `- HH:mm [[note]]` under the configured heading.

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

Set a template note in the settings to control the body of new ticket notes. Placeholders: `{{key}}`, `{{summary}}`, `{{url}}`, `{{status}}`, `{{priority}}`, `{{due}}`. Unknown placeholders are left as they are. Without a template the body is `# KEY Summary`; if the template file can't be found, a notice says so and the default body is used.

The template's own frontmatter is kept and merged with the plugin's: the note gets a single frontmatter block with your keys (for example `tags: ticket`) plus the properties above. If a key exists in both, the plugin's value wins. If the rendered frontmatter is not valid YAML (for example `title: {{summary}}` with a summary containing `: `), it is dropped with a notice and only the plugin's properties are written.

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
- Errors are shown as notices prefixed "Jira fzf:" and logged to the developer console.

## Development

No build step and no dependencies.

```
node scripts/check.js
node --test 'test/*.test.js'
```

`check.js` covers syntax, mobile safety, the read-only rule (no non-GET method in `main.js`), manifest/`versions.json` consistency and secrets.

## Releasing

1. Create the release, either way (tags have no `v` prefix):
   - **Web page:** Releases → Draft a new release → choose a tag → type `0.3.0`, target `main` → Publish release.
   - **Command line:** `git tag 0.3.0 && git push origin 0.3.0`.
2. The release workflow writes the tag version into `manifest.json` and `versions.json`, runs the checks and tests, and attaches `main.js`, `manifest.json` and `styles.css` to the release (creating it if you pushed only a tag). It refuses a tag lower than the version in `manifest.json`.
3. Optional, to keep the repository's own `manifest.json` current (and needed to change `minAppVersion`): `node scripts/bump-version.js 0.3.0 [minAppVersion]` and merge it to `main` before tagging. Don't edit the version in `manifest.json` by hand: CI fails unless `versions.json` has a matching entry, and the script updates both.
4. BRAT picks up the new release on its next update check.
