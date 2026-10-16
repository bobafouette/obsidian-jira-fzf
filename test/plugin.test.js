'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function fakeApp() {
  return {
    workspace: { onLayoutReady: (f) => f(), getActiveFile: () => null },
    metadataCache: {},
    vault: { getMarkdownFiles: () => [] },
  };
}

test('plugin loads', async () => {
  const { TicketNoteBridge } = require('./load-plugin');
  const p = new TicketNoteBridge(fakeApp(), { id: 'ticket-note-bridge' });
  await p.onload();
  assert.ok(p instanceof TicketNoteBridge);
});
