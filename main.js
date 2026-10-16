'use strict';
const { Plugin, requestUrl } = require('obsidian');

const CATEGORY = { new: 'todo', indeterminate: 'in progress', done: 'done' };
const NAME_FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;
const NAME_MAX = 100;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSite(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    return u.origin === 'null' ? '' : u.origin;
  } catch (e) {
    return '';
  }
}

function noteFileName(key, summary, sep) {
  const s = sep && sep.trim() ? sep : ' ';
  const sepRe = escapeRegExp(s);
  const junk = '(?:[.\\s]|' + sepRe + ')';
  let part = String(summary || '').toLowerCase()
    .replace(NAME_FORBIDDEN, s)
    .replace(new RegExp('(?:\\s|' + sepRe + ')+', 'g'), s)
    .replace(new RegExp('^' + junk + '+'), '')
    .replace(new RegExp(junk + '+$'), '');
  const k = String(key || '').toUpperCase();
  let name = part ? k + s + part : k;
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX);
  return name.replace(new RegExp(junk + '+$'), '');
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
  const summary = String(t.summary).replace(/\s+/g, ' ').trim().replace(/[[\]]/g, '\\$&');
  const parts = ['[' + t.key + ' ' + summary + '](' + t.url + ')'];
  if (t.status) parts.push(t.status);
  if (t.due) parts.push('due ' + t.due);
  if (noteLink) parts.push(noteLink);
  return '- ' + parts.join(' · ');
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
  return String(s).replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

function defaultBody(t) {
  return '# ' + t.key + ' ' + t.summary + '\n\n';
}

const FIELDS = 'summary,status,priority,duedate';
const BATCH = 50;

function authHeader(email, token) {
  const bytes = new TextEncoder().encode(email + ':' + token);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

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
    if (status >= 200 && status < 300) return readJson(res);
    if (status === 401 || status === 403) {
      throw new JiraError('Jira rejected the credentials (check email and API token)', status);
    }
    const body = readJson(res);
    const msgs = body && Array.isArray(body.errorMessages) ? body.errorMessages : [];
    throw new JiraError(msgs.length ? msgs.join('; ') : 'Jira returned HTTP ' + status, status);
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

class TicketNoteBridge extends Plugin {
  async onload() {}
}

TicketNoteBridge._test = {
  CATEGORY, normalizeSite, noteFileName, isIssueKey, escapeJqlString, textSearchJql, keysJql, chunk,
  mapIssue, noteProps, propsDiff, indexNotes, inlineLine, insertUnderHeading,
  renderTemplate, stripFrontmatter, defaultBody,
  FIELDS, authHeader, JiraError, paginate, JiraClient, fetchTickets,
};
module.exports = TicketNoteBridge;
