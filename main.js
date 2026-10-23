'use strict';
const {
  Plugin, PluginSettingTab, Setting, Notice, FuzzySuggestModal, SuggestModal, TFile,
  normalizePath, moment, requestUrl,
} = require('obsidian');

const CATEGORY = { new: 'todo', indeterminate: 'in progress', done: 'done' };
const NAME_FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;
const NAME_MAX = 100;
const PLUGIN_NAME = 'Jira fzf';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSite(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    return u.host ? 'https://' + u.host : '';
  } catch (e) {
    return '';
  }
}

// `n` (2, 3, ...) adds a collision suffix joined with the separator, kept
// within NAME_MAX so the number is never cut off.
function noteFileName(key, summary, sep, n) {
  const clean = String(sep == null ? '' : sep).replace(NAME_FORBIDDEN, '');
  const s = clean.trim() ? clean : ' ';
  const sepRe = escapeRegExp(s);
  const junk = '(?:[.\\s]|' + sepRe + ')';
  let part = String(summary || '').toLowerCase()
    .replace(NAME_FORBIDDEN, s)
    .replace(new RegExp('(?:\\s|' + sepRe + ')+', 'g'), s)
    .replace(new RegExp('^' + junk + '+'), '')
    .replace(new RegExp(junk + '+$'), '');
  const k = String(key || '').toUpperCase();
  const suffix = n ? s + n : '';
  const max = NAME_MAX - suffix.length;
  let name = part ? k + s + part : k;
  if (name.length > max) {
    let cut = '';
    for (const ch of name) {
      if (cut.length + ch.length > max) break;
      cut += ch;
    }
    name = cut;
  }
  return name.replace(new RegExp(junk + '+$'), '') + suffix;
}

function isIssueKey(s) {
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(String(s));
}

function escapeJqlString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function textSearchJql(q) {
  return 'text ~ "' + escapeJqlString(q) + '" ORDER BY updated DESC';
}

function keysJql(keys) {
  return 'key in (' + keys.filter(isIssueKey).map((k) => k.toUpperCase()).join(', ') + ')';
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function mapIssue(issue, site) {
  const f = issue.fields || {};
  const status = f.status || {};
  const catKey = status.statusCategory && status.statusCategory.key;
  return {
    key: issue.key,
    url: site + '/browse/' + issue.key,
    summary: f.summary || '',
    status: status.name || '',
    statusCategory: Object.prototype.hasOwnProperty.call(CATEGORY, catKey) ? CATEGORY[catKey] : 'todo',
    priority: (f.priority && f.priority.name) || '',
    due: f.duedate || '',
  };
}

function noteProps(t) {
  return {
    jira_key: t.key,
    jira_url: t.url,
    jira_summary: t.summary,
    jira_status: t.status,
    jira_status_category: t.statusCategory,
    jira_priority: t.priority,
    due: t.due,
  };
}

function propsDiff(fm, props) {
  const norm = (v) => (v == null ? '' : String(v));
  const out = {};
  for (const k of Object.keys(props)) {
    if (norm(fm && fm[k]) !== norm(props[k])) out[k] = props[k];
  }
  return out;
}

function indexNotes(files, fmOf) {
  const map = new Map();
  for (const f of files) {
    const fm = fmOf(f);
    const k = fm && fm.jira_key;
    if (typeof k !== 'string' || !k.trim()) continue;
    const key = k.trim().toUpperCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  for (const list of map.values()) list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return map;
}

function inlineLine(t, noteLink) {
  const summary = String(t.summary).replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&');
  const parts = ['[' + t.key + ' ' + summary + '](' + t.url + ')'];
  if (t.status) parts.push(t.status);
  if (t.due) parts.push('due ' + t.due);
  if (noteLink) parts.push(noteLink);
  return parts.join(' · ');
}

function insertUnderHeading(data, heading, line) {
  const lines = data.split('\n');
  const want = heading.trim();
  const start = lines.findIndex((l) => l.trim() === want);
  if (start === -1) {
    const base = data.replace(/\s+$/, '');
    return (base ? base + '\n\n' : '') + want + '\n' + line + '\n';
  }
  const level = (want.match(/^#+/) || [''])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  let last = start;
  for (let i = start + 1; i < end; i++) if (lines[i].trim() !== '') last = i;
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

function renderTemplate(tpl, t) {
  const vars = { key: t.key, summary: t.summary, url: t.url, status: t.status, priority: t.priority, due: t.due };
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m);
}

function stripFrontmatter(s) {
  return String(s).replace(/^---\r?\n(?:[\s\S]*?\r?\n)??---[ \t]*(?:\r?\n|$)/, '');
}

function defaultBody(t) {
  return '# ' + t.key + ' ' + t.summary + '\n\n';
}

// Path of the daily note for moment `m`, from the core Daily notes options.
function dailyNotePath(options, m) {
  const o = options || {};
  const folder = String(o.folder || '').trim();
  const name = m.format(o.format || 'YYYY-MM-DD');
  return normalizePath((folder ? folder + '/' : '') + name + '.md');
}

// True if `needle` appears in the section under `heading` (up to the next
// heading of the same or a higher level).
function sectionContains(data, heading, needle) {
  const lines = String(data).split('\n');
  const want = heading.trim();
  const start = lines.findIndex((l) => l.trim() === want);
  if (start === -1) return false;
  const level = (want.match(/^#+/) || [''])[0].length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    if (lines[i].includes(needle)) return true;
  }
  return false;
}

const FIELDS = 'summary,status,priority,duedate';
const BATCH = 50;

function authHeader(email, token) {
  const bytes = new TextEncoder().encode(email + ':' + token);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

const BAD_RESPONSE = 'Unexpected response from Jira (check the site URL)';

class JiraError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }
}

async function paginate(fetchPage, cap = 500) {
  const out = [];
  let token;
  for (;;) {
    const page = await fetchPage(token);
    out.push(...((page && page.issues) || []));
    if (out.length >= cap) return out.slice(0, cap);
    if (!page || page.isLast || !page.nextPageToken) return out;
    token = page.nextPageToken;
  }
}

function readJson(res) {
  try {
    return res.json;
  } catch (e) {
    return undefined;
  }
}

class JiraClient {
  constructor({ site, email, token }, request = requestUrl) {
    this.site = normalizeSite(site);
    this.email = email;
    this.token = token;
    this.request = request;
  }

  async get(path, params) {
    let url = this.site + '/rest/api/3' + path;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
      url += (path.includes('?') ? '&' : '?') + qs.toString();
    }
    let res;
    try {
      res = await this.request({
        url,
        method: 'GET',
        headers: { Authorization: authHeader(this.email, this.token), Accept: 'application/json' },
        throw: false,
      });
    } catch (e) {
      throw new JiraError("Can't reach Jira", 0);
    }
    const status = res && res.status;
    if (status >= 200 && status < 300) {
      const data = readJson(res);
      if (data === undefined) throw new JiraError(BAD_RESPONSE, status);
      return data;
    }
    if (status === 401 || status === 403) {
      throw new JiraError('Jira rejected the credentials (check email and API token)', status);
    }
    const body = readJson(res);
    const msgs = body && Array.isArray(body.errorMessages) ? body.errorMessages : [];
    const errs = body && body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : [];
    const detail = msgs.length ? msgs : errs;
    throw new JiraError(detail.length ? detail.join('; ') : 'Jira returned HTTP ' + status, status);
  }

  search(jql, { maxResults = 100, cap = 500 } = {}) {
    return paginate((nextPageToken) => this.get('/search/jql', {
      jql, fields: FIELDS, maxResults, nextPageToken,
    }), cap);
  }

  async issue(key) {
    try {
      return await this.get('/issue/' + encodeURIComponent(key), { fields: FIELDS });
    } catch (e) {
      if (e instanceof JiraError && e.status === 404) return null;
      throw e;
    }
  }

  myself() {
    return this.get('/myself');
  }
}

async function fetchTickets(client, keys) {
  const found = new Map();
  const missing = new Set();
  const wanted = [...new Set(keys.filter(isIssueKey).map((k) => k.toUpperCase()))];
  const lookup = async (list) => {
    for (const k of list) {
      const issue = await client.issue(k);
      if (issue) found.set(k, issue); else missing.add(k);
    }
  };
  for (const batch of chunk(wanted, BATCH)) {
    let issues;
    try {
      issues = await client.search(keysJql(batch), { maxResults: 100 });
    } catch (e) {
      if (!(e instanceof JiraError) || e.status !== 400) throw e;
      await lookup(batch);
      continue;
    }
    const byKey = new Map(issues.map((i) => [String(i.key).toUpperCase(), i]));
    const absent = [];
    for (const k of batch) {
      if (byKey.has(k)) found.set(k, byKey.get(k)); else absent.push(k);
    }
    // A moved ticket comes back under its new key; resolve by the requested key.
    await lookup(absent);
  }
  return { found, missing };
}

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const DEFAULTS = {
  site: '',
  email: '',
  token: '',
  jql: DEFAULT_JQL,
  folder: 'Tickets',
  fileNameSeparator: '-',
  template: '',
  logToDaily: true,
  dailyHeading: '## Tickets',
  refreshOnStartup: true,
};
const MSG_CREDENTIALS = 'Set your Jira site, email and API token in settings';
const MSG_NO_DAILY = "Today's daily note doesn't exist yet, so this wasn't logged.";
const SEARCH_MIN = 2;
const SEARCH_DELAY = 300;
const SEARCH_HINT = 'Type at least 2 characters (a key like IT-123, or text)';

function errorMessage(e) {
  return (e && e.message) || String(e);
}

function ticketLabel(t, hasNote) {
  return (hasNote ? '📝 ' : '') + t.key + ' ' + t.summary + (t.status ? ' · ' + t.status : '');
}

// Second picker line: status and due date.
function ticketMeta(t) {
  const parts = [];
  if (t.status) parts.push(t.status);
  if (t.due) parts.push('due ' + t.due);
  return parts.join(' · ');
}

function renderTicket(el, t, hasNote) {
  el.createDiv({ text: (hasNote ? '📝 ' : '') + t.key + ' ' + t.summary });
  const meta = ticketMeta(t);
  if (meta) el.createEl('small', { text: meta, cls: 'jira-fzf-meta' });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fuzzy picker over a fixed list of tickets (the "my tickets" JQL results).
class TicketPicker extends FuzzySuggestModal {
  constructor(app, tickets, hasNote, onChoose) {
    super(app);
    this.tickets = tickets;
    this.hasNote = hasNote;
    this.onChoose = onChoose;
    this.emptyStateText = 'No tickets match your JQL';
    this.setPlaceholder('Pick a ticket');
  }

  getItems() {
    return this.tickets;
  }

  // Matched by the fuzzy search: key, summary and status.
  getItemText(t) {
    return ticketLabel(t, this.hasNote(t.key));
  }

  renderSuggestion(match, el) {
    renderTicket(el, match.item, this.hasNote(match.item.key));
  }

  onChooseItem(t) {
    return this.onChoose(t);
  }
}

// Picker that searches Jira as you type: debounced, latest query wins.
class TicketSearchModal extends SuggestModal {
  constructor(app, plugin, client, onChoose) {
    super(app);
    this.client = client;
    this.onChoose = onChoose;
    this.index = plugin.notesIndex();
    this.delay = SEARCH_DELAY;
    this.seq = 0;
    this.current = Promise.resolve([]);
    this.emptyStateText = SEARCH_HINT;
    this.setPlaceholder('Search Jira: a key like IT-123, or text');
  }

  getSuggestions(query) {
    const seq = ++this.seq;
    const p = this.lookup(String(query).trim(), seq);
    this.current = p;
    return p;
  }

  // A superseded call resolves to the newest call's results.
  async lookup(q, seq) {
    if (q.length < SEARCH_MIN) {
      this.emptyStateText = SEARCH_HINT;
      return [];
    }
    await sleep(this.delay);
    if (seq !== this.seq) return this.current;
    let tickets;
    let empty = 'No tickets found';
    try {
      if (isIssueKey(q)) {
        const issue = await this.client.issue(q.toUpperCase());
        tickets = issue ? [mapIssue(issue, this.client.site)] : [];
      } else {
        const issues = await this.client.search(textSearchJql(q), { maxResults: 20, cap: 20 });
        tickets = issues.map((i) => mapIssue(i, this.client.site));
      }
    } catch (e) {
      tickets = [];
      empty = errorMessage(e);
    }
    if (seq !== this.seq) return this.current;
    this.emptyStateText = empty;
    return tickets;
  }

  renderSuggestion(t, el) {
    renderTicket(el, t, this.index.has(String(t.key).toUpperCase()));
  }

  onChooseSuggestion(t) {
    return this.onChoose(t);
  }
}

class TicketNoteBridge extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'open-ticket-note',
      name: 'Open ticket note (my tickets)',
      callback: () => this.pickMine((t) => this.openOrCreate(t)),
    });
    this.addCommand({
      id: 'open-ticket-note-search',
      name: 'Open ticket note (search)',
      callback: () => this.pickSearch((t) => this.openOrCreate(t)),
    });
    this.addCommand({
      id: 'insert-ticket-inline',
      name: 'Insert ticket inline (my tickets)',
      editorCallback: (editor, view) => this.pickMine((t) => this.insertInline(editor, view && view.file, t)),
    });
    this.addCommand({
      id: 'insert-ticket-inline-search',
      name: 'Insert ticket inline (search)',
      editorCallback: (editor, view) => this.pickSearch((t) => this.insertInline(editor, view && view.file, t)),
    });
    this.addCommand({
      id: 'open-ticket-in-jira',
      name: "Open this note's ticket in Jira",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const fm = file && this.frontmatter(file);
        const url = fm && fm.jira_url;
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return false;
        if (!checking) window.open(url.trim());
        return true;
      },
    });
    this.addCommand({
      id: 'refresh-ticket-notes',
      name: 'Refresh all ticket notes from Jira',
      callback: () => this.refreshAll(true),
    });

    this.addRibbonIcon('ticket', 'Open ticket note (my tickets)', () => this.pickMine((t) => this.openOrCreate(t)));
    this.addSettingTab(new BridgeSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.refreshOnStartup) return;
      try {
        this.refreshAll(false).catch(() => {});
      } catch (e) {
        // Startup refresh is silent on failure.
      }
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  client(quiet = false) {
    const s = this.settings;
    const site = normalizeSite(s.site);
    const email = String(s.email || '').trim();
    const token = String(s.token || '').trim();
    if (!site || !email || !token) {
      if (!quiet) new Notice(MSG_CREDENTIALS);
      return null;
    }
    return new JiraClient({ site, email, token });
  }

  // Errors: logged to the console and shown longer, prefixed with the plugin name.
  fail(e) {
    console.error('[' + PLUGIN_NAME + ']', e);
    new Notice(PLUGIN_NAME + ': ' + errorMessage(e), 8000);
  }

  frontmatter(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    return cache && cache.frontmatter;
  }

  notesIndex() {
    return indexNotes(this.app.vault.getMarkdownFiles(), (f) => this.frontmatter(f));
  }

  noteFor(key, index = this.notesIndex()) {
    const files = index.get(String(key).toUpperCase());
    return files && files.length ? files[0] : null;
  }

  // "My tickets": fetch the JQL results first, then open the picker.
  async pickMine(action) {
    const client = this.client();
    if (!client) return;
    const loading = new Notice('Loading Jira tickets…', 0);
    let issues;
    try {
      issues = await client.search(this.settings.jql || DEFAULT_JQL);
    } catch (e) {
      this.fail(e);
      return;
    } finally {
      loading.hide();
    }
    const tickets = issues.map((i) => mapIssue(i, client.site));
    const index = this.notesIndex();
    new TicketPicker(this.app, tickets, (key) => index.has(String(key).toUpperCase()), action).open();
  }

  pickSearch(action) {
    const client = this.client();
    if (!client) return;
    new TicketSearchModal(this.app, this, client, action).open();
  }

  async openOrCreate(t) {
    try {
      let file = this.noteFor(t.key);
      if (!file) {
        file = await this.createNote(t);
        try {
          await this.logToDaily(file);
        } catch (e) {
          this.fail(e);
        }
      }
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      this.fail(e);
    }
  }

  async createNote(t) {
    const { vault, fileManager } = this.app;
    const folder = normalizePath(String(this.settings.folder || '').trim());
    if (folder && folder !== '/' && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    const prefix = folder && folder !== '/' ? folder + '/' : '';
    const base = prefix + noteFileName(t.key, t.summary, this.settings.fileNameSeparator);
    let path = normalizePath(base + '.md');
    for (let n = 2; vault.getAbstractFileByPath(path); n++) {
      path = normalizePath(prefix + noteFileName(t.key, t.summary, this.settings.fileNameSeparator, n) + '.md');
    }

    let body = defaultBody(t);
    const tplName = String(this.settings.template || '').trim();
    if (tplName) {
      const tplPath = normalizePath(/\.md$/i.test(tplName) ? tplName : tplName + '.md');
      const tpl = vault.getAbstractFileByPath(tplPath);
      if (tpl instanceof TFile) body = renderTemplate(await vault.read(tpl), t);
      else new Notice('Template not found: ' + tplPath + '. Using the default layout.');
    }

    // The template's own frontmatter is kept; the plugin's keys are merged in
    // (and win on a name clash).
    const file = await vault.create(path, body);
    const props = Object.assign(noteProps(t), { created: moment().format('YYYY-MM-DD HH:mm') });
    const merge = () => fileManager.processFrontMatter(file, (fm) => { Object.assign(fm, props); });
    try {
      await merge();
    } catch (e) {
      // Unparseable template frontmatter (e.g. a summary with ": " in it): drop it and retry.
      if (stripFrontmatter(body) === body) throw e;
      await vault.process(file, stripFrontmatter);
      await merge();
      new Notice("The template's frontmatter couldn't be parsed, so it was dropped.");
    }
    return file;
  }

  dailyNoteFile() {
    const ip = this.app.internalPlugins;
    const daily = ip && ip.getPluginById && ip.getPluginById('daily-notes');
    const options = daily && daily.instance && daily.instance.options;
    const file = this.app.vault.getAbstractFileByPath(dailyNotePath(options, moment()));
    return file instanceof TFile ? file : null;
  }

  async logToDaily(file) {
    if (!this.settings.logToDaily) return;
    const daily = this.dailyNoteFile();
    if (!daily) {
      new Notice(MSG_NO_DAILY);
      return;
    }
    const heading = String(this.settings.dailyHeading || '').trim() || DEFAULTS.dailyHeading;
    const link = this.app.fileManager.generateMarkdownLink(file, daily.path);
    const line = '- ' + moment().format('HH:mm') + ' ' + link;
    await this.app.vault.process(daily, (data) =>
      (sectionContains(data, heading, link) ? data : insertUnderHeading(data, heading, line)));
  }

  // `file` is the editor's file, taken when the command ran.
  insertInline(editor, file, t) {
    const note = this.noteFor(t.key);
    const link = note ? this.app.fileManager.generateMarkdownLink(note, file ? file.path : '') : '';
    editor.replaceSelection(inlineLine(t, link));
    if (typeof editor.focus === 'function') editor.focus();
  }

  async refreshAll(verbose) {
    const client = this.client(!verbose);
    if (!client) return;
    const index = this.notesIndex();
    if (!index.size) {
      if (verbose) new Notice('No ticket notes to refresh');
      return;
    }
    let result;
    try {
      result = await fetchTickets(client, [...index.keys()]);
    } catch (e) {
      if (verbose) this.fail(e);
      return;
    }
    let total = 0;
    let changed = 0;
    const apply = async (key, props) => {
      for (const file of index.get(key) || []) {
        total++;
        const diff = propsDiff(this.frontmatter(file), props);
        if (!Object.keys(diff).length) continue;
        try {
          await this.app.fileManager.processFrontMatter(file, (fm) => { Object.assign(fm, diff); });
          changed++;
        } catch (e) {
          if (verbose) this.fail(new Error(file.path + ': ' + errorMessage(e)));
        }
      }
    };
    for (const [key, issue] of result.found) await apply(key, noteProps(mapIssue(issue, client.site)));
    for (const key of result.missing) await apply(key, { jira_status: 'missing' });
    if (verbose) new Notice('Refreshed ' + total + ' ticket notes (' + changed + ' changed)');
  }
}

class BridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    const save = () => plugin.saveSettings();
    containerEl.empty();

    const text = (name, desc, key, placeholder, transform = (v) => v) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => t
        .setPlaceholder(placeholder)
        .setValue(s[key])
        .onChange(async (v) => { s[key] = transform(v); await save(); }));
    const toggle = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) => t
        .setValue(s[key])
        .onChange(async (v) => { s[key] = v; await save(); }));

    text('Site URL', 'Your Jira Cloud site.', 'site', 'https://yoursite.atlassian.net', normalizeSite);
    text('Email', 'The email of your Atlassian account.', 'email', 'you@example.com', (v) => v.trim());
    new Setting(containerEl)
      .setName('API token')
      .setDesc('A classic Atlassian API token. Stored in plain text in this plugin\'s data.json.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('API token')
          .setValue(s.token)
          .onChange(async (v) => { s.token = v.trim(); await save(); });
      })
      .addButton((b) => b.setButtonText('Test').onClick(async () => {
        const client = plugin.client();
        if (!client) return;
        try {
          const me = await client.myself();
          new Notice(me && me.displayName ? 'Connected as ' + me.displayName : BAD_RESPONSE);
        } catch (e) {
          plugin.fail(e);
        }
      }));
    new Setting(containerEl)
      .setName('JQL for "my tickets"')
      .setDesc('Tickets listed by the "my tickets" pickers.')
      .addTextArea((t) => t
        .setPlaceholder(DEFAULT_JQL)
        .setValue(s.jql)
        .onChange(async (v) => { s.jql = v; await save(); }));
    text('Folder', 'Where new ticket notes are created.', 'folder', 'Tickets');
    text('File name separator', 'Replaces spaces and forbidden characters in file names. Empty keeps spaces.',
      'fileNameSeparator', '-');
    text('Template', 'Optional template note. Placeholders: {{key}} {{summary}} {{url}} {{status}} {{priority}} {{due}}.',
      'template', 'Templates/Ticket');
    toggle('Log to daily note', 'Log newly created ticket notes in today\'s daily note.', 'logToDaily');
    text('Daily note heading', 'Heading the log line goes under.', 'dailyHeading', '## Tickets');
    toggle('Refresh on startup', 'Refresh all ticket notes from Jira when Obsidian starts.', 'refreshOnStartup');
  }
}
TicketNoteBridge._test = {
  PLUGIN_NAME, CATEGORY, normalizeSite, noteFileName, isIssueKey, escapeJqlString, textSearchJql, keysJql, chunk,
  mapIssue, noteProps, propsDiff, indexNotes, inlineLine, insertUnderHeading,
  ticketMeta, renderTemplate, stripFrontmatter, defaultBody, dailyNotePath, sectionContains,
  FIELDS, authHeader, JiraError, paginate, JiraClient, fetchTickets,
  DEFAULTS, TicketPicker, TicketSearchModal, BridgeSettingTab,
};
module.exports = TicketNoteBridge;
