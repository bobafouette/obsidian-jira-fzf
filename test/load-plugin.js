'use strict';
// Loads main.js with `require('obsidian')` redirected to the local stub,
// without needing node_modules.
const Module = require('node:module');
const path = require('node:path');

const STUB = path.join(__dirname, 'obsidian-stub.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return STUB;
  return origResolve.call(this, request, ...rest);
};

const TicketNoteBridge = require(path.join(__dirname, '..', 'main.js'));

module.exports = { ...TicketNoteBridge._test, TicketNoteBridge };
