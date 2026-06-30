import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const obsidianExe = process.env.LIFEOS_OBSIDIAN_EXE ?? "D:\\Obsidian\\Obsidian.exe";
const tempRoot = join(repoRoot, "tmp", "ai-edit-runtime-smoke");
const vaultDir = join(tempRoot, "vault");
const profileDir = join(tempRoot, "profile");
const pluginDir = join(vaultDir, ".obsidian", "plugins", "personal-life-system");
const reportPath = join(tempRoot, "result.json");
const debugPort = Number(process.env.LIFEOS_AI_EDIT_DEBUG_PORT ?? 32600 + Math.floor(Math.random() * 1000));
const pluginId = "personal-life-system";
const panelViewType = "personal-life-system-ai-edit-panel";
const commandId = `${pluginId}:lifeos-ai-edit-selection`;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function assertInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`Refusing to operate outside expected directory: ${child}`);
  }
}

async function waitFor(label, probe, timeoutMs = 70000, intervalMs = 400) {
  const started = Date.now();
  let last = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.stack ?? JSON.stringify(last)}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.rejectAll(new Error("CDP websocket closed")));
    socket.addEventListener("error", () => this.rejectAll(new Error("CDP websocket error")));
  }

  static connect(url) {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => rejectConnect(new Error("CDP connect timeout")), 15000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveConnect(new CdpClient(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectConnect(new Error("CDP websocket connection failed"));
      }, { once: true });
    });
  }

  handleMessage(event) {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    const message = JSON.parse(raw);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectSend(error);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression, description) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const exception = details.exception?.description ?? details.exception?.value ?? "";
    throw new Error(`${description} failed: ${details.text}${exception ? `\n${exception}` : ""}`);
  }
  return result.result?.value;
}

function prepareVault() {
  if (!existsSync(obsidianExe)) throw new Error(`Obsidian executable missing: ${obsidianExe}`);
  assertInside(repoRoot, tempRoot);
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
    copyFileSync(join(repoRoot, artifact), join(pluginDir, artifact));
  }
  if (existsSync(join(repoRoot, "assets"))) {
    cpSync(join(repoRoot, "assets"), join(pluginDir, "assets"), { recursive: true });
  }
  writeFileSync(join(pluginDir, "data.json"), JSON.stringify({ hasCompletedFirstRun: true }, null, 2), "utf8");
  writeFileSync(join(vaultDir, ".obsidian", "community-plugins.json"), JSON.stringify([pluginId], null, 2), "utf8");
  writeFileSync(
    join(vaultDir, "ai-edit-runtime-sample.md"),
    "Life OS AI 编辑浮窗自动选区测试文本。\n\n第二段用于确认编辑器和文档保持正常。\n",
    "utf8"
  );
  const vaultId = "lifeos-ai-edit-runtime";
  writeFileSync(
    join(profileDir, "obsidian.json"),
    JSON.stringify({ vaults: { [vaultId]: { path: vaultDir, ts: Date.now(), open: true } } }),
    "utf8"
  );
  writeFileSync(join(profileDir, `${vaultId}.json`), "{}", "utf8");
}

async function connectPage() {
  return waitFor("Obsidian DevTools page", async () => {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    for (const target of targets.filter((item) => item.type === "page" && item.webSocketDebuggerUrl)) {
      try {
        const client = await CdpClient.connect(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        const probe = await evaluate(client, "({appReady: !!window.app, body: !!document.body})", "page probe");
        if (probe?.body) return client;
        client.close();
      } catch {
        // Continue scanning Electron targets.
      }
    }
    return null;
  });
}

function stopProfileProcesses() {
  const escaped = profileDir.replaceAll("'", "''");
  const command = `$profile='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Obsidian*' -and $_.CommandLine -and $_.CommandLine.Contains($profile) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore" });
  } catch {
    // The isolated process may already have exited.
  }
}

const trustExpression = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const buttons = Array.from(document.querySelectorAll("button"));
  const trust = buttons.find((button) => {
    const text = button.innerText || button.textContent || "";
    return (/信任/.test(text) && /插件/.test(text)) || (/trust/i.test(text) && /plugin/i.test(text));
  });
  if (trust) {
    trust.click();
    await wait(2500);
  }
  document.querySelectorAll(".modal-close-button").forEach((button) => button.click());
  return { clicked: !!trust, plugin: !!window.app?.plugins?.plugins?.[${JSON.stringify(pluginId)}] };
})()`;

const pluginReadyExpression = `(() => ({
  plugin: !!window.app?.plugins?.plugins?.[${JSON.stringify(pluginId)}],
  command: !!window.app?.commands?.commands?.[${JSON.stringify(commandId)}]
}))()`;

const runtimeSmokeExpression = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.__lifeosAiEditRuntimeErrors = [];
  if (!window.__lifeosAiEditErrorCapture) {
    window.addEventListener("error", (event) => window.__lifeosAiEditRuntimeErrors.push({ type: "error", message: event.message, stack: event.error?.stack || "" }));
    window.addEventListener("unhandledrejection", (event) => window.__lifeosAiEditRuntimeErrors.push({ type: "rejection", message: String(event.reason?.message || event.reason || ""), stack: event.reason?.stack || "" }));
    window.__lifeosAiEditErrorCapture = true;
  }
  const app = window.app;
  const plugin = app?.plugins?.plugins?.[${JSON.stringify(pluginId)}];
  const command = app?.commands?.commands?.[${JSON.stringify(commandId)}];
  if (!app || !plugin || !command) {
    return { ok: false, reason: "plugin or selection command missing", pluginPresent: !!plugin, commandPresent: !!command };
  }
  document.querySelectorAll(".modal-close-button").forEach((button) => button.click());
  plugin.aiEditPopover?.close?.();
  app.workspace.detachLeavesOfType(${JSON.stringify(panelViewType)});

  const file = app.vault.getAbstractFileByPath("ai-edit-runtime-sample.md");
  if (!file) return { ok: false, reason: "sample file missing" };
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  await wait(700);
  const view = app.workspace.activeLeaf?.view;
  const editor = view?.editor;
  if (!editor?.setSelection) return { ok: false, reason: "active editor unavailable", viewType: view?.getViewType?.() || "" };

  editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 18 });
  await wait(120);
  document.dispatchEvent(new Event("selectionchange"));
  await wait(650);

  const floating = document.querySelector(".lifeos-ai-edit-popover:not(.is-panel)");
  const tabs = Array.from(floating?.querySelectorAll(".lifeos-ai-edit-tab") || []).map((item) => item.textContent?.trim() || "");
  const selectedText = editor.getSelection();
  const dock = floating?.querySelector(".lifeos-ai-edit-popover-dock");
  const position = floating ? getComputedStyle(floating) : null;
  const rect = floating?.getBoundingClientRect();

  dock?.click();
  await wait(700);
  const panelLeaves = app.workspace.getLeavesOfType(${JSON.stringify(panelViewType)}).length;
  const panel = document.querySelector(".lifeos-ai-edit-popover.is-panel");
  const panelTabs = Array.from(panel?.querySelectorAll(".lifeos-ai-edit-tab") || []).map((item) => item.textContent?.trim() || "");
  const errors = (window.__lifeosAiEditRuntimeErrors || []).slice(-10);
  const result = {
    ok: !!floating
      && selectedText.length > 0
      && tabs.includes("问答")
      && tabs.includes("编辑")
      && !!dock
      && position?.visibility !== "hidden"
      && Number(rect?.width || 0) > 100
      && Number(rect?.height || 0) > 100
      && panelLeaves === 1
      && !!panel
      && panelTabs.includes("问答")
      && panelTabs.includes("编辑")
      && errors.length === 0,
    version: plugin.manifest?.version || "",
    commandPresent: !!command,
    selectedText,
    floatingPresent: !!floating,
    floatingTabs: tabs,
    floatingRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
    dockPresent: !!dock,
    panelLeaves,
    panelPresent: !!panel,
    panelTabs,
    errors
  };
  app.workspace.detachLeavesOfType(${JSON.stringify(panelViewType)});
  plugin.aiEditPopover?.close?.();
  return result;
})()`;

async function main() {
  stopProfileProcesses();
  prepareVault();
  let child = null;
  let client = null;
  try {
    child = spawn(obsidianExe, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--disable-gpu",
      vaultDir
    ], { stdio: "ignore", windowsHide: true });
    client = await connectPage();
    await waitFor("Obsidian app", async () => {
      const state = await evaluate(client, "({ready: !!window.app})", "wait for app");
      return state?.ready;
    });
    await waitFor("Life OS plugin and AI edit command", async () => {
      await evaluate(client, trustExpression, "trust plugin prompt");
      const state = await evaluate(client, pluginReadyExpression, "plugin readiness");
      return state.plugin && state.command ? state : null;
    }, 90000, 700);
    const result = await evaluate(client, runtimeSmokeExpression, "AI edit automatic selection smoke");
    const report = {
      pass: Boolean(result?.ok),
      generatedAt: new Date().toISOString(),
      sourceVersion: JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf8")).version,
      debugPort,
      isolatedVault: vaultDir,
      result
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    if (!report.pass) throw new Error(`AI edit runtime smoke failed:\n${JSON.stringify(report, null, 2)}`);
    console.log("Life OS AI edit automatic-selection runtime smoke passed.");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try { client?.close(); } catch {}
    try { child?.kill(); } catch {}
    stopProfileProcesses();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
