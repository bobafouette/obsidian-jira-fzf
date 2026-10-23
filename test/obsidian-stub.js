'use strict';
// Minimal fake of the `obsidian` module: just enough for main.js to load
// under plain Node so its pure helpers can be unit-tested.

class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  addCommand(cmd) { (this.commands = this.commands || []).push(cmd); }
  addRibbonIcon(icon, title, callback) {
    const el = { icon, title, callback };
    (this.ribbon = this.ribbon || []).push(el);
    return el;
  }
  addSettingTab() {}
  registerEvent() {}
  async loadData() { return {}; }
  async saveData() {}
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app; this.plugin = plugin;
    this.containerEl = { settings: [], empty() { this.settings = []; } };
  }
}

// A fake input component: records its value and change handler.
class Component {
  constructor(kind) { this.kind = kind; this.inputEl = {}; this.value = undefined; }
  setPlaceholder(p) { this.placeholder = p; return this; }
  setValue(v) { this.value = v; return this; }
  onChange(fn) { this.changeHandler = fn; return this; }
  setButtonText(t) { this.text = t; return this; }
  onClick(fn) { this.clickHandler = fn; return this; }
}

// Settings register themselves on containerEl.settings so tests can drive them.
class Setting {
  constructor(containerEl) {
    this.components = [];
    if (containerEl && Array.isArray(containerEl.settings)) containerEl.settings.push(this);
  }
  setName(n) { this.name = n; return this; }
  setDesc(d) { this.desc = d; return this; }
  add(kind, cb) { const c = new Component(kind); this.components.push(c); if (cb) cb(c); return this; }
  addText(cb) { return this.add('text', cb); }
  addTextArea(cb) { return this.add('textarea', cb); }
  addToggle(cb) { return this.add('toggle', cb); }
  addButton(cb) { return this.add('button', cb); }
}

// Pushes every message to Notice.log when a test sets it to an array.
class Notice {
  constructor(message, timeout) {
    this.message = message;
    this.timeout = timeout;
    this.hidden = false;
    if (Array.isArray(Notice.log)) Notice.log.push(message);
    if (Array.isArray(Notice.all)) Notice.all.push(this);
  }
  hide() { this.hidden = true; }
}

class Modal {
  constructor(app) { this.app = app; this.contentEl = {}; }
  open() {}
  close() {}
}

class FuzzySuggestModal extends Modal {
  setPlaceholder(p) { this.placeholder = p; }
}

class SuggestModal extends Modal {
  setPlaceholder(p) { this.placeholder = p; }
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
