'use strict';
// Minimal fake of the `obsidian` module: just enough for main.js to load
// under plain Node so its pure helpers can be unit-tested.

class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  addCommand(cmd) { (this.commands = this.commands || []).push(cmd); }
  addSettingTab() {}
  registerEvent() {}
  async loadData() { return {}; }
  async saveData() {}
}

class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = {}; }
}

class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addTextArea() { return this; }
  addToggle() { return this; }
  addButton() { return this; }
}

class Notice { constructor(message) { this.message = message; } }

class Modal {
  constructor(app) { this.app = app; this.contentEl = {}; }
  open() {}
  close() {}
}

class FuzzySuggestModal extends Modal {
  setPlaceholder() {}
}

class SuggestModal extends Modal {
  setPlaceholder() {}
}

class MarkdownView {}

class TFile {}

class TFolder {}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

async function requestUrl() {
  throw new Error('requestUrl is not available in tests');
}

// Tiny moment() replacement supporting the tokens main.js uses.
function moment(date) {
  const d = date ? new Date(date) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    format(fmt = 'YYYY-MM-DDTHH:mm:ss') {
      return fmt
        .replace('YYYY', String(d.getFullYear()))
        .replace('MM', p(d.getMonth() + 1))
        .replace('DD', p(d.getDate()))
        .replace('HH', p(d.getHours()))
        .replace('mm', p(d.getMinutes()))
        .replace('ss', p(d.getSeconds()));
    },
  };
}

module.exports = {
  Plugin, PluginSettingTab, Setting, Notice, FuzzySuggestModal, Modal,
  SuggestModal, MarkdownView, TFile, TFolder, normalizePath, requestUrl, moment,
};
