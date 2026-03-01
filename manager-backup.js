/**
 * IG 2FA MANAGER - Terminal UI
 * Multi-thread Instagram automation manager
 * 
 * Dùng: node manager.js
 */

const blessed = require("blessed");
const contrib = require("blessed-contrib");
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const os = require("os");

// ============================================================================
// STATE
// ============================================================================

const CONFIG_FILE = path.join(__dirname, "manager_config.json");

const DEFAULT_CONFIG = {
  chromePath: detectChromePath(),
  maxThreads: 5,
  threads: [],
};

// Mỗi thread có config riêng
const DEFAULT_THREAD_CONFIG = {
  id: 1,
  name: "Thread 1",
  enabled: true,
  dataDir: "data/thread1",

  // Proxy
  useSystemVPN: true,
  proxyEnabled: false,
  proxyApiUrl: "http://127.0.0.1:10000/api/proxy",
  proxyCountry: "DE",
  proxyCount: 1,
  accountsPerProxy: 5,

  // GMX Email
  gmxImapHost: "imap.gmx.net",
  gmxImapPort: 993,
  gmxMaxRetries: 10,
  gmxRetryDelay: 5000,

  // 2FA API
  twoFaApiUrl: "https://2fa.live/tok",

  // Browser
  headless: false,
  browserTimeout: 30000,
  windowSize: "990,830",
  windowPosition: "0,0",

  // Delays (ms)
  delayBetweenAccounts: 2000,
  delayAfterClick: 2000,
  delayPageLoad: 3000,
  delayInputType: 100,
  delayShort: 500,
  delayMedium: 2000,
  delayExtraLong: 5000,

  // Retry
  retryMaxAttempts: 5,
  retryDelay: 2000,

  // Hotmail
  hotmailApiUrl: "https://dongvanfb.net/read_mail_box/",
  hotmailMaxRetries: 10,
};

// ============================================================================
// HELPERS
// ============================================================================

function detectChromePath() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe")
      : "",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch (e) {
      return { ...DEFAULT_CONFIG, threads: [createDefaultThread(1)] };
    }
  }
  return { ...DEFAULT_CONFIG, threads: [createDefaultThread(1)] };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

function createDefaultThread(id) {
  return {
    ...DEFAULT_THREAD_CONFIG,
    id,
    name: `Thread ${id}`,
    dataDir: path.join(__dirname, "data", `thread${id}`),
  };
}

function resolveDataDir(dataDir) {
  // Luon dung absolute path tinh tu __dirname
  if (path.isAbsolute(dataDir)) return dataDir;
  return path.join(__dirname, dataDir);
}

function ensureDataDir(dataDir) {
  const absDir = resolveDataDir(dataDir);

  // Tao thu muc
  const dirs = [
    absDir,
    path.join(absDir, "screenshots"),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // Tao TAT CA file can thiet neu chua co
  const files = ["input.txt", "hotmail.txt", "success.txt", "failed.txt"];
  for (const f of files) {
    const fp = path.join(absDir, f);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, "", "utf-8");
      console.log("Created:", fp);
    }
  }
  return absDir;
}

function getThreadStats(dataDir) {
  const stats = { input: 0, success: 0, failed: 0 };
  try {
    dataDir = resolveDataDir(dataDir); // luon dung absolute path
    const inputFile = path.join(dataDir, "input.txt");
    if (fs.existsSync(inputFile)) {
      const lines = fs.readFileSync(inputFile, "utf-8").trim().split("\n").filter(Boolean);
      stats.input = lines.length;
    }
    const successFile = path.join(dataDir, "success.txt");
    if (fs.existsSync(successFile)) {
      const lines = fs.readFileSync(successFile, "utf-8").trim().split("\n").filter(Boolean);
      stats.success = lines.length;
    }
    const failedFile = path.join(dataDir, "failed.txt");
    if (fs.existsSync(failedFile)) {
      const lines = fs.readFileSync(failedFile, "utf-8").trim().split("\n").filter(Boolean);
      stats.failed = lines.length;
    }
  } catch (e) {}
  return stats;
}

// ============================================================================
// TERMINAL UI
// ============================================================================

class IGManagerUI {
  constructor() {
    this.config = loadConfig();
    this.runningProcesses = new Map(); // threadId -> child process
    this.logs = new Map(); // threadId -> string[]
    this.globalLogs = [];
    this.selectedThread = 0;
    this.currentView = "dashboard"; // dashboard | config | thread_config
    this.editingThread = null;
    this.editingField = null;
    this.inputMode = false;

    this.screen = null;
    this.widgets = {};
    this.init();
  }

  init() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "IG 2FA Manager v2.0",
      fullUnicode: true,
    });

    this.buildLayout();
    this.bindKeys();
    this.render();

    // Refresh stats every 2s
    setInterval(() => this.refreshStats(), 2000);
  }

  buildLayout() {
    const s = this.screen;

    // ── TOP BAR ──────────────────────────────────────────────────────────────
    this.widgets.topBar = blessed.box({
      parent: s,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      content:
        " {bold}{cyan-fg}▐ IG 2FA MANAGER{/} v2.0  " +
        "{yellow-fg}[Q]{/} Quit  {yellow-fg}[N]{/} New Thread  {yellow-fg}[D]{/} Delete  " +
        "{yellow-fg}[S]{/} Start  {yellow-fg}[X]{/} Stop  {yellow-fg}[E]{/} Edit Config  " +
        "{yellow-fg}[G]{/} Global Config  {yellow-fg}[↑↓]{/} Select  {yellow-fg}[Tab]{/} Switch Panel",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        bg: "black",
      },
    });

    // ── LEFT: THREAD LIST ────────────────────────────────────────────────────
    this.widgets.threadList = blessed.list({
      parent: s,
      label: " {bold}THREADS{/} ",
      tags: true,
      top: 3,
      left: 0,
      width: 28,
      height: "100%-10",
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        selected: { bg: "cyan", fg: "black", bold: true },
        item: { fg: "white" },
        label: { fg: "cyan" },
      },
      keys: true,
      mouse: true,
      scrollable: true,
      scrollbar: { style: { bg: "cyan" } },
    });

    // ── MIDDLE: STATS PANEL ──────────────────────────────────────────────────
    this.widgets.statsBox = blessed.box({
      parent: s,
      label: " {bold}STATS{/} ",
      tags: true,
      top: 3,
      left: 28,
      width: 35,
      height: 14,
      border: { type: "line" },
      style: { border: { fg: "green" }, label: { fg: "green" } },
      scrollable: true,
    });

    // ── MIDDLE: CONFIG PREVIEW ───────────────────────────────────────────────
    this.widgets.configPreview = blessed.box({
      parent: s,
      label: " {bold}CONFIG PREVIEW{/} ",
      tags: true,
      top: 17,
      left: 28,
      width: 35,
      height: "100%-24",
      border: { type: "line" },
      style: { border: { fg: "yellow" }, label: { fg: "yellow" } },
      scrollable: true,
      keys: true,
      mouse: true,
    });

    // ── RIGHT: LOG PANEL ─────────────────────────────────────────────────────
    this.widgets.logBox = blessed.log({
      parent: s,
      label: " {bold}LOGS{/} ",
      tags: true,
      top: 3,
      left: 63,
      width: "100%-63",
      height: "100%-10",
      border: { type: "line" },
      style: { border: { fg: "magenta" }, label: { fg: "magenta" } },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { style: { bg: "magenta" } },
      mouse: true,
    });

    // ── BOTTOM STATUS BAR ────────────────────────────────────────────────────
    this.widgets.statusBar = blessed.box({
      parent: s,
      bottom: 4,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      border: { type: "line" },
      style: { border: { fg: "blue" } },
    });

    // ── BOTTOM PROGRESS BARS ─────────────────────────────────────────────────
    this.widgets.progressBar = blessed.box({
      parent: s,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      border: { type: "line" },
      style: { border: { fg: "cyan" } },
    });

    // ── MODAL (for edit / input) ──────────────────────────────────────────────
    this.widgets.modal = blessed.box({
      parent: s,
      top: "center",
      left: "center",
      width: 70,
      height: 32,
      hidden: true,
      border: { type: "line" },
      style: { border: { fg: "yellow" }, bg: "black" },
      tags: true,
      scrollable: true,
      keys: true,
      mouse: true,
    });

    this.widgets.modalInput = blessed.textbox({
      parent: this.widgets.modal,
      bottom: 3,
      left: 2,
      width: "100%-6",
      height: 3,
      hidden: true,
      border: { type: "line" },
      style: { border: { fg: "cyan" }, focus: { border: { fg: "yellow" } } },
      inputOnFocus: true,
    });

    // Focus thread list by default
    this.widgets.threadList.focus();
  }

  bindKeys() {
    const s = this.screen;

    s.key(["q", "C-c"], () => {
      this.shutdown();
    });

    s.key(["n"], () => {
      if (!this.inputMode) this.addThread();
    });

    s.key(["d"], () => {
      if (!this.inputMode) this.deleteThread();
    });

    s.key(["s"], () => {
      if (!this.inputMode) this.startThread();
    });

    s.key(["x"], () => {
      if (!this.inputMode) this.stopThread();
    });

    s.key(["e"], () => {
      if (!this.inputMode) this.openThreadConfig();
    });

    s.key(["g"], () => {
      if (!this.inputMode) this.openGlobalConfig();
    });

    s.key(["a"], () => {
      if (!this.inputMode) this.startAllThreads();
    });

    s.key(["z"], () => {
      if (!this.inputMode) this.stopAllThreads();
    });

    s.key(["tab"], () => {
      if (!this.inputMode) {
        const focusOrder = [
          this.widgets.threadList,
          this.widgets.logBox,
          this.widgets.configPreview,
        ];
        const idx = focusOrder.findIndex((w) => w.focused);
        focusOrder[(idx + 1) % focusOrder.length].focus();
        s.render();
      }
    });

    s.key(["escape"], () => {
      if (this.inputMode) {
        this.closeModal();
      }
    });

    this.widgets.threadList.on("select item", (item, index) => {
      this.selectedThread = index;
      this.updateLogView();
      this.updateConfigPreview();
      s.render();
    });
  }

  // ── THREAD MANAGEMENT ──────────────────────────────────────────────────────

  addThread() {
    const num = this.config.threads.length + 1;
    const id = Date.now();
    const newThread = createDefaultThread(num);
    newThread.id = id;
    newThread.name = `Thread ${num}`;
    newThread.dataDir = path.join(__dirname, "data", `thread${num}`);
    this.config.threads.push(newThread);
    ensureDataDir(newThread.dataDir);
    saveConfig(this.config);
    this.logs.set(id, []);
    this.addLog(null, `{green-fg}✓ New thread: ${newThread.name} — ${newThread.dataDir}{/}`);
    this.addLog(null, `{gray-fg}  Created: input.txt, hotmail.txt, success.txt, failed.txt{/}`);
    this.render();
  }

  deleteThread() {
    const thread = this.config.threads[this.selectedThread];
    if (!thread) return;
    if (this.runningProcesses.has(thread.id)) {
      this.addLog(null, `{red-fg}✗ Cannot delete running thread: ${thread.name}{/}`);
      return;
    }
    this.config.threads.splice(this.selectedThread, 1);
    saveConfig(this.config);
    this.addLog(null, `{yellow-fg}⚠ Deleted thread: ${thread.name}{/}`);
    if (this.selectedThread >= this.config.threads.length) {
      this.selectedThread = Math.max(0, this.config.threads.length - 1);
    }
    this.render();
  }

  startThread(threadOverride) {
    const thread = threadOverride || this.config.threads[this.selectedThread];
    if (!thread) return;

    if (this.runningProcesses.has(thread.id)) {
      this.addLog(thread.id, `{yellow-fg}⚠ Thread already running{/}`);
      return;
    }

    const running = this.runningProcesses.size;
    if (running >= this.config.maxThreads) {
      this.addLog(null, `{red-fg}✗ Max threads reached (${this.config.maxThreads}){/}`);
      return;
    }

    ensureDataDir(thread.dataDir);

    const inputFile = path.join(thread.dataDir, "input.txt");
    if (!fs.existsSync(inputFile) || fs.readFileSync(inputFile, "utf-8").trim() === "") {
      this.addLog(thread.id, `{red-fg}✗ No input.txt in ${thread.dataDir}{/}`);
      return;
    }

    this.addLog(thread.id, `{cyan-fg}▶ Starting ${thread.name}...{/}`);

    // Serialize thread config to pass to worker
    const workerConfigPath = path.join(thread.dataDir, "worker_config.json");
    fs.writeFileSync(
      workerConfigPath,
      JSON.stringify({ ...thread, chromePath: this.config.chromePath }, null, 2)
    );

    const child = fork(path.join(__dirname, "worker.js"), [workerConfigPath], {
      silent: true,
    });

    this.runningProcesses.set(thread.id, child);

    child.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter(Boolean);
      lines.forEach((line) => this.addLog(thread.id, line));
    });

    child.stderr.on("data", (data) => {
      const lines = data.toString().split("\n").filter(Boolean);
      lines.forEach((line) => this.addLog(thread.id, `{red-fg}${line}{/}`));
    });

    child.on("message", (msg) => {
      if (msg.type === "log") {
        this.addLog(thread.id, msg.text);
      } else if (msg.type === "progress") {
        if (!this.progress) this.progress = new Map();
        this.progress.set(thread.id, msg);
      }
    });

    child.on("exit", (code) => {
      this.runningProcesses.delete(thread.id);
      const color = code === 0 ? "green-fg" : "red-fg";
      this.addLog(thread.id, `{${color}}■ ${thread.name} exited (code: ${code}){/}`);
      this.render();
    });

    this.render();
  }

  stopThread(threadOverride) {
    const thread = threadOverride || this.config.threads[this.selectedThread];
    if (!thread) return;
    const child = this.runningProcesses.get(thread.id);
    if (!child) {
      this.addLog(thread.id, `{yellow-fg}⚠ Thread not running{/}`);
      return;
    }
    child.kill("SIGTERM");
    this.runningProcesses.delete(thread.id);
    this.addLog(thread.id, `{yellow-fg}■ Stopped ${thread.name}{/}`);
    this.render();
  }

  startAllThreads() {
    this.addLog(null, "{cyan-fg}▶▶ Starting all enabled threads...{/}");
    this.config.threads
      .filter((t) => t.enabled)
      .slice(0, this.config.maxThreads)
      .forEach((t) => this.startThread(t));
  }

  stopAllThreads() {
    this.addLog(null, "{yellow-fg}■■ Stopping all threads...{/}");
    this.config.threads.forEach((t) => this.stopThread(t));
  }

  shutdown() {
    this.stopAllThreads();
    setTimeout(() => {
      this.screen.destroy();
      process.exit(0);
    }, 500);
  }

  // ── CONFIG EDITING ──────────────────────────────────────────────────────────

  openThreadConfig() {
    const thread = this.config.threads[this.selectedThread];
    if (!thread) return;
    this.editingThread = { ...thread };
    this.showConfigModal(thread);
  }

  openGlobalConfig() {
    this.showGlobalModal();
  }

  showConfigModal(thread) {
    const modal = this.widgets.modal;
    modal.hidden = false;
    modal.focus();

    const fields = [
      { key: "name", label: "Thread Name", type: "text" },
      { key: "dataDir", label: "Data Directory", type: "text" },
      { key: "enabled", label: "Enabled (true/false)", type: "text" },
      { key: "headless", label: "Headless Browser (true/false)", type: "text" },
      { key: "useSystemVPN", label: "Use System VPN (true/false)", type: "text" },
      { key: "proxyEnabled", label: "Proxy Enabled (true/false)", type: "text" },
      { key: "proxyApiUrl", label: "Proxy API URL", type: "text" },
      { key: "proxyCountry", label: "Proxy Country (DE/US/...)", type: "text" },
      { key: "proxyCount", label: "Proxy Count", type: "number" },
      { key: "accountsPerProxy", label: "Accounts Per Proxy", type: "number" },
      { key: "gmxImapHost", label: "GMX IMAP Host", type: "text" },
      { key: "gmxImapPort", label: "GMX IMAP Port", type: "number" },
      { key: "gmxMaxRetries", label: "GMX Max Retries", type: "number" },
      { key: "gmxRetryDelay", label: "GMX Retry Delay (ms)", type: "number" },
      { key: "twoFaApiUrl", label: "2FA API URL", type: "text" },
      { key: "browserTimeout", label: "Browser Timeout (ms)", type: "number" },
      { key: "windowSize", label: "Window Size (WxH)", type: "text" },
      { key: "delayBetweenAccounts", label: "Delay Between Accounts (ms)", type: "number" },
      { key: "delayPageLoad", label: "Delay Page Load (ms)", type: "number" },
      { key: "retryMaxAttempts", label: "Retry Max Attempts", type: "number" },
      { key: "hotmailApiUrl", label: "Hotmail API URL", type: "text" },
      { key: "hotmailMaxRetries", label: "Hotmail Max Retries", type: "number" },
    ];

    this.renderModalFields(modal, thread, fields, "THREAD CONFIG", (updated) => {
      // Save callback
      const idx = this.config.threads.findIndex((t) => t.id === thread.id);
      if (idx >= 0) {
        this.config.threads[idx] = { ...thread, ...updated };
        saveConfig(this.config);
        ensureDataDir(this.config.threads[idx].dataDir);
        this.addLog(null, `{green-fg}✓ Saved config for: ${updated.name || thread.name}{/}`);
      }
      this.closeModal();
      this.render();
    });

    this.screen.render();
  }

  showGlobalModal() {
    const modal = this.widgets.modal;
    modal.hidden = false;
    modal.focus();

    const globalData = {
      chromePath: this.config.chromePath,
      maxThreads: this.config.maxThreads,
    };

    const fields = [
      { key: "chromePath", label: "Chrome/Edge Executable Path", type: "text" },
      { key: "maxThreads", label: "Max Concurrent Threads (1-20)", type: "number" },
    ];

    this.renderModalFields(modal, globalData, fields, "GLOBAL CONFIG", (updated) => {
      this.config.chromePath = updated.chromePath || this.config.chromePath;
      this.config.maxThreads = parseInt(updated.maxThreads) || this.config.maxThreads;
      if (this.config.maxThreads > 20) this.config.maxThreads = 20;
      if (this.config.maxThreads < 1) this.config.maxThreads = 1;
      saveConfig(this.config);
      this.addLog(null, `{green-fg}✓ Global config saved{/}`);
      this.closeModal();
      this.render();
    });

    this.screen.render();
  }

  renderModalFields(modal, data, fields, title, onSave) {
    // Clear modal
    modal.children.slice().forEach((child) => {
      if (child !== this.widgets.modalInput) modal.remove(child);
    });

    modal.setLabel(` {bold}{yellow-fg}${title}{/} `);

    // Instructions
    blessed.text({
      parent: modal,
      top: 0,
      left: 1,
      content:
        "{gray-fg}↑↓ Navigate  Enter=Edit  S=Save  Esc=Cancel{/}",
      tags: true,
    });

    // Field list
    const fieldList = blessed.list({
      parent: modal,
      top: 2,
      left: 1,
      width: "100%-4",
      height: modal.height - 8,
      keys: true,
      mouse: true,
      tags: true,
      scrollable: true,
      scrollbar: { style: { bg: "yellow" } },
      style: {
        selected: { bg: "yellow", fg: "black" },
        item: { fg: "white" },
      },
      items: fields.map((f) => {
        const val = data[f.key] !== undefined ? data[f.key] : "";
        return ` {cyan-fg}${f.label}{/}: {yellow-fg}${val}{/}`;
      }),
    });

    const tempData = { ...data };

    // Enter to edit
    fieldList.on("select", (item, index) => {
      const field = fields[index];
      const inputBox = this.widgets.modalInput;
      inputBox.hidden = false;
      inputBox.clearValue();
      inputBox.setValue(String(tempData[field.key] !== undefined ? tempData[field.key] : ""));
      inputBox.setLabel(` {cyan-fg}${field.label}{/} `);
      this.inputMode = true;

      inputBox.readInput((err, value) => {
        this.inputMode = false;
        if (!err && value !== null) {
          if (field.type === "number") {
            tempData[field.key] = Number(value);
          } else if (value === "true") {
            tempData[field.key] = true;
          } else if (value === "false") {
            tempData[field.key] = false;
          } else {
            tempData[field.key] = value;
          }
          // Update display
          const displayVal = tempData[field.key];
          fieldList.setItem(index, ` {cyan-fg}${field.label}{/}: {yellow-fg}${displayVal}{/}`);
        }
        inputBox.hidden = true;
        fieldList.focus();
        this.screen.render();
      });

      this.screen.render();
    });

    // S key to save
    fieldList.key(["s"], () => {
      onSave(tempData);
    });

    fieldList.key(["escape"], () => {
      this.closeModal();
    });

    fieldList.focus();
  }

  closeModal() {
    this.inputMode = false;
    this.widgets.modal.hidden = true;
    this.widgets.modalInput.hidden = true;
    this.widgets.threadList.focus();
    this.screen.render();
  }

  // ── RENDERING ──────────────────────────────────────────────────────────────

  addLog(threadId, text) {
    const ts = new Date().toLocaleTimeString("vi-VN");
    const line = `{gray-fg}[${ts}]{/} ${text}`;

    if (threadId !== null) {
      if (!this.logs.has(threadId)) this.logs.set(threadId, []);
      const arr = this.logs.get(threadId);
      arr.push(line);
      if (arr.length > 500) arr.shift();
    }

    this.globalLogs.push(line);
    if (this.globalLogs.length > 1000) this.globalLogs.shift();

    this.updateLogView();
  }

  updateLogView() {
    const thread = this.config.threads[this.selectedThread];
    const logBox = this.widgets.logBox;

    let logs;
    if (thread && this.logs.has(thread.id)) {
      logBox.setLabel(` {bold}LOGS — ${thread.name}{/} `);
      logs = this.logs.get(thread.id);
    } else {
      logBox.setLabel(" {bold}LOGS — Global{/} ");
      logs = this.globalLogs;
    }

    logBox.setContent(logs.slice(-200).join("\n"));
    logBox.setScrollPerc(100);
    this.screen.render();
  }

  updateConfigPreview() {
    const thread = this.config.threads[this.selectedThread];
    const box = this.widgets.configPreview;

    if (!thread) {
      box.setContent(" No thread selected");
      return;
    }

    const running = this.runningProcesses.has(thread.id);
    const statusColor = running ? "green-fg" : "red-fg";
    const statusText = running ? "▶ RUNNING" : "■ STOPPED";

    const lines = [
      `{bold}${thread.name}{/}`,
      `{${statusColor}}${statusText}{/}`,
      ``,
      `{cyan-fg}Dir:{/} ${thread.dataDir}`,
      `{cyan-fg}VPN:{/} ${thread.useSystemVPN ? "System VPN" : "Proxy"}`,
      thread.proxyEnabled ? `{cyan-fg}Proxy:{/} ${thread.proxyCountry} x${thread.proxyCount}` : "",
      `{cyan-fg}GMX:{/} ${thread.gmxImapHost}:${thread.gmxImapPort}`,
      `{cyan-fg}2FA API:{/} ${thread.twoFaApiUrl}`,
      `{cyan-fg}Headless:{/} ${thread.headless}`,
      `{cyan-fg}Timeout:{/} ${thread.browserTimeout}ms`,
      `{cyan-fg}Retries:{/} ${thread.retryMaxAttempts}`,
      `{cyan-fg}Delay:{/} ${thread.delayBetweenAccounts}ms`,
    ].filter(Boolean);

    box.setContent(lines.join("\n"));
  }

  refreshStats() {
    // Thread list
    const items = this.config.threads.map((t, i) => {
      const running = this.runningProcesses.has(t.id);
      const stats = getThreadStats(t.dataDir);
      const statusIcon = running ? "{green-fg}▶{/}" : t.enabled ? "{gray-fg}■{/}" : "{red-fg}✗{/}";
      const selected = i === this.selectedThread ? "{bold}" : "";
      return (
        ` ${statusIcon} ${selected}${t.name}{/}  ` +
        `{gray-fg}${stats.input}acc{/}`
      );
    });
    this.widgets.threadList.setItems(items);
    this.widgets.threadList.select(this.selectedThread);

    // Stats box
    const totalInput = this.config.threads.reduce((sum, t) => {
      return sum + getThreadStats(t.dataDir).input;
    }, 0);
    const totalSuccess = this.config.threads.reduce((sum, t) => {
      return sum + getThreadStats(t.dataDir).success;
    }, 0);
    const totalFailed = this.config.threads.reduce((sum, t) => {
      return sum + getThreadStats(t.dataDir).failed;
    }, 0);
    const running = this.runningProcesses.size;

    const statsLines = [
      `{bold}TỔNG QUAN{/}`,
      ``,
      `{cyan-fg}Threads:{/}  ${this.config.threads.length} configured`,
      `{green-fg}Running:{/}  ${running} / ${this.config.maxThreads} max`,
      ``,
      `{white-fg}Accounts:{/} ${totalInput} total input`,
      `{green-fg}Success:{/}  ${totalSuccess}`,
      `{red-fg}Failed:{/}   ${totalFailed}`,
      `{yellow-fg}Pending:{/}  ${Math.max(0, totalInput - totalSuccess - totalFailed)}`,
      ``,
      `{cyan-fg}Chrome:{/}`,
      `{gray-fg}${(this.config.chromePath || "NOT SET").substring(0, 30)}...{/}`,
      ``,
      `{gray-fg}[A] Start All  [Z] Stop All{/}`,
    ];
    this.widgets.statsBox.setContent(statsLines.join("\n"));

    // Status bar
    const cpu = os.loadavg()[0].toFixed(1);
    const memUsed = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const time = new Date().toLocaleTimeString("vi-VN");
    this.widgets.statusBar.setContent(
      ` {bold}IG 2FA Manager{/}  ` +
      `{cyan-fg}Time:{/} ${time}  ` +
      `{cyan-fg}CPU:{/} ${cpu}%  ` +
      `{cyan-fg}RAM:{/} ${memUsed}MB  ` +
      `{cyan-fg}Threads Running:{/} ${running}/${this.config.maxThreads}  ` +
      `{green-fg}✓ ${totalSuccess}{/}  {red-fg}✗ ${totalFailed}{/}`
    );

    // Progress bars text (simple ASCII)
    const progLines = this.config.threads.slice(0, 3).map((t) => {
      const stats = getThreadStats(t.dataDir);
      const total = stats.input || 1;
      const pct = Math.round((stats.success / total) * 100);
      const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
      const running = this.runningProcesses.has(t.id);
      const color = running ? "green-fg" : "gray-fg";
      return ` {${color}}${t.name.padEnd(10)}{/} [${bar}] ${pct}% (${stats.success}/${total})`;
    });
    this.widgets.progressBar.setContent(progLines.join("\n"));

    this.updateConfigPreview();
    this.screen.render();
  }

  render() {
    this.refreshStats();
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

console.clear();

// Ensure global data dir exists
const DATA_ROOT = path.join(__dirname, "data");
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

// Tao du files cho tat ca threads da config
const _startupConfig = loadConfig();
_startupConfig.threads.forEach(t => ensureDataDir(t.dataDir));

const app = new IGManagerUI();
