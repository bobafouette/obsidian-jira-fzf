'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSite, noteFileName, isIssueKey, escapeJqlString, textSearchJql, keysJql, chunk,
  mapIssue, noteProps, propsDiff, indexNotes, inlineLine, insertUnderHeading,
  renderTemplate, stripFrontmatter, defaultBody,
} = require('./load-plugin');

const eq = assert.equal;
const deepEq = assert.deepEqual;
const ok = assert.ok;
const T = { key: 'IT-123', url: 'https://x.atlassian.net/browse/IT-123', summary: 'Fix the printer', status: 'In Progress', statusCategory: 'in progress', priority: 'High', due: '' };

test('normalizeSite', () => {
  eq(normalizeSite(' yoursite.atlassian.net/ '), 'https://yoursite.atlassian.net');
  eq(normalizeSite('https://yoursite.atlassian.net/jira/your-work?x=1'), 'https://yoursite.atlassian.net');
  eq(normalizeSite(''), '');
  eq(normalizeSite('   '), '');
  eq(normalizeSite('http://'), '');
});

test('noteFileName', () => {
  eq(noteFileName('IT-123', 'Fix the printer', '-'), 'IT-123-fix-the-printer');
  eq(noteFileName('it-123', 'Fix the printer', ''), 'IT-123 fix the printer');
  eq(noteFileName('IT-123', 'a/b:c*?"<>|#^[]\\ d', '-'), 'IT-123-a-b-c-d');
  eq(noteFileName('IT-123', '...Hidden...', '-'), 'IT-123-hidden');
  for (const s of ['', '///', '...']) eq(noteFileName('IT-123', s, '-'), 'IT-123');
  const long = noteFileName('IT-123', 'word '.repeat(60), '-');
  ok(long.length <= 100 && !long.endsWith('-'));
});

test('keys and JQL', () => {
  ok(isIssueKey('IT-123') && isIssueKey('it-1') && isIssueKey('A1_B-9'));
  ok(!isIssueKey('IT123') && !isIssueKey('IT-') && !isIssueKey('I T-1'));
  eq(escapeJqlString('say "hi" \\ x'), 'say \\"hi\\" \\\\ x');
  eq(textSearchJql('printer "lab"'), 'text ~ "printer \\"lab\\"" ORDER BY updated DESC');
  eq(keysJql(['it-1', 'B-2', 'nope']), 'key in (IT-1, B-2)');
  deepEq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  deepEq(chunk([], 50), []);
});

test('mapIssue', () => {
  const raw = { key: 'IT-123', fields: { summary: 'Fix the printer', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, duedate: '2026-10-20' } };
  deepEq(mapIssue(raw, 'https://x.atlassian.net'), { ...T, due: '2026-10-20' });
  const bare = mapIssue({ key: 'IT-1', fields: { summary: 's', status: { name: 'Odd', statusCategory: { key: 'weird' } }, priority: null, duedate: null } }, 'https://x.atlassian.net');
  eq(bare.statusCategory, 'todo'); eq(bare.priority, ''); eq(bare.due, '');
});

test('noteProps and propsDiff', () => {
  deepEq(Object.keys(noteProps(T)), ['jira_key', 'jira_url', 'jira_summary', 'jira_status', 'jira_status_category', 'jira_priority', 'due']);
  deepEq(propsDiff({ ...noteProps(T), created: '2026-10-16 09:00' }, noteProps(T)), {});
  deepEq(propsDiff({ jira_key: 'IT-123' }, { jira_key: 'IT-123', jira_priority: '' }), {});
  deepEq(propsDiff({ jira_status: 'To Do' }, { jira_status: 'missing' }), { jira_status: 'missing' });
});

test('indexNotes', () => {
  const files = [{ path: 'b.md' }, { path: 'a.md' }, { path: 'c.md' }];
  const fm = { 'a.md': { jira_key: 'it-1' }, 'b.md': { jira_key: 'IT-1' }, 'c.md': {} };
  const idx = indexNotes(files, (f) => fm[f.path]);
  deepEq(idx.get('IT-1').map((f) => f.path), ['a.md', 'b.md']); eq(idx.size, 1);
});

test('inlineLine', () => {
  eq(inlineLine(T, null), '- [IT-123 Fix the printer](https://x.atlassian.net/browse/IT-123) · In Progress');
  eq(inlineLine({ ...T, due: '2026-10-20' }, '[[IT-123-fix-the-printer]]'),
    '- [IT-123 Fix the printer](https://x.atlassian.net/browse/IT-123) · In Progress · due 2026-10-20 · [[IT-123-fix-the-printer]]');
  ok(inlineLine({ ...T, summary: 'Fix [prod] now' }, null).startsWith('- [IT-123 Fix \\[prod\\] now]('));
});

test('insertUnderHeading', () => {
  eq(insertUnderHeading('', '## Tickets', '- l'), '## Tickets\n- l\n');
  eq(insertUnderHeading('# Day\n\ntext\n', '## Tickets', '- l'), '# Day\n\ntext\n\n## Tickets\n- l\n');
  eq(insertUnderHeading('## Tickets\n- a\n\n## Other\nx\n', '## Tickets', '- l'), '## Tickets\n- a\n- l\n\n## Other\nx\n');
});

test('templates', () => {
  eq(renderTemplate('{{key}}|{{summary}}|{{url}}|{{status}}|{{priority}}|{{due}}|{{other}}|{{constructor}}', T),
    'IT-123|Fix the printer|https://x.atlassian.net/browse/IT-123|In Progress|High||{{other}}|{{constructor}}');
  eq(stripFrontmatter('---\na: 1\n---\nbody\n'), 'body\n');
  eq(defaultBody(T), '# IT-123 Fix the printer\n\n');
});
