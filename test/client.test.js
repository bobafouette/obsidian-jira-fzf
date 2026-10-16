'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authHeader, JiraError, paginate, JiraClient, fetchTickets, FIELDS,
} = require('./load-plugin');

const eq = assert.equal;
const deepEq = assert.deepEqual;
const ok = assert.ok;
const rejects = assert.rejects;

const cfg = { site: 'https://x.atlassian.net', email: 'me@example.com', token: 'tok' };
const allCalls = [];

function fakeRequest(responses) {
  const queue = responses.slice();
  const req = async (arg) => {
    req.calls.push(arg);
    allCalls.push(arg);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  req.calls = [];
  return req;
}

test('authHeader', () => {
  eq(authHeader('me@example.com', 'tok'), 'Basic bWVAZXhhbXBsZS5jb206dG9r');
  eq(authHeader('josé@example.com', 't'), 'Basic ' + Buffer.from('josé@example.com:t', 'utf8').toString('base64'));
});

test('paginate', async () => {
  const pages = { undefined: { issues: [1, 2], nextPageToken: 'a' }, a: { issues: [3], nextPageToken: 'b', isLast: true } };
  deepEq(await paginate(async (t) => pages[t]), [1, 2, 3]);
  deepEq(await paginate(async () => ({ issues: [1] })), [1]);
  eq((await paginate(async () => ({ issues: Array(100).fill(0), nextPageToken: 'n' }), 250)).length, 250);
});

test('JiraClient requests', async () => {
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
  eq(q.has('nextPageToken'), false);
});

test('JiraClient follows nextPageToken', async () => {
  const req = fakeRequest([
    { status: 200, json: { issues: [{ key: 'A-1' }], nextPageToken: 'tok2' } },
    { status: 200, json: { issues: [{ key: 'A-2' }], isLast: true } },
  ]);
  const out = await new JiraClient(cfg, req).search('x');
  deepEq(out.map((i) => i.key), ['A-1', 'A-2']);
  eq(new URL(req.calls[1].url).searchParams.get('nextPageToken'), 'tok2');
});

test('JiraClient issue and errors', async () => {
  eq(await new JiraClient(cfg, fakeRequest([{ status: 404, json: {} }])).issue('IT-9'), null);
  const r = fakeRequest([{ status: 200, json: { key: 'IT-1' } }]);
  eq((await new JiraClient(cfg, r).issue('IT-1')).key, 'IT-1');
  ok(r.calls[0].url.startsWith('https://x.atlassian.net/rest/api/3/issue/IT-1?'));
  await rejects(new JiraClient(cfg, fakeRequest([{ status: 401, json: {} }])).myself(), /Jira rejected the credentials \(check email and API token\)/);
  await rejects(new JiraClient(cfg, fakeRequest([{ status: 403 }])).myself(), /Jira rejected the credentials/);
  await rejects(new JiraClient(cfg, fakeRequest([{ status: 400, json: { errorMessages: ['Bad', 'JQL'] } }])).search('x'), (e) => e.status === 400 && e.message === 'Bad; JQL');
  await rejects(new JiraClient(cfg, fakeRequest([{ status: 500, json: {} }])).myself(), /Jira returned HTTP 500/);
  await rejects(new JiraClient(cfg, fakeRequest([{ status: 500, get json() { throw new Error('not json'); } }])).myself(), /Jira returned HTTP 500/);
  await rejects(new JiraClient(cfg, fakeRequest([new Error('offline')])).myself(), (e) => e instanceof JiraError && e.status === 0 && /Can't reach Jira/.test(e.message));
});

test('fetchTickets', async () => {
  const store = { 'IT-1': { key: 'IT-1' }, 'IT-2': { key: 'OPS-7' } };
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
  eq(counting.searches.length, 3);
  ok(counting.searches.every((j) => j.split(',').length <= 50));
});

test('fetchTickets sanitises input and rethrows other errors', async () => {
  const c = { searches: [], async search(j) { this.searches.push(j); return [{ key: 'IT-1' }]; }, async issue() { return null; } };
  const r = await fetchTickets(c, ['it-1', 'IT-1', 'nope', '']);
  eq(c.searches.length, 1);
  eq(c.searches[0], 'key in (IT-1)');
  deepEq([...r.found.keys()], ['IT-1']);
  const empty = await fetchTickets(c, ['bad', '']);
  eq(c.searches.length, 1);
  eq(empty.found.size, 0); eq(empty.missing.size, 0);
  const boom = { async search() { throw new JiraError('down', 500); }, async issue() { return null; } };
  await rejects(fetchTickets(boom, ['IT-1']), (e) => e.status === 500);
});

test('fetchTickets resolves a moved ticket found by batch search', async () => {
  const c = {
    async search() { return [{ key: 'OPS-7' }]; },
    async issue(k) { return k === 'IT-2' ? { key: 'OPS-7' } : null; },
  };
  const r = await fetchTickets(c, ['IT-2']);
  eq(r.found.get('IT-2').key, 'OPS-7');
  eq(r.missing.size, 0);
});

test('read-only: every call used GET', () => {
  ok(allCalls.length > 0);
  ok(allCalls.every((c) => c.method === 'GET'));
});

test('a 2xx with an unreadable body is an error', async () => {
  const bad = { status: 200, get json() { throw new Error('not json'); } };
  await rejects(new JiraClient(cfg, fakeRequest([bad])).myself(), (e) => e instanceof JiraError
    && e.message === 'Unexpected response from Jira (check the site URL)' && e.status === 200);
});

test('non-2xx falls back to the errors object', async () => {
  const req = fakeRequest([{ status: 400, json: { errorMessages: [], errors: { jql: 'Bad field' } } }]);
  await rejects(new JiraClient(cfg, req).get('/x'), (e) => e.message === 'Bad field');
});
