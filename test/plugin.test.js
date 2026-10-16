'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stub = require('./obsidian-stub');
const {
  TicketNoteBridge, TicketPicker, TicketSearchModal, BridgeSettingTab, DEFAULTS, JiraError,
  dailyNotePath, sectionContains,
} = require('./load-plugin');

const eq = assert.equal;
const deepEq = assert.deepEqual;
const ok = assert.ok;

const manifest = { id: 'ticket-note-bridge' };
const SITE = 'https://x.atlassian.net';
const CREDS = { site: SITE, email: 'me@example.com', token: 'tok' };

function mkFile(path) {
  const f = new stub.TFile();
  f.path = path;
  f.name = path.split('/').pop();
  f.basename = f.name.replace(/\.md$/, '');
  f.extension = 'md';
  return f;
}

// In-memory vault: files (path -> TFile), contents, frontmatter, folders.
function fakeApp({ files = {}, fm = {}, folders = [], daily = { folder: 'Daily', format: 'YYYY-MM-DD' } } = {}) {
  const store = { files: new Map(), data: new Map(), fm: new Map(), folders: new Set(folders), opened: [], log: [] };
  for (const [path, content] of Object.entries(files)) {
    store.files.set(path, mkFile(path));
    store.data.set(path, content);
  }
  for (const [path, f] of Object.entries(fm)) store.fm.set(path, { ...f });
  return {
    store,
    workspace: {
      onLayoutReady: (f) => f(),
      active: null,
      getActiveFile() { return this.active; },
      getLeaf: () => ({ openFile: async (file) => { store.opened.push(file.path); } }),
    },
    metadataCache: {
      getFileCache: (f) => (store.fm.has(f.path) ? { frontmatter: store.fm.get(f.path) } : {}),
    },
    vault: {
      getMarkdownFiles: () => [...store.files.values()],
      getAbstractFileByPath: (p) => store.files.get(p) || (store.folders.has(p) ? new stub.TFolder() : null),
      createFolder: async (p) => { store.log.push('createFolder ' + p); store.folders.add(p); },
      create: async (p, content) => {
        if (store.files.has(p)) throw new Error('File already exists');
        const f = mkFile(p);
        store.files.set(p, f); store.data.set(p, content); store.log.push('create ' + p);
        return f;
      },
      read: async (f) => store.data.get(f.path),
      cachedRead: async (f) => store.data.get(f.path),
      process: async (f, fn) => { const out = fn(store.data.get(f.path)); store.data.set(f.path, out); return out; },
    },
    fileManager: {
      processFrontMatter: async (f, fn) => {
        if (!store.fm.has(f.path)) store.fm.set(f.path, {});
        fn(store.fm.get(f.path));
        store.log.push('fm ' + f.path);
      },
      generateMarkdownLink: (f) => '[[' + f.basename + ']]',
    },
    internalPlugins: {
      getPluginById: (id) => (id === 'daily-notes' && daily ? { instance: { options: daily } } : null),
    },
  };
}

async function plugin(appOpts = {}, settings = {}) {
  const app = fakeApp(appOpts);
  const p = new TicketNoteBridge(app, manifest);
  p.loadData = async () => ({ refreshOnStartup: false, ...settings });
  p.saveData = async (d) => { p.saved = d; };
  await p.onload();
  return p;
}

function captureNotices() {
  stub.Notice.log = [];
  return stub.Notice.log;
}

const today = () => stub.moment().format('YYYY-MM-DD');
const T = { key: 'IT-123', url: SITE + '/browse/IT-123', summary: 'Fix the printer', status: 'In Progress', statusCategory: 'in progress', priority: 'High', due: '' };
const issue = (key, summary = 'Fix the printer', status = 'In Progress') => ({
  key, fields: { summary, status: { name: status, statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, duedate: null },
});

function fakeClient(over = {}) {
  const calls = [];
  return {
    site: SITE, calls,
    search: async (jql, opts) => { calls.push(['search', jql, opts]); return over.search ? over.search(jql, opts) : []; },
    issue: async (key) => { calls.push(['issue', key]); return over.issue ? over.issue(key) : null; },
    myself: async () => { calls.push(['myself']); return { displayName: 'Me' }; },
  };
}

function fakeEditor() {
  return {
    text: '', cursor: { line: 0, ch: 0 },
    replaceSelection(s) {
      this.text += s;
      const lines = this.text.split('\n');
      this.cursor = { line: lines.length - 1, ch: lines[lines.length - 1].length };
    },
    lineText: '',
    getLine() { return this.lineText; },
    getCursor() { return this.cursor; },
    setCursor(pos) { this.cursor = pos; },
    focus() {},
  };
}

// Stops a modal class from opening and captures the instance instead.
async function capture(Cls, run) {
  let inst;
  const orig = Cls.prototype.open;
  Cls.prototype.open = function () { inst = this; };
  try { await run(); } finally { Cls.prototype.open = orig; }
  return inst;
}

test('plugin loads', async () => {
  const p = new TicketNoteBridge(fakeApp(), manifest);
  await p.onload();
  ok(p instanceof TicketNoteBridge);
});

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

test('all defaults', () => {
  deepEq(DEFAULTS, {
    site: '', email: '', token: '',
    jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    folder: 'Tickets', fileNameSeparator: '-', template: '', logToDaily: true,
    dailyHeading: '## Tickets', refreshOnStartup: true,
  });
});

test('startup refresh without credentials is silent', async () => {
  const notices = require('./obsidian-stub').Notice.log = [];
  const p = new TicketNoteBridge(fakeApp(), manifest); await p.onload();
  eq(notices.length, 0);
});

test('startup refresh failure is silent', async () => {
  const notices = captureNotices();
  const app = fakeApp({ files: { 'Tickets/a.md': '' }, fm: { 'Tickets/a.md': { jira_key: 'IT-1' } } });
  const p = new TicketNoteBridge(app, manifest);
  p.loadData = async () => ({ ...CREDS });
  let called = false;
  p.client = () => ({ site: SITE, search: async () => { called = true; throw new JiraError("Can't reach Jira", 0); } });
  await p.onload();
  await new Promise((r) => setTimeout(r, 10));
  ok(called);
  eq(notices.length, 0);
});

test('startup refresh is skipped when disabled', async () => {
  const p = new TicketNoteBridge(fakeApp(), manifest);
  p.loadData = async () => ({ ...CREDS, refreshOnStartup: false });
  let called = false;
  p.refreshAll = async () => { called = true; };
  await p.onload();
  eq(called, false);
});

test('client() needs site, email and token', async () => {
  const notices = captureNotices();
  const p = await plugin({}, { site: SITE, email: 'me@example.com' });
  eq(p.client(), null);
  deepEq(notices, ['Set your Jira site, email and API token in settings']);
  eq(p.client(true), null);
  eq(notices.length, 1);
  p.settings.token = 'tok';
  p.settings.site = 'x.atlassian.net/';
  const c = p.client();
  eq(c.site, SITE);
  eq(c.email, 'me@example.com');
});

test('notesIndex maps upper-cased jira_key to files', async () => {
  const p = await plugin({ files: { 'b.md': '', 'a.md': '', 'c.md': '' }, fm: { 'b.md': { jira_key: 'it-1' }, 'a.md': { jira_key: 'IT-1' } } });
  const idx = p.notesIndex();
  deepEq([...idx.keys()], ['IT-1']);
  deepEq(idx.get('IT-1').map((f) => f.path), ['a.md', 'b.md']);
});

test('openOrCreate opens an existing note without creating or logging', async () => {
  const daily = `Daily/${today()}.md`;
  const p = await plugin({ files: { 'Notes/x.md': '', [daily]: '' }, fm: { 'Notes/x.md': { jira_key: 'it-123' } } });
  await p.openOrCreate(T);
  deepEq(p.app.store.opened, ['Notes/x.md']);
  deepEq(p.app.store.log, []);
  eq(p.app.store.data.get(daily), '');
});

test('openOrCreate creates the note, logs it and opens it', async () => {
  const daily = `Daily/${today()}.md`;
  const p = await plugin({ files: { [daily]: '# Today\n' } });
  await p.openOrCreate(T);
  const path = 'Tickets/IT-123-fix-the-printer.md';
  deepEq(p.app.store.log, ['createFolder Tickets', 'create ' + path, 'fm ' + path]);
  deepEq(p.app.store.opened, [path]);
  eq(p.app.store.data.get(path), '# IT-123 Fix the printer\n\n');
  const fm = p.app.store.fm.get(path);
  eq(fm.jira_key, 'IT-123'); eq(fm.jira_url, T.url); eq(fm.jira_status, 'In Progress');
  eq(fm.jira_status_category, 'in progress'); eq(fm.jira_priority, 'High'); eq(fm.due, '');
  eq(fm.jira_summary, 'Fix the printer');
  ok(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(fm.created));
  const out = p.app.store.data.get(daily);
  ok(/^# Today\n\n## Tickets\n- \d\d:\d\d \[\[IT-123-fix-the-printer\]\]\n$/.test(out), out);
});

test('openOrCreate shows vault errors as a notice', async () => {
  const notices = captureNotices();
  const p = await plugin();
  p.app.vault.create = async () => { throw new Error('disk full'); };
  await p.openOrCreate(T);
  deepEq(notices, ['disk full']);
  deepEq(p.app.store.opened, []);
});

test('createNote appends " 2", " 3" on collisions and keeps an existing folder', async () => {
  const p = await plugin({ folders: ['Tickets'], files: { 'Tickets/IT-123-fix-the-printer.md': 'other', 'Tickets/IT-123-fix-the-printer 2.md': 'other' } });
  const f = await p.createNote(T);
  eq(f.path, 'Tickets/IT-123-fix-the-printer 3.md');
  ok(!p.app.store.log.some((l) => l.startsWith('createFolder')));
});

test('createNote uses the separator setting and an empty folder means vault root', async () => {
  const p = await plugin({}, { folder: '', fileNameSeparator: '_' });
  const f = await p.createNote(T);
  eq(f.path, 'IT-123_fix_the_printer.md');
  ok(!p.app.store.log.some((l) => l.startsWith('createFolder')));
});

test('createNote renders the template without its frontmatter', async () => {
  const p = await plugin({ files: { 'Templates/Ticket.md': '---\ntags: x\n---\n# {{key}}: {{summary}}\n{{url}} {{nope}}\n' } }, { template: 'Templates/Ticket' });
  const f = await p.createNote(T);
  eq(p.app.store.data.get(f.path), '# IT-123: Fix the printer\n' + T.url + ' {{nope}}\n');
  eq(p.app.store.fm.get(f.path).tags, undefined);
});

test('createNote falls back to the default body when the template is missing', async () => {
  const notices = captureNotices();
  const p = await plugin({}, { template: 'Templates/Nope.md' });
  const f = await p.createNote(T);
  eq(p.app.store.data.get(f.path), '# IT-123 Fix the printer\n\n');
  eq(notices.length, 0);
});

test('dailyNotePath uses folder and format', () => {
  const m = stub.moment('2026-10-16T09:05:00');
  eq(dailyNotePath({ folder: 'Daily/', format: 'YYYY-MM-DD' }, m), 'Daily/2026-10-16.md');
  eq(dailyNotePath({ folder: '', format: '' }, m), '2026-10-16.md');
  eq(dailyNotePath(undefined, m), '2026-10-16.md');
});

test('sectionContains looks only under the heading', () => {
  const data = '# Day\n[[a]]\n## Tickets\n- 10:00 [[b]]\n### Sub\n[[s]]\n## Other\n- [[c]]\n';
  ok(sectionContains(data, '## Tickets', '[[b]]'));
  ok(sectionContains(data, '## Tickets', '[[s]]'));
  ok(!sectionContains(data, '## Tickets', '[[a]]'));
  ok(!sectionContains(data, '## Tickets', '[[c]]'));
  ok(!sectionContains('no heading', '## Tickets', 'no'));
});

test('logToDaily adds the line once under the heading', async () => {
  const daily = `Daily/${today()}.md`;
  const p = await plugin({ files: { [daily]: '## Tickets\n- 08:00 [[old]]\n\n## Notes\nhi\n', 'Tickets/n.md': '' } });
  const file = p.app.store.files.get('Tickets/n.md');
  await p.logToDaily(file);
  await p.logToDaily(file);
  const out = p.app.store.data.get(daily);
  ok(/^## Tickets\n- 08:00 \[\[old\]\]\n- \d\d:\d\d \[\[n\]\]\n\n## Notes\nhi\n$/.test(out), out);
});

test('logToDaily notices a missing daily note and respects the toggle', async () => {
  const notices = captureNotices();
  const p = await plugin({ files: { 'Tickets/n.md': '' } });
  await p.logToDaily(p.app.store.files.get('Tickets/n.md'));
  deepEq(notices, ["Today's daily note doesn't exist yet, so this wasn't logged."]);
  p.settings.logToDaily = false;
  await p.logToDaily(p.app.store.files.get('Tickets/n.md'));
  eq(notices.length, 1);
});

test('insertInline writes the line, a child bullet and puts the cursor at the end', async () => {
  const p = await plugin({ files: { 'Tickets/IT-123-x.md': '', 'Daily/d.md': '' }, fm: { 'Tickets/IT-123-x.md': { jira_key: 'IT-123' } } });
  p.app.workspace.active = p.app.store.files.get('Daily/d.md');
  const ed = fakeEditor();
  p.insertInline(ed, { ...T, due: '2026-10-20' });
  eq(ed.text, `- [IT-123 Fix the printer](${T.url}) · In Progress · due 2026-10-20 · [[IT-123-x]]\n\t- `);
  deepEq(ed.cursor, { line: 1, ch: 3 });
  const ed2 = fakeEditor();
  p.insertInline(ed2, { ...T, key: 'IT-9' });
  eq(ed2.text, `- [IT-9 Fix the printer](${T.url}) · In Progress\n\t- `);
  const ed3 = fakeEditor();
  ed3.lineText = '\t  ';
  p.insertInline(ed3, { ...T, key: 'IT-9' });
  eq(ed3.text, `- [IT-9 Fix the printer](${T.url}) · In Progress\n\t  \t- `);
});

test('refreshAll writes only changed values and marks missing tickets', async () => {
  const notices = captureNotices();
  const same = { jira_key: 'IT-1', jira_url: SITE + '/browse/IT-1', jira_summary: 'One', jira_status: 'In Progress', jira_status_category: 'in progress', jira_priority: 'High', due: null };
  const two = { ...same, jira_key: 'IT-2', jira_url: SITE + '/browse/IT-2', jira_summary: 'Two' };
  const p = await plugin({
    files: { 'a.md': '', 'b.md': '', 'b2.md': '', 'c.md': '', 'd.md': '' },
    fm: {
      'a.md': same,
      'b.md': { ...two, jira_summary: 'Old' },
      'b2.md': two,
      'c.md': { ...same, jira_key: 'IT-3', jira_summary: 'keep me' },
      'd.md': { ...same, jira_key: 'OLD-4', jira_url: SITE + '/browse/OLD-4', jira_summary: 'Four' },
    },
  }, CREDS);
  const c = fakeClient({
    search: () => [issue('IT-1', 'One'), issue('IT-2', 'Two')],
    issue: (k) => (k === 'OLD-4' ? issue('NEW-4', 'Four') : null),
  });
  p.client = () => c;
  await p.refreshAll(true);
  const fm = (path) => p.app.store.fm.get(path);
  deepEq(p.app.store.log.sort(), ['fm b.md', 'fm c.md', 'fm d.md']);
  eq(fm('b.md').jira_summary, 'Two');
  deepEq(fm('c.md'), { ...same, jira_key: 'IT-3', jira_summary: 'keep me', jira_status: 'missing' });
  eq(fm('d.md').jira_key, 'NEW-4');
  eq(fm('d.md').jira_url, SITE + '/browse/NEW-4');
  deepEq(notices, ['Refreshed 5 ticket notes (3 changed)']);
});

test('refreshAll: no notes, errors and missing credentials', async () => {
  const notices = captureNotices();
  const p = await plugin({}, CREDS);
  await p.refreshAll(true);
  deepEq(notices, ['No ticket notes to refresh']);
  await p.refreshAll(false);
  eq(notices.length, 1);

  const q = await plugin({ files: { 'a.md': '' }, fm: { 'a.md': { jira_key: 'IT-1' } } }, CREDS);
  q.client = () => ({ site: SITE, search: async () => { throw new JiraError('Jira rejected the credentials (check email and API token)', 401); } });
  await q.refreshAll(true);
  eq(notices[1], 'Jira rejected the credentials (check email and API token)');
  await q.refreshAll(false);
  eq(notices.length, 2);

  const r = await plugin({ files: { 'a.md': '' }, fm: { 'a.md': { jira_key: 'IT-1' } } });
  await r.refreshAll(true);
  eq(notices[2], 'Set your Jira site, email and API token in settings');
});

test('TicketPicker text marks tickets that have a note', () => {
  const picker = new TicketPicker(fakeApp(), [T, { ...T, key: 'IT-9', status: '' }], (k) => k === 'IT-123', () => {});
  eq(picker.getItemText(T), '📝 IT-123 Fix the printer · In Progress');
  eq(picker.getItemText({ ...T, key: 'IT-9', status: '' }), 'IT-9 Fix the printer');
  eq(picker.emptyStateText, 'No tickets match your JQL');
  eq(picker.getItems().length, 2);
});

test('open-ticket-note searches the JQL and the choice opens the note', async () => {
  const p = await plugin({}, { ...CREDS, jql: 'project = IT' });
  const c = fakeClient({ search: () => [issue('IT-123')] });
  p.client = () => c;
  const picker = await capture(TicketPicker, () => p.commands.find((x) => x.id === 'open-ticket-note').callback());
  deepEq(c.calls, [['search', 'project = IT', undefined]]);
  deepEq(picker.getItems(), [T]);
  await picker.onChooseItem(T);
  deepEq(p.app.store.opened, ['Tickets/IT-123-fix-the-printer.md']);
});

test('open-ticket-note shows Jira errors and opens no picker', async () => {
  const notices = captureNotices();
  const p = await plugin({}, CREDS);
  p.client = () => ({ site: SITE, search: async () => { throw new JiraError("Can't reach Jira", 0); } });
  const picker = await capture(TicketPicker, () => p.commands.find((x) => x.id === 'open-ticket-note').callback());
  eq(picker, undefined);
  deepEq(notices, ["Can't reach Jira"]);
});

test('insert-ticket-inline inserts into the editor captured at command time', async () => {
  const p = await plugin({}, CREDS);
  p.client = () => fakeClient({ search: () => [issue('IT-123')] });
  const ed = fakeEditor();
  const picker = await capture(TicketPicker, () => p.commands.find((x) => x.id === 'insert-ticket-inline').editorCallback(ed, {}));
  await picker.onChooseItem(T);
  ok(ed.text.startsWith('- [IT-123 Fix the printer]'));
});

test('open-ticket-in-jira is available only when the note has jira_url', async () => {
  const p = await plugin({ files: { 'a.md': '', 'b.md': '' }, fm: { 'a.md': { jira_key: 'IT-1', jira_url: SITE + '/browse/IT-1' } } });
  const cmd = p.commands.find((x) => x.id === 'open-ticket-in-jira');
  eq(cmd.checkCallback(true), false);
  p.app.workspace.active = p.app.store.files.get('b.md');
  eq(cmd.checkCallback(true), false);
  p.app.workspace.active = p.app.store.files.get('a.md');
  const opened = [];
  global.window = { open: (u) => opened.push(u) };
  try {
    eq(cmd.checkCallback(true), true);
    deepEq(opened, []);
    cmd.checkCallback(false);
    deepEq(opened, [SITE + '/browse/IT-1']);
  } finally { delete global.window; }
});

test('search modal: short queries, keys, text and errors', async () => {
  const p = await plugin({ files: { 'a.md': '' }, fm: { 'a.md': { jira_key: 'IT-123' } } }, CREDS);
  const c = fakeClient({
    issue: (k) => (k === 'IT-123' ? issue('IT-123') : null),
    search: (jql) => { if (jql.includes('boom')) throw new JiraError('Bad JQL', 400); return [issue('IT-5', 'Printer')]; },
  });
  const m = new TicketSearchModal(p.app, p, c, () => {});
  m.delay = 1;
  deepEq(await m.getSuggestions('a'), []);
  eq(c.calls.length, 0);
  deepEq(await m.getSuggestions('it-123'), [T]);
  deepEq(c.calls.pop(), ['issue', 'IT-123']);
  deepEq(await m.getSuggestions('IT-999'), []);
  const res = await m.getSuggestions('printer "x"');
  eq(res[0].key, 'IT-5');
  deepEq(c.calls.pop(), ['search', 'text ~ "printer \\"x\\"" ORDER BY updated DESC', { maxResults: 20, cap: 20 }]);
  deepEq(await m.getSuggestions('boom'), []);
  eq(m.emptyStateText, 'Bad JQL');
  const el = { setText(s) { this.text = s; } };
  m.renderSuggestion(T, el);
  eq(el.text, '📝 IT-123 Fix the printer · In Progress');
});

test('search modal: superseded calls resolve to the newest results', async () => {
  const p = await plugin({}, CREDS);
  const c = fakeClient({ search: (jql) => [issue('IT-1', jql)] });
  const m = new TicketSearchModal(p.app, p, c, () => {});
  m.delay = 20;
  const first = m.getSuggestions('pri');
  const second = m.getSuggestions('printer');
  const [a, b] = await Promise.all([first, second]);
  eq(c.calls.length, 1);
  deepEq(a, b);
  ok(b[0].summary.includes('printer'));
});

test('search commands need credentials and the choice inserts inline', async () => {
  const notices = captureNotices();
  const p = await plugin();
  const none = await capture(TicketSearchModal, () => p.commands.find((x) => x.id === 'open-ticket-note-search').callback());
  eq(none, undefined);
  deepEq(notices, ['Set your Jira site, email and API token in settings']);
  Object.assign(p.settings, CREDS);
  const ed = fakeEditor();
  const modal = await capture(TicketSearchModal, () => p.commands.find((x) => x.id === 'insert-ticket-inline-search').editorCallback(ed, {}));
  await modal.onChooseSuggestion(T);
  ok(ed.text.startsWith('- [IT-123 Fix the printer]'));
});

test('settings tab: site is normalised, token is a password, Test shows the user', async () => {
  const notices = captureNotices();
  const p = await plugin({}, CREDS);
  p.client = () => fakeClient();
  const tab = new BridgeSettingTab(p.app, p);
  tab.display();
  const byName = (n) => tab.containerEl.settings.find((s) => s.name === n);
  deepEq(tab.containerEl.settings.map((s) => s.name), ['Site URL', 'Email', 'API token', 'JQL for "my tickets"',
    'Folder', 'File name separator', 'Template', 'Log to daily note', 'Daily note heading', 'Refresh on startup']);
  await byName('Site URL').components[0].changeHandler('x.atlassian.net/ ');
  eq(p.settings.site, SITE);
  eq(p.saved.site, SITE);
  const token = byName('API token');
  eq(token.components[0].inputEl.type, 'password');
  await token.components.find((c) => c.kind === 'button').clickHandler();
  deepEq(notices, ['Connected as Me']);
  p.client = () => ({ myself: async () => '<html>' });
  await token.components.find((c) => c.kind === 'button').clickHandler();
  eq(notices[notices.length - 1], 'Unexpected response from Jira (check the site URL)');
  const toggle = byName('Log to daily note').components[0];
  eq(toggle.value, true);
  await toggle.changeHandler(false);
  eq(p.settings.logToDaily, false);
  eq(byName('JQL for "my tickets"').components[0].kind, 'textarea');
});
