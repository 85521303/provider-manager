const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const sea = require("node:sea");

const execFileAsync = promisify(execFile);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT || 3767);
const APP_VERSION = 1;
const MAX_FIRST_LINE_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGE_CHARS = 40000;
const MAX_CLAUDE_MESSAGE_CHARS = 40000;
const MAX_CLAUDE_TITLE_CHARS = 120;
let embeddedSqlitePath = null;
let lastHeartbeatAt = 0;
let sawHeartbeat = false;
let authWatcherTimer = null;
let authWatcherLastMtimeMs = 0;
let authWatcherLastSize = 0;

function isSeaExecutable() {
  return typeof sea.isSea === "function" && sea.isSea();
}

function writeEmbeddedAsset(assetName, destination) {
  const raw = sea.getRawAsset(assetName);
  const buffer = Buffer.from(raw);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination) || fs.statSync(destination).size !== buffer.length) {
    fs.writeFileSync(destination, buffer);
  }
}

function embeddedSqliteExecutable() {
  if (!isSeaExecutable()) return null;
  if (embeddedSqlitePath) return embeddedSqlitePath;

  try {
    const runtimeDir = path.join(os.tmpdir(), "provider-manager-runtime");
    const sqliteName = process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
    const sqliteExe = path.join(runtimeDir, sqliteName);
    writeEmbeddedAsset(`vendor/${sqliteName}`, sqliteExe);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(sqliteExe, 0o755);
      } catch {
        // The extracted binary may already have executable permissions.
      }
    } else {
      try {
        writeEmbeddedAsset("vendor/sqlite3.dll", path.join(runtimeDir, "sqlite3.dll"));
      } catch {
        // Some sqlite3.exe builds are fully static and do not need a DLL.
      }
    }
    embeddedSqlitePath = sqliteExe;
    return embeddedSqlitePath;
  } catch {
    return null;
  }
}

function sqliteExecutable() {
  return process.env.SQLITE3_PATH || embeddedSqliteExecutable() || "sqlite3";
}

function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function stateDbPath() {
  return path.join(getCodexHome(), "state_5.sqlite");
}

function managerStatePath() {
  return path.join(getCodexHome(), "provider-manager-state.json");
}

function globalStatePath() {
  return path.join(getCodexHome(), ".codex-global-state.json");
}

function configPath() {
  return path.join(getCodexHome(), "config.toml");
}

function authPath() {
  return path.join(getCodexHome(), "auth.json");
}

function sessionIndexPath() {
  return path.join(getCodexHome(), "session_index.jsonl");
}

function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runSql(sql, options = {}) {
  const args = [];
  if (options.json) args.push("-json");
  args.push(options.dbPath || stateDbPath(), sql);
  const result = await execFileAsync(sqliteExecutable(), args, {
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (!options.json) return result.stdout;
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function ensureSqliteAvailable() {
  await execFileAsync(sqliteExecutable(), ["-version"], { windowsHide: true });
}

function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;

    while (total < MAX_FIRST_LINE_BYTES) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, end)));
        break;
      }

      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }

    return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionMeta(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const firstLine = readFirstLine(filePath);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    if (parsed.type !== "session_meta") return null;
    return parsed;
  } catch {
    return null;
  }
}

function contentPartToText(part) {
  if (part === null || part === undefined) return "";
  if (typeof part === "string") return part;
  if (typeof part !== "object") return String(part);
  if (typeof part.text === "string") return part.text;
  if (typeof part.input_text === "string") return part.input_text;
  if (typeof part.output_text === "string") return part.output_text;
  if (typeof part.image_url === "string") return `[image] ${part.image_url}`;
  if (part.type && Object.keys(part).length === 1) return `[${part.type}]`;
  return JSON.stringify(part);
}

function messageContentToText(content) {
  if (Array.isArray(content)) {
    return content.map(contentPartToText).filter(Boolean).join("\n\n").trim();
  }
  return contentPartToText(content).trim();
}

function trimMessageText(text) {
  if (!text || text.length <= MAX_CONVERSATION_MESSAGE_CHARS) return text || "";
  return `${text.slice(0, MAX_CONVERSATION_MESSAGE_CHARS)}\n\n[内容过长，已在预览中截断]`;
}

function trimClaudeMessageText(text) {
  if (!text || text.length <= MAX_CLAUDE_MESSAGE_CHARS) return text || "";
  return `${text.slice(0, MAX_CLAUDE_MESSAGE_CHARS)}\n\n[内容过长，已在预览中截断]`;
}

function extractChatMessage(entry, lineNumber) {
  const payload = entry && entry.payload ? entry.payload : {};
  if (entry.type !== "response_item" || payload.type !== "message") return null;
  if (payload.role !== "user" && payload.role !== "assistant") return null;

  const text = trimMessageText(messageContentToText(payload.content));
  if (!text) return null;

  return {
    lineNumber,
    timestamp: entry.timestamp || "",
    role: payload.role,
    text,
  };
}

async function readConversation(threadId) {
  const rows = await getThreadRowsByIds([threadId]);
  if (!rows.length) throw new Error("Conversation was not found.");
  const row = rows[0];
  if (!row.rollout_path || !fs.existsSync(row.rollout_path)) {
    throw new Error("Rollout file is missing for this conversation.");
  }

  const messages = [];
  const lines = fs.readFileSync(row.rollout_path, "utf8").split(/\r?\n/);
  let meta = null;
  let parseErrors = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta") meta = entry.payload || null;
      const message = extractChatMessage(entry, index + 1);
      if (message) messages.push(message);
    } catch {
      parseErrors += 1;
    }
  }

  return {
    id: row.id,
    title: row.title || row.first_user_message || "(untitled)",
    provider: row.model_provider || "",
    model: row.model || "",
    reasoningEffort: row.reasoning_effort || "",
    cwd: row.cwd || "",
    createdAtMs: Number(row.created_at_ms || row.created_at * 1000 || 0),
    updatedAtMs: Number(row.updated_at_ms || row.updated_at * 1000 || 0),
    rolloutPath: row.rollout_path,
    meta,
    messages,
    parseErrors,
  };
}

function updateSessionMeta(filePath, updater) {
  const content = fs.readFileSync(filePath, "utf8");
  const newlineIndex = content.indexOf("\n");
  const firstLine = (newlineIndex >= 0 ? content.slice(0, newlineIndex).replace(/\r$/, "") : content).replace(/^\uFEFF/, "");
  const rest = newlineIndex >= 0 ? content.slice(newlineIndex + 1) : "";
  const parsed = JSON.parse(firstLine);

  if (parsed.type !== "session_meta" || !parsed.payload) {
    throw new Error(`Rollout file has no session_meta first line: ${filePath}`);
  }

  updater(parsed);
  const next = JSON.stringify(parsed);
  fs.writeFileSync(filePath, newlineIndex >= 0 ? `${next}\n${rest}` : next, "utf8");
}

function readManagerState() {
  const file = managerStatePath();
  if (!fs.existsSync(file)) {
    return { version: APP_VERSION, threads: {}, authByProvider: {}, currentAuthProvider: "" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: parsed.version || APP_VERSION,
      threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
      authByProvider: parsed.authByProvider && typeof parsed.authByProvider === "object" ? parsed.authByProvider : {},
      currentAuthProvider: typeof parsed.currentAuthProvider === "string" ? parsed.currentAuthProvider : "",
    };
  } catch {
    return { version: APP_VERSION, threads: {}, authByProvider: {}, currentAuthProvider: "" };
  }
}

function writeManagerState(state) {
  const file = managerStatePath();
  fs.writeFileSync(file, `${JSON.stringify({
    version: APP_VERSION,
    threads: state.threads || {},
    authByProvider: state.authByProvider || {},
    currentAuthProvider: state.currentAuthProvider || "",
  }, null, 2)}\n`, "utf8");
}

function isOpenAiAuthProvider(providerName) {
  const name = String(providerName || "").trim().toLowerCase();
  return name === "openai";
}

function readAuthJson(options = {}) {
  const file = authPath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (options.logError) {
      console.warn(`Could not parse auth.json: ${error.message || error}`);
    }
    return null;
  }
}

function authFileStats() {
  const file = authPath();
  if (!fs.existsSync(file)) return null;
  const stats = fs.statSync(file);
  return {
    mtimeMs: Number(stats.mtimeMs || 0),
    size: Number(stats.size || 0),
  };
}

function setAuthWatcherBaselineFromFile() {
  const stats = authFileStats();
  if (!stats) {
    authWatcherLastMtimeMs = 0;
    authWatcherLastSize = 0;
    return;
  }
  authWatcherLastMtimeMs = stats.mtimeMs;
  authWatcherLastSize = stats.size;
}

function saveCurrentAuthForProvider(managerState, providerName) {
  if (!isOpenAiAuthProvider(providerName)) return { changed: false, action: "not-openai" };
  const auth = readAuthJson();
  if (!auth) return { changed: false, action: "invalid-or-missing-auth" };
  const stats = authFileStats();
  const previous = managerState.authByProvider && managerState.authByProvider[providerName];
  const next = {
    auth,
    updatedAt: new Date().toISOString(),
    sourceMtimeMs: stats ? stats.mtimeMs : 0,
  };
  if (!managerState.authByProvider) managerState.authByProvider = {};
  managerState.authByProvider[providerName] = next;
  return {
    changed: JSON.stringify(previous ? previous.auth : null) !== JSON.stringify(auth),
    action: "saved-current-auth",
  };
}

function restoreAuthForProvider(managerState, providerName) {
  if (!isOpenAiAuthProvider(providerName)) {
    managerState.currentAuthProvider = "";
    return { changed: false, action: "not-openai" };
  }

  managerState.currentAuthProvider = providerName;
  const entry = managerState.authByProvider && managerState.authByProvider[providerName];
  const file = authPath();
  if (entry && entry.auth && typeof entry.auth === "object") {
    const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const next = `${JSON.stringify(entry.auth, null, 2)}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, "utf8");
    setAuthWatcherBaselineFromFile();
    return {
      changed: original !== next,
      action: "restored-auth",
    };
  }

  const existed = fs.existsSync(file);
  if (existed) fs.unlinkSync(file);
  setAuthWatcherBaselineFromFile();
  return {
    changed: existed,
    action: "cleared-auth-awaiting-login",
  };
}

function syncAuthForProviderSwitch(fromProvider, toProvider) {
  const managerState = readManagerState();
  const saved = saveCurrentAuthForProvider(managerState, fromProvider);
  const restored = restoreAuthForProvider(managerState, toProvider);
  writeManagerState(managerState);
  return {
    authChanged: Boolean(saved.changed || restored.changed),
    authAction: restored.action,
    authSaved: saved.action === "saved-current-auth",
  };
}

function cleanupAuthForProvider(providerName) {
  if (!isOpenAiAuthProvider(providerName)) return { changed: false, action: "not-openai" };
  const managerState = readManagerState();
  let changed = false;
  if (managerState.authByProvider && Object.prototype.hasOwnProperty.call(managerState.authByProvider, providerName)) {
    delete managerState.authByProvider[providerName];
    changed = true;
  }
  if (managerState.currentAuthProvider === providerName) {
    managerState.currentAuthProvider = "";
    changed = true;
  }
  if (changed) writeManagerState(managerState);
  return { changed, action: changed ? "deleted-auth" : "no-auth" };
}

function renameAuthForProvider(oldProvider, nextProvider) {
  if (!oldProvider || oldProvider === nextProvider) return { changed: false, action: "unchanged" };

  const oldIsOpenAi = isOpenAiAuthProvider(oldProvider);
  const nextIsOpenAi = isOpenAiAuthProvider(nextProvider);
  if (!oldIsOpenAi && !nextIsOpenAi) return { changed: false, action: "unchanged" };

  const managerState = readManagerState();
  if (!managerState.authByProvider) managerState.authByProvider = {};
  let changed = false;
  let action = "unchanged";

  if (oldIsOpenAi && nextIsOpenAi && Object.prototype.hasOwnProperty.call(managerState.authByProvider, oldProvider)) {
    managerState.authByProvider[nextProvider] = managerState.authByProvider[oldProvider];
    delete managerState.authByProvider[oldProvider];
    changed = true;
    action = "renamed-auth";
  } else if (oldIsOpenAi && !nextIsOpenAi && Object.prototype.hasOwnProperty.call(managerState.authByProvider, oldProvider)) {
    delete managerState.authByProvider[oldProvider];
    changed = true;
    action = "deleted-auth";
  }

  if (managerState.currentAuthProvider === oldProvider) {
    managerState.currentAuthProvider = nextIsOpenAi ? nextProvider : "";
    changed = true;
    action = action === "unchanged" ? "renamed-current-auth-provider" : action;
  }

  if (changed) writeManagerState(managerState);
  return { changed, action };
}

function persistObservedAuthIfNeeded() {
  const managerState = readManagerState();
  const providerName = managerState.currentAuthProvider || "";
  if (!isOpenAiAuthProvider(providerName)) return false;
  const stats = authFileStats();
  if (!stats) return false;
  if (stats.mtimeMs === authWatcherLastMtimeMs && stats.size === authWatcherLastSize) return false;

  const auth = readAuthJson({ logError: true });
  if (!auth) {
    authWatcherLastMtimeMs = stats.mtimeMs;
    authWatcherLastSize = stats.size;
    return false;
  }
  if (!managerState.authByProvider) managerState.authByProvider = {};
  const previous = managerState.authByProvider[providerName];
  const next = {
    auth,
    updatedAt: new Date().toISOString(),
    sourceMtimeMs: stats.mtimeMs,
  };
  const changed = JSON.stringify(previous ? previous.auth : null) !== JSON.stringify(auth);
  managerState.authByProvider[providerName] = next;
  writeManagerState(managerState);
  authWatcherLastMtimeMs = stats.mtimeMs;
  authWatcherLastSize = stats.size;
  return changed;
}

function readGlobalState() {
  const file = globalStatePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeGlobalState(state) {
  if (!state) return;
  fs.writeFileSync(globalStatePath(), `${JSON.stringify(state)}\n`, "utf8");
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function persistedAtomState(globalState) {
  if (!globalState || typeof globalState !== "object") return null;
  const atom = globalState["electron-persisted-atom-state"];
  return atom && typeof atom === "object" ? atom : null;
}

function addUnique(array, value) {
  if (!Array.isArray(array)) return false;
  if (array.includes(value)) return false;
  array.push(value);
  return true;
}

function removeFromArray(array, values) {
  if (!Array.isArray(array)) return false;
  const removeSet = new Set(values);
  const next = array.filter((value) => !removeSet.has(value));
  if (next.length === array.length) return false;
  array.splice(0, array.length, ...next);
  return true;
}

function copyObjectEntry(container, sourceId, targetId) {
  if (!container || typeof container !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(container, sourceId)) return false;
  if (Object.prototype.hasOwnProperty.call(container, targetId)) return false;
  container[targetId] = cloneJson(container[sourceId]);
  return true;
}

function replaceObjectEntry(container, sourceId, targetId) {
  if (!container || typeof container !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(container, sourceId)) return false;
  const next = cloneJson(container[sourceId]);
  const previous = container[targetId];
  container[targetId] = next;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function deleteObjectEntries(container, ids) {
  if (!container || typeof container !== "object") return false;
  let changed = false;
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(container, id)) {
      delete container[id];
      changed = true;
    }
  }
  return changed;
}

function cloneThreadGlobalState(globalState, sourceId, targetId) {
  const atom = persistedAtomState(globalState);
  if (!globalState || !sourceId || !targetId) return false;
  let changed = false;
  const containers = atom ? [globalState, atom] : [globalState];

  for (const container of containers) {
    changed = copyObjectEntry(container["prompt-history"], sourceId, targetId) || changed;
    changed = copyObjectEntry(container["heartbeat-thread-permissions-by-id"], sourceId, targetId) || changed;
    changed = copyObjectEntry(container["thread-workspace-root-hints"], sourceId, targetId) || changed;

    if (Array.isArray(container["projectless-thread-ids"]) && container["projectless-thread-ids"].includes(sourceId)) {
      changed = addUnique(container["projectless-thread-ids"], targetId) || changed;
    }
    if (Array.isArray(container["pinned-thread-ids"]) && container["pinned-thread-ids"].includes(sourceId)) {
      changed = addUnique(container["pinned-thread-ids"], targetId) || changed;
    }
  }

  return changed;
}

function replaceThreadGlobalState(globalState, sourceId, targetId) {
  const atom = persistedAtomState(globalState);
  if (!globalState || !sourceId || !targetId) return false;
  let changed = false;
  const containers = atom ? [globalState, atom] : [globalState];

  for (const container of containers) {
    changed = replaceObjectEntry(container["prompt-history"], sourceId, targetId) || changed;
    changed = replaceObjectEntry(container["heartbeat-thread-permissions-by-id"], sourceId, targetId) || changed;
    changed = replaceObjectEntry(container["thread-workspace-root-hints"], sourceId, targetId) || changed;

    if (Array.isArray(container["projectless-thread-ids"]) && container["projectless-thread-ids"].includes(sourceId)) {
      changed = addUnique(container["projectless-thread-ids"], targetId) || changed;
    }
    if (Array.isArray(container["pinned-thread-ids"]) && container["pinned-thread-ids"].includes(sourceId)) {
      changed = addUnique(container["pinned-thread-ids"], targetId) || changed;
    }
  }

  return changed;
}

function removeThreadGlobalState(globalState, ids) {
  const atom = persistedAtomState(globalState);
  if (!globalState) return false;
  const cleanIds = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  let changed = false;
  const containers = atom ? [globalState, atom] : [globalState];

  for (const container of containers) {
    changed = deleteObjectEntries(container["prompt-history"], cleanIds) || changed;
    changed = deleteObjectEntries(container["heartbeat-thread-permissions-by-id"], cleanIds) || changed;
    changed = deleteObjectEntries(container["thread-workspace-root-hints"], cleanIds) || changed;
    changed = deleteObjectEntries(container["queued-follow-ups"], cleanIds) || changed;
    changed = removeFromArray(container["projectless-thread-ids"], cleanIds) || changed;
    changed = removeFromArray(container["pinned-thread-ids"], cleanIds) || changed;
  }

  return changed;
}

function parseTomlString(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function parseProviderSectionName(sectionName) {
  if (sectionName === "model_providers") return null;
  if (!sectionName.startsWith("model_providers.")) return null;
  let rest = sectionName.slice("model_providers.".length);

  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0];
    let escaped = false;
    for (let index = 1; index < rest.length; index += 1) {
      const char = rest[index];
      if (quote === '"' && char === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) return parseTomlString(rest.slice(0, index + 1));
      escaped = false;
    }
    return null;
  }

  const dotIndex = rest.indexOf(".");
  if (dotIndex >= 0) rest = rest.slice(0, dotIndex);
  return rest;
}

function readConfig() {
  const file = configPath();
  const providers = new Map();
  let activeProvider = null;
  if (!fs.existsSync(file)) return { activeProvider, providers };

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let currentProvider = null;
  let inRoot = true;

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inRoot = false;
      currentProvider = parseProviderSectionName(section[1]);
      if (currentProvider && !providers.has(currentProvider)) {
        providers.set(currentProvider, { name: currentProvider, configured: true });
      }
      continue;
    }

    const keyValue = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!keyValue) continue;

    const [, key, rawValue] = keyValue;
    const value = parseTomlString(rawValue);
    if (inRoot && key === "model_provider") activeProvider = value;
    if (currentProvider) {
      const provider = providers.get(currentProvider) || { name: currentProvider, configured: true };
      if (key === "name") provider.displayName = value;
      if (key === "base_url") provider.baseUrl = value;
      if (key === "env_key") provider.envKey = value;
      providers.set(currentProvider, provider);
    }
  }

  return { activeProvider, providers };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function providerSectionHeader(providerName) {
  if (/^[A-Za-z0-9_-]+$/.test(providerName)) return `[model_providers.${providerName}]`;
  return `[model_providers.${tomlString(providerName)}]`;
}

function providerConfigMatches(current, next) {
  if (!current) return false;
  return (current.displayName || "") === next.displayName
    && (current.baseUrl || "") === next.baseUrl
    && (current.envKey || "") === next.envKey;
}

function normalizeProviderConfig(raw) {
  const providerName = String(raw.provider || raw.nameKey || "").trim();
  const displayName = String(raw.displayName || raw.name || providerName).trim();
  const baseUrl = String(raw.baseUrl || raw.base_url || "").trim();
  const envKey = String(raw.envKey || raw.env_key || "").trim();
  const oldProvider = String(raw.oldProvider || raw.old_provider || providerName).trim();

  if (!providerName) throw new Error("Provider name is required.");
  if (!displayName) throw new Error("Provider display name is required.");
  if (isOpenAiAuthProvider(providerName)) {
    throw new Error('The built-in "openai" provider cannot be configured. Only one provider named "openai" is allowed.');
  }
  if (!baseUrl) throw new Error("Provider base_url is required.");
  if (!envKey) throw new Error("Provider env_key is required.");

  return {
    oldProvider,
    name: providerName,
    displayName,
    baseUrl,
    envKey,
  };
}

function providerConfigSectionLines(provider) {
  const lines = [
    providerSectionHeader(provider.name),
    `name = ${tomlString(provider.displayName)}`,
  ];
  if (provider.baseUrl) lines.push(`base_url = ${tomlString(provider.baseUrl)}`);
  if (provider.envKey) lines.push(`env_key = ${tomlString(provider.envKey)}`);
  return lines;
}

function updateActiveProviderOnly(providerName) {
  const file = configPath();
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const newline = original.includes("\r\n") ? "\r\n" : os.EOL;
  const lines = original ? original.split(/\r?\n/) : [];
  const output = [];
  let inRoot = true;
  let activeUpdated = false;

  const insertActive = () => {
    if (activeUpdated) return;
    if (output.length && output[output.length - 1].trim() !== "") output.push("");
    output.push(`model_provider = ${tomlString(providerName)}`);
    activeUpdated = true;
  };

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section && inRoot) {
      insertActive();
      if (output.length && output[output.length - 1].trim() !== "") output.push("");
      inRoot = false;
      output.push(line);
      continue;
    }

    const activeLine = line.match(/^(\s*model_provider\s*=\s*)(.+?)(\s*(?:#.*)?)$/);
    if (inRoot && activeLine) {
      output.push(`${activeLine[1]}${tomlString(providerName)}${activeLine[3] || ""}`);
      activeUpdated = true;
      continue;
    }

    output.push(line);
  }

  if (!activeUpdated) insertActive();

  let next = output.join(newline);
  if (next && !next.endsWith(newline)) next += newline;
  if (next === original) return false;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, "utf8");
  return true;
}

function updateProviderInConfig(provider, options = {}) {
  const file = configPath();
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const newline = original.includes("\r\n") ? "\r\n" : os.EOL;
  const lines = original ? original.split(/\r?\n/) : [];
  const config = readConfig();
  const existing = config.providers.get(provider.name);
  const oldProvider = options.oldProvider && options.oldProvider !== provider.name ? options.oldProvider : "";
  const setActiveProvider = Object.prototype.hasOwnProperty.call(options, "activeProvider")
    ? options.activeProvider
    : undefined;
  const rewriteProviderSection = Boolean(oldProvider) || !providerConfigMatches(existing, provider);
  const sectionsToRemove = new Set();
  if (rewriteProviderSection) sectionsToRemove.add(provider.name);
  if (oldProvider) sectionsToRemove.add(oldProvider);

  const output = [];
  let inRoot = true;
  let skipping = false;
  let activeUpdated = false;

  const maybeInsertActiveBeforeSection = () => {
    if (setActiveProvider === undefined || activeUpdated) return;
    if (output.length && output[output.length - 1].trim() !== "") output.push("");
    output.push(`model_provider = ${tomlString(setActiveProvider)}`);
    activeUpdated = true;
    if (output.length && output[output.length - 1].trim() !== "") output.push("");
  };

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      if (inRoot) maybeInsertActiveBeforeSection();
      inRoot = false;
      const parsed = parseProviderSectionName(section[1]);
      skipping = sectionsToRemove.has(parsed);
      if (skipping) continue;
    }

    if (skipping) continue;

    const activeLine = line.match(/^(\s*model_provider\s*=\s*)(.+?)(\s*(?:#.*)?)$/);
    if (inRoot && activeLine) {
      const currentActive = parseTomlString(activeLine[2]);
      const shouldRewriteActive = setActiveProvider !== undefined
        || (oldProvider && currentActive === oldProvider);
      if (shouldRewriteActive) {
        output.push(`${activeLine[1]}${tomlString(setActiveProvider === undefined ? provider.name : setActiveProvider)}${activeLine[3] || ""}`);
        activeUpdated = true;
      } else {
        output.push(line);
      }
      continue;
    }

    output.push(line);
  }

  if (inRoot) maybeInsertActiveBeforeSection();

  if (rewriteProviderSection) {
    while (output.length && output[output.length - 1].trim() === "") output.pop();
    if (output.length) output.push("");
    output.push(...providerConfigSectionLines(provider));
  }

  let next = output.join(newline);
  if (next && !next.endsWith(newline)) next += newline;
  if (next === original) return false;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, "utf8");
  return true;
}

function isTargetProviderSection(sectionName, providerName) {
  if (sectionName === "model_providers") return false;
  const parsed = parseProviderSectionName(sectionName);
  return parsed === providerName;
}

function removeProviderFromConfig(providerName, replacementActiveProvider) {
  const file = configPath();
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file, "utf8");
  const lines = original.split(/\r?\n/);
  const output = [];
  let skipping = false;
  let removed = false;
  let activeUpdated = false;
  let inRoot = true;

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inRoot = false;
      skipping = isTargetProviderSection(section[1], providerName);
      if (skipping) removed = true;
      if (skipping) continue;
    }

    if (skipping) continue;

    const activeLine = line.match(/^(\s*model_provider\s*=\s*)(.+?)(\s*(?:#.*)?)$/);
    if (inRoot && activeLine) {
      if (replacementActiveProvider) {
        output.push(`${activeLine[1]}${tomlString(replacementActiveProvider)}${activeLine[3] || ""}`);
        activeUpdated = true;
      } else {
        removed = true;
      }
      continue;
    }

    output.push(line);
  }

  if (!removed && !activeUpdated) return false;
  fs.writeFileSync(file, output.join(os.EOL), "utf8");
  return true;
}

function idsClause(ids) {
  const clean = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  if (!clean.length) throw new Error("No conversation IDs were provided.");
  return clean.map(sqlQuote).join(", ");
}

async function getAllThreadRows() {
  return runSql(
    `SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, source, model_provider,
            cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
            git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname, agent_role,
            memory_mode, model, reasoning_effort, agent_path, thread_source, preview
       FROM threads
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC;`,
    { json: true }
  );
}

async function getThreadRowsByIds(ids) {
  const clause = idsClause(ids);
  return runSql(`SELECT * FROM threads WHERE id IN (${clause});`, { json: true });
}

function syncKeyForThread(row, managerState) {
  const entry = managerState.threads[row.id];
  return entry && entry.syncKey ? entry.syncKey : row.id;
}

function threadUpdatedAtMs(row) {
  return Number(row && (row.updated_at_ms || row.updated_at * 1000) || 0);
}

function buildProviders(threads, config) {
  const providers = new Map();
  const managerState = readManagerState();

  for (const provider of config.providers.values()) {
    providers.set(provider.name, {
      name: provider.name,
      displayName: provider.displayName || provider.name,
      baseUrl: provider.baseUrl || "",
      envKey: provider.envKey || "",
      hasAuth: Boolean(managerState.authByProvider && managerState.authByProvider[provider.name]),
      authUpdatedAt: managerState.authByProvider && managerState.authByProvider[provider.name]
        ? managerState.authByProvider[provider.name].updatedAt || ""
        : "",
      configured: true,
      active: provider.name === config.activeProvider,
      threadCount: 0,
      archivedCount: 0,
      latestUpdatedAtMs: null,
    });
  }

  for (const thread of threads) {
    const name = thread.model_provider || "Unknown";
    if (!providers.has(name)) {
      providers.set(name, {
        name,
        displayName: name,
        baseUrl: "",
        envKey: "",
        hasAuth: Boolean(managerState.authByProvider && managerState.authByProvider[name]),
        authUpdatedAt: managerState.authByProvider && managerState.authByProvider[name]
          ? managerState.authByProvider[name].updatedAt || ""
          : "",
        configured: false,
        active: name === config.activeProvider,
        threadCount: 0,
        archivedCount: 0,
        latestUpdatedAtMs: null,
      });
    }

    const provider = providers.get(name);
    provider.threadCount += 1;
    if (Number(thread.archived)) provider.archivedCount += 1;
    const updated = Number(thread.updated_at_ms || thread.updated_at * 1000 || 0);
    provider.latestUpdatedAtMs = Math.max(provider.latestUpdatedAtMs || 0, updated || 0);
  }

  if (config.activeProvider && !providers.has(config.activeProvider)) {
    providers.set(config.activeProvider, {
      name: config.activeProvider,
      displayName: config.activeProvider,
      baseUrl: "",
      envKey: "",
      hasAuth: Boolean(managerState.authByProvider && managerState.authByProvider[config.activeProvider]),
      authUpdatedAt: managerState.authByProvider && managerState.authByProvider[config.activeProvider]
        ? managerState.authByProvider[config.activeProvider].updatedAt || ""
        : "",
      configured: false,
      active: true,
      threadCount: 0,
      archivedCount: 0,
      latestUpdatedAtMs: null,
    });
  }

  return Array.from(providers.values()).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function readState() {
  await ensureSqliteAvailable();
  const [threads, config, managerState] = [await getAllThreadRows(), readConfig(), readManagerState()];
  const knownIds = new Set(threads.map((thread) => thread.id));

  const enrichedThreads = threads.map((thread) => {
    const meta = readSessionMeta(thread.rollout_path);
    const managerEntry = managerState.threads[thread.id] || null;
    const updatedAtMs = Number(thread.updated_at_ms || thread.updated_at * 1000 || 0);
    const createdAtMs = Number(thread.created_at_ms || thread.created_at * 1000 || 0);

    return {
      id: thread.id,
      title: thread.title || thread.first_user_message || "(untitled)",
      preview: thread.preview || thread.first_user_message || "",
      provider: thread.model_provider || (meta && meta.payload && meta.payload.model_provider) || "Unknown",
      sessionProvider: meta && meta.payload ? meta.payload.model_provider || "" : "",
      cwd: thread.cwd || "",
      source: thread.source || "",
      model: thread.model || "",
      reasoningEffort: thread.reasoning_effort || "",
      tokensUsed: Number(thread.tokens_used || 0),
      archived: Boolean(Number(thread.archived || 0)),
      createdAtMs,
      updatedAtMs,
      rolloutPath: thread.rollout_path || "",
      rolloutExists: Boolean(thread.rollout_path && fs.existsSync(thread.rollout_path)),
      syncKey: managerEntry && managerEntry.syncKey ? managerEntry.syncKey : thread.id,
      syncedCopy: Boolean(managerEntry && managerEntry.createdByTool),
      syncedFromThreadId: managerEntry ? managerEntry.sourceThreadId || "" : "",
      syncedFromProvider: managerEntry ? managerEntry.sourceProvider || "" : "",
    };
  });

  const staleManagerIds = Object.keys(managerState.threads).filter((id) => !knownIds.has(id));
  const providers = buildProviders(enrichedThreads.map((thread) => ({
    id: thread.id,
    model_provider: thread.provider,
    archived: thread.archived ? 1 : 0,
    updated_at_ms: thread.updatedAtMs,
  })), config);

  return {
    codexHome: getCodexHome(),
    sqlitePath: stateDbPath(),
    managerStatePath: managerStatePath(),
    activeProvider: config.activeProvider,
    providers,
    threads: enrichedThreads,
    staleManagerIds,
    generatedAt: new Date().toISOString(),
  };
}

function timestampForPath() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeRelativeFromCodexHome(filePath) {
  const home = path.resolve(getCodexHome());
  const absolute = path.resolve(filePath);
  const relative = path.relative(home, absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  const hash = crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 12);
  return path.join("external", `${hash}-${path.basename(filePath)}`);
}

function copyFileWithParents(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

async function backupSqlite(destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const sqlitePath = destination.replace(/\\/g, "/").replace(/'/g, "''");
  await execFileAsync(sqliteExecutable(), [stateDbPath(), `.backup '${sqlitePath}'`], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function createBackup(label, options = {}) {
  const backupRoot = path.join(getCodexHome(), "provider-manager-backups");
  const backupDir = path.join(backupRoot, `${timestampForPath()}-${label.replace(/[^A-Za-z0-9_-]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(backupDir, { recursive: true });

  await backupSqlite(path.join(backupDir, "state_5.sqlite"));

  const files = new Set(options.files || []);
  if (options.includeConfig) files.add(configPath());
  if (options.includeAuth) files.add(authPath());
  if (options.includeSessionIndex) files.add(sessionIndexPath());
  if (options.includeManagerState) files.add(managerStatePath());
  if (options.includeGlobalState) files.add(globalStatePath());
  for (const rolloutPath of options.rolloutPaths || []) files.add(rolloutPath);

  const copied = [];
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    const destination = path.join(backupDir, "files", safeRelativeFromCodexHome(file));
    copyFileWithParents(file, destination);
    copied.push(file);
  }

  fs.writeFileSync(
    path.join(backupDir, "manifest.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), label, codexHome: getCodexHome(), copied }, null, 2)}\n`,
    "utf8"
  );

  return backupDir;
}

function rewriteSessionIndexRemoving(ids) {
  const file = sessionIndexPath();
  if (!fs.existsSync(file)) return;
  const idSet = new Set(ids);
  const nextLines = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        const parsed = JSON.parse(line);
        return !idSet.has(parsed.id);
      } catch {
        return true;
      }
    });
  fs.writeFileSync(file, nextLines.length ? `${nextLines.join("\n")}\n` : "", "utf8");
}

function appendSessionIndex(row) {
  const file = sessionIndexPath();
  const updatedAtMs = Number(row.updated_at_ms || row.updated_at * 1000 || Date.now());
  const entry = {
    id: row.id,
    thread_name: row.title || row.first_user_message || "(untitled)",
    updated_at: new Date(updatedAtMs).toISOString(),
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function rewriteSessionIndexUpserting(rows) {
  const file = sessionIndexPath();
  const byId = new Map((rows || []).filter(Boolean).map((row) => [row.id, row]));
  if (!byId.size) return;

  const nextLines = [];
  const seen = new Set();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (byId.has(parsed.id)) {
          const row = byId.get(parsed.id);
          const updatedAtMs = Number(row.updated_at_ms || row.updated_at * 1000 || Date.now());
          nextLines.push(JSON.stringify({
            id: row.id,
            thread_name: row.title || row.first_user_message || "(untitled)",
            updated_at: new Date(updatedAtMs).toISOString(),
          }));
          seen.add(row.id);
          continue;
        }
      } catch {
        // Keep malformed historical lines rather than deleting user data.
      }
      nextLines.push(line);
    }
  }

  for (const row of byId.values()) {
    if (seen.has(row.id)) continue;
    const updatedAtMs = Number(row.updated_at_ms || row.updated_at * 1000 || Date.now());
    nextLines.push(JSON.stringify({
      id: row.id,
      thread_name: row.title || row.first_user_message || "(untitled)",
      updated_at: new Date(updatedAtMs).toISOString(),
    }));
  }

  fs.writeFileSync(file, nextLines.length ? `${nextLines.join("\n")}\n` : "", "utf8");
}

function moveRolloutToTrash(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const trashRoot = path.join(getCodexHome(), "provider-manager-trash", timestampForPath());
  const destination = path.join(trashRoot, safeRelativeFromCodexHome(filePath));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(filePath, destination);
  } catch {
    fs.copyFileSync(filePath, destination);
    fs.unlinkSync(filePath);
  }
  return destination;
}

async function moveThreads(ids, targetProvider) {
  if (!targetProvider) throw new Error("Target provider is required.");
  const threads = await getThreadRowsByIds(ids);
  if (!threads.length) throw new Error("No matching conversations were found.");
  const backupDir = await createBackup("move", {
    rolloutPaths: threads.map((thread) => thread.rollout_path),
    includeManagerState: true,
    includeGlobalState: true,
  });

  for (const thread of threads) {
    if (thread.rollout_path && fs.existsSync(thread.rollout_path)) {
      updateSessionMeta(thread.rollout_path, (meta) => {
        meta.payload.model_provider = targetProvider;
      });
    }
  }

  await runSql(`
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    UPDATE threads
       SET model_provider = ${sqlQuote(targetProvider)}
     WHERE id IN (${idsClause(ids)});
    COMMIT;
  `);

  return { changed: threads.length, backupDir };
}

async function deleteThreads(ids, backupLabel = "delete") {
  const cleanIds = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  const threads = await getThreadRowsByIds(cleanIds);
  if (!threads.length) throw new Error("No matching conversations were found.");
  const backupDir = await createBackup(backupLabel, {
    rolloutPaths: threads.map((thread) => thread.rollout_path),
    includeSessionIndex: true,
    includeManagerState: true,
    includeGlobalState: true,
  });

  await runSql(`
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    DELETE FROM thread_dynamic_tools WHERE thread_id IN (${idsClause(cleanIds)});
    DELETE FROM stage1_outputs WHERE thread_id IN (${idsClause(cleanIds)});
    DELETE FROM thread_goals WHERE thread_id IN (${idsClause(cleanIds)});
    DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${idsClause(cleanIds)}) OR child_thread_id IN (${idsClause(cleanIds)});
    DELETE FROM threads WHERE id IN (${idsClause(cleanIds)});
    COMMIT;
  `);

  const trashPaths = [];
  for (const thread of threads) {
    const trashPath = moveRolloutToTrash(thread.rollout_path);
    if (trashPath) trashPaths.push(trashPath);
  }

  rewriteSessionIndexRemoving(cleanIds);
  const managerState = readManagerState();
  for (const id of cleanIds) delete managerState.threads[id];
  writeManagerState(managerState);
  const globalState = readGlobalState();
  if (removeThreadGlobalState(globalState, cleanIds)) writeGlobalState(globalState);

  return { changed: threads.length, backupDir, trashPaths };
}

function makeDuplicateRolloutPath(sourceRow, newId) {
  const sourcePath = sourceRow.rollout_path;
  const directory = path.dirname(sourcePath);
  let filename = path.basename(sourcePath);
  if (filename.includes(sourceRow.id)) {
    filename = filename.replace(sourceRow.id, newId);
  } else {
    const stamp = new Date(Number(sourceRow.created_at_ms || sourceRow.created_at * 1000 || Date.now()))
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d{3}Z$/, "");
    filename = `rollout-${stamp}-${newId}.jsonl`;
  }

  let destination = path.join(directory, filename);
  let suffix = 1;
  while (fs.existsSync(destination)) {
    destination = path.join(directory, filename.replace(/\.jsonl$/i, `-${suffix}.jsonl`));
    suffix += 1;
  }
  return destination;
}

async function tableColumns(tableName) {
  const rows = await runSql(`PRAGMA table_info(${tableName});`, { json: true });
  return rows.map((row) => row.name);
}

async function insertDuplicateThread(sourceRow, targetProvider, managerState, globalState) {
  if (!sourceRow.rollout_path || !fs.existsSync(sourceRow.rollout_path)) {
    throw new Error(`Rollout file is missing for ${sourceRow.id}`);
  }

  const sourceId = sourceRow.id;
  const newId = crypto.randomUUID();
  const destination = makeDuplicateRolloutPath(sourceRow, newId);
  const syncKey = syncKeyForThread(sourceRow, managerState);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourceRow.rollout_path, destination);

  try {
    updateSessionMeta(destination, (meta) => {
      meta.payload.id = newId;
      meta.payload.model_provider = targetProvider;
    });

    const columns = await tableColumns("threads");
    const nextRow = { ...sourceRow, id: newId, rollout_path: destination, model_provider: targetProvider };
    const insertSql = `
      PRAGMA busy_timeout = 5000;
      BEGIN IMMEDIATE;
      INSERT INTO threads (${columns.join(", ")})
      VALUES (${columns.map((column) => sqlQuote(nextRow[column])).join(", ")});
      INSERT OR IGNORE INTO thread_dynamic_tools (thread_id, position, name, description, input_schema, defer_loading, namespace)
      SELECT ${sqlQuote(newId)}, position, name, description, input_schema, defer_loading, namespace
        FROM thread_dynamic_tools
       WHERE thread_id = ${sqlQuote(sourceId)};
      INSERT OR IGNORE INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at, rollout_slug, usage_count, last_usage, selected_for_phase2, selected_for_phase2_source_updated_at)
      SELECT ${sqlQuote(newId)}, source_updated_at, raw_memory, rollout_summary, generated_at, rollout_slug, usage_count, last_usage, selected_for_phase2, selected_for_phase2_source_updated_at
        FROM stage1_outputs
       WHERE thread_id = ${sqlQuote(sourceId)};
      INSERT OR IGNORE INTO thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
      SELECT ${sqlQuote(newId)}, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
        FROM thread_goals
       WHERE thread_id = ${sqlQuote(sourceId)};
      COMMIT;
    `;
    await runSql(insertSql);

    managerState.threads[newId] = {
      syncKey,
      createdByTool: true,
      sourceThreadId: sourceId,
      sourceProvider: sourceRow.model_provider || "",
      targetProvider,
      createdAt: new Date().toISOString(),
    };

    appendSessionIndex(nextRow);
    cloneThreadGlobalState(globalState, sourceId, newId);
    return { sourceId, newId, targetProvider, rolloutPath: destination, skipped: false };
  } catch (error) {
    try {
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
    } catch {
      // The backup still contains the pre-operation database state if cleanup fails.
    }
    throw error;
  }
}

async function replaceExistingSyncedThread(sourceRow, targetRow, targetProvider, managerState, globalState) {
  if (!sourceRow.rollout_path || !fs.existsSync(sourceRow.rollout_path)) {
    throw new Error(`Rollout file is missing for ${sourceRow.id}`);
  }
  if (!targetRow.rollout_path) {
    throw new Error(`Rollout path is missing for ${targetRow.id}`);
  }

  const syncKey = syncKeyForThread(sourceRow, managerState);
  const targetId = targetRow.id;
  const sourceId = sourceRow.id;
  fs.mkdirSync(path.dirname(targetRow.rollout_path), { recursive: true });
  fs.copyFileSync(sourceRow.rollout_path, targetRow.rollout_path);
  updateSessionMeta(targetRow.rollout_path, (meta) => {
    meta.payload.id = targetId;
    meta.payload.model_provider = targetProvider;
  });

  const columns = await tableColumns("threads");
  const nextRow = {
    ...sourceRow,
    id: targetId,
    rollout_path: targetRow.rollout_path,
    model_provider: targetProvider,
  };
  const assignments = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = ${sqlQuote(nextRow[column])}`)
    .join(", ");

  await runSql(`
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    UPDATE threads
       SET ${assignments}
     WHERE id = ${sqlQuote(targetId)};

    DELETE FROM thread_dynamic_tools WHERE thread_id = ${sqlQuote(targetId)};
    INSERT OR IGNORE INTO thread_dynamic_tools (thread_id, position, name, description, input_schema, defer_loading, namespace)
    SELECT ${sqlQuote(targetId)}, position, name, description, input_schema, defer_loading, namespace
      FROM thread_dynamic_tools
     WHERE thread_id = ${sqlQuote(sourceId)};

    DELETE FROM stage1_outputs WHERE thread_id = ${sqlQuote(targetId)};
    INSERT OR IGNORE INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at, rollout_slug, usage_count, last_usage, selected_for_phase2, selected_for_phase2_source_updated_at)
    SELECT ${sqlQuote(targetId)}, source_updated_at, raw_memory, rollout_summary, generated_at, rollout_slug, usage_count, last_usage, selected_for_phase2, selected_for_phase2_source_updated_at
      FROM stage1_outputs
     WHERE thread_id = ${sqlQuote(sourceId)};

    DELETE FROM thread_goals WHERE thread_id = ${sqlQuote(targetId)};
    INSERT OR IGNORE INTO thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
    SELECT ${sqlQuote(targetId)}, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
      FROM thread_goals
     WHERE thread_id = ${sqlQuote(sourceId)};
    COMMIT;
  `);

  managerState.threads[targetId] = {
    ...(managerState.threads[targetId] || {}),
    syncKey,
    createdByTool: true,
    sourceThreadId: sourceId,
    sourceProvider: sourceRow.model_provider || "",
    targetProvider,
    refreshedAt: new Date().toISOString(),
  };

  rewriteSessionIndexUpserting([nextRow]);
  replaceThreadGlobalState(globalState, sourceId, targetId);
  return { sourceId, targetId, targetProvider, rolloutPath: targetRow.rollout_path, refreshed: true };
}

async function syncThreads(ids, targetProviders) {
  const targets = Array.from(new Set((targetProviders || []).map(String).filter(Boolean)));
  if (!targets.length) throw new Error("At least one target provider is required.");

  const allRows = await getAllThreadRows();
  const selected = allRows.filter((row) => ids.includes(row.id));
  if (!selected.length) throw new Error("No matching conversations were found.");

  const managerState = readManagerState();
  const existing = new Map();
  for (const row of allRows) {
    const key = `${syncKeyForThread(row, managerState)}::${row.model_provider}`;
    const current = existing.get(key);
    if (!current || threadUpdatedAtMs(row) > threadUpdatedAtMs(current)) existing.set(key, row);
  }
  const backupRollouts = new Set(selected.map((thread) => thread.rollout_path));
  for (const row of selected) {
    const syncKey = syncKeyForThread(row, managerState);
    for (const target of targets) {
      const targetRow = existing.get(`${syncKey}::${target}`);
      if (targetRow) backupRollouts.add(targetRow.rollout_path);
    }
  }

  const backupDir = await createBackup("sync", {
    rolloutPaths: Array.from(backupRollouts),
    includeSessionIndex: true,
    includeManagerState: true,
    includeGlobalState: true,
  });
  const globalState = readGlobalState();

  const created = [];
  const refreshed = [];
  const skipped = [];
  for (const row of selected) {
    const syncKey = syncKeyForThread(row, managerState);
    for (const target of targets) {
      if (target === row.model_provider) {
        skipped.push({ sourceId: row.id, targetProvider: target, reason: "same-provider" });
        continue;
      }
      const key = `${syncKey}::${target}`;
      const targetRow = existing.get(key);
      if (targetRow) {
        if (threadUpdatedAtMs(row) > threadUpdatedAtMs(targetRow)) {
          const result = await replaceExistingSyncedThread(row, targetRow, target, managerState, globalState);
          existing.set(key, { ...row, id: result.targetId, rollout_path: result.rolloutPath, model_provider: target });
          refreshed.push(result);
        } else {
          skipped.push({ sourceId: row.id, targetProvider: target, reason: "already-up-to-date" });
        }
        continue;
      }
      const result = await insertDuplicateThread(row, target, managerState, globalState);
      existing.set(key, { ...row, id: result.newId, rollout_path: result.rolloutPath, model_provider: target });
      created.push(result);
    }
  }

  writeManagerState(managerState);
  writeGlobalState(globalState);
  return { changed: created.length + refreshed.length, created, refreshed, skipped, backupDir };
}

async function syncAllThreads() {
  const allRows = await getAllThreadRows();
  const config = readConfig();
  const providers = buildProviders(allRows, config).map((provider) => provider.name);
  if (providers.length < 2) throw new Error("At least two providers are required to sync all conversations.");

  const managerState = readManagerState();

  const groups = new Map();
  for (const row of allRows) {
    const syncKey = syncKeyForThread(row, managerState);
    if (!groups.has(syncKey)) groups.set(syncKey, []);
    groups.get(syncKey).push(row);
  }

  const backupDir = await createBackup("sync-all", {
    rolloutPaths: allRows.map((thread) => thread.rollout_path),
    includeSessionIndex: true,
    includeManagerState: true,
    includeGlobalState: true,
  });
  const globalState = readGlobalState();

  const created = [];
  const refreshed = [];
  const skipped = [];
  for (const [syncKey, group] of groups.entries()) {
    const sorted = [...group].sort((a, b) => threadUpdatedAtMs(b) - threadUpdatedAtMs(a));
    const byProvider = new Map();
    for (const row of sorted) {
      if (!byProvider.has(row.model_provider)) byProvider.set(row.model_provider, row);
    }
    const preferredSource = sorted.find((row) => row.rollout_path && fs.existsSync(row.rollout_path)) || sorted[0];

    for (const provider of providers) {
      const targetRow = byProvider.get(provider);
      if (targetRow) {
        if (targetRow.id !== preferredSource.id && threadUpdatedAtMs(preferredSource) > threadUpdatedAtMs(targetRow)) {
          const result = await replaceExistingSyncedThread(preferredSource, targetRow, provider, managerState, globalState);
          byProvider.set(provider, { ...preferredSource, id: result.targetId, rollout_path: result.rolloutPath, model_provider: provider });
          refreshed.push(result);
        } else {
          skipped.push({ syncKey, targetProvider: provider, reason: "already-up-to-date" });
        }
        continue;
      }

      const result = await insertDuplicateThread(preferredSource, provider, managerState, globalState);
      byProvider.set(provider, { ...preferredSource, id: result.newId, model_provider: provider });
      created.push(result);
    }
  }

  writeManagerState(managerState);
  writeGlobalState(globalState);
  return { changed: created.length + refreshed.length, created, refreshed, skipped, backupDir };
}

function candidateSourceIdsForCopy(copyId, managerEntry, groupsBySyncKey) {
  const candidates = [];
  const add = (id) => {
    if (id && id !== copyId && !candidates.includes(id)) candidates.push(id);
  };

  add(managerEntry.sourceThreadId);
  add(managerEntry.syncKey);
  for (const row of groupsBySyncKey.get(managerEntry.syncKey) || []) add(row.id);
  return candidates;
}

async function repairGlobalStateVisibility() {
  const allRows = await getAllThreadRows();
  const managerState = readManagerState();
  const globalState = readGlobalState();
  if (!globalState) return { changed: 0, repaired: [], backupDir: null };

  const groupsBySyncKey = new Map();
  for (const row of allRows) {
    const syncKey = syncKeyForThread(row, managerState);
    if (!groupsBySyncKey.has(syncKey)) groupsBySyncKey.set(syncKey, []);
    groupsBySyncKey.get(syncKey).push(row);
  }

  const backupDir = await createBackup("repair-visibility", {
    includeManagerState: true,
    includeGlobalState: true,
  });

  const rowsById = new Map(allRows.map((row) => [row.id, row]));
  const repaired = [];
  for (const [copyId, managerEntry] of Object.entries(managerState.threads || {})) {
    if (!rowsById.has(copyId) || !managerEntry.createdByTool) continue;
    const candidates = candidateSourceIdsForCopy(copyId, managerEntry, groupsBySyncKey);
    for (const sourceId of candidates) {
      if (cloneThreadGlobalState(globalState, sourceId, copyId)) {
        repaired.push({ sourceId, copyId });
        break;
      }
    }
  }

  if (repaired.length) writeGlobalState(globalState);
  return { changed: repaired.length, repaired, backupDir };
}

function updateManagerProviderReferences(oldProvider, nextProvider) {
  const managerState = readManagerState();
  let changed = false;
  for (const entry of Object.values(managerState.threads || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.sourceProvider === oldProvider) {
      entry.sourceProvider = nextProvider;
      changed = true;
    }
    if (entry.targetProvider === oldProvider) {
      entry.targetProvider = nextProvider;
      changed = true;
    }
  }
  if (changed) writeManagerState(managerState);
  return changed;
}

async function renameProviderInThreads(oldProvider, nextProvider, rows) {
  if (!oldProvider || oldProvider === nextProvider || !rows.length) {
    return { changed: 0, managerStateChanged: false };
  }

  for (const thread of rows) {
    if (thread.rollout_path && fs.existsSync(thread.rollout_path)) {
      updateSessionMeta(thread.rollout_path, (meta) => {
        meta.payload.model_provider = nextProvider;
      });
    }
  }

  await runSql(`
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    UPDATE threads
       SET model_provider = ${sqlQuote(nextProvider)}
     WHERE model_provider = ${sqlQuote(oldProvider)};
    COMMIT;
  `);

  return {
    changed: rows.length,
    managerStateChanged: updateManagerProviderReferences(oldProvider, nextProvider),
  };
}

async function saveProviderConfig(rawConfig) {
  const provider = normalizeProviderConfig(rawConfig || {});
  const oldProvider = provider.oldProvider || provider.name;
  const isRename = oldProvider && oldProvider !== provider.name;
  const rows = isRename
    ? (await getAllThreadRows()).filter((row) => row.model_provider === oldProvider)
    : [];
  const currentConfig = readConfig();
  const backupDir = await createBackup("save-provider", {
    rolloutPaths: rows.map((thread) => thread.rollout_path),
    includeConfig: true,
    includeAuth: true,
    includeManagerState: true,
  });

  const configChanged = updateProviderInConfig(provider, {
    oldProvider,
    activeProvider: currentConfig.activeProvider === oldProvider ? provider.name : undefined,
  });
  const renamed = await renameProviderInThreads(oldProvider, provider.name, rows);
  const authRename = isRename
    ? renameAuthForProvider(oldProvider, provider.name)
    : { changed: false, action: "unchanged" };

  return {
    changed: Number(configChanged) + renamed.changed + Number(renamed.managerStateChanged) + Number(authRename.changed),
    configChanged,
    renamedThreads: renamed.changed,
    managerStateChanged: renamed.managerStateChanged,
    authChanged: authRename.changed,
    authAction: authRename.action,
    provider: provider.name,
    backupDir,
  };
}

async function switchProvider(rawConfig) {
  const input = rawConfig || {};
  const providerName = String(input.provider || "").trim();
  if (!providerName) throw new Error("Provider name is required.");

  if (isOpenAiAuthProvider(providerName)) {
    const config = readConfig();
    const backupDir = await createBackup("switch-provider", { includeConfig: true, includeAuth: true, includeManagerState: true });
    const configChanged = updateActiveProviderOnly(providerName);
    const authResult = syncAuthForProviderSwitch(config.activeProvider, providerName);
    return {
      changed: Number(configChanged) + Number(authResult.authChanged),
      configChanged,
      activeProvider: providerName,
      ...authResult,
      backupDir,
    };
  }

  const config = readConfig();
  const existing = config.providers.get(providerName);
  const provider = normalizeProviderConfig({
    provider: providerName,
    oldProvider: providerName,
    name: input.name ?? input.displayName ?? (existing ? existing.displayName : providerName),
    baseUrl: input.baseUrl ?? input.base_url ?? (existing ? existing.baseUrl : ""),
    envKey: input.envKey ?? input.env_key ?? (existing ? existing.envKey : ""),
  });

  const backupDir = await createBackup("switch-provider", { includeConfig: true, includeAuth: true, includeManagerState: true });
  const configChanged = updateProviderInConfig(provider, { activeProvider: provider.name });
  const authResult = syncAuthForProviderSwitch(config.activeProvider, provider.name);
  return {
    changed: Number(configChanged) + Number(authResult.authChanged),
    configChanged,
    activeProvider: provider.name,
    ...authResult,
    backupDir,
  };
}

async function deleteProvider(providerName, deleteConversations) {
  if (!providerName) throw new Error("Provider name is required.");
  if (isOpenAiAuthProvider(providerName)) {
    throw new Error('The built-in "openai" provider cannot be deleted.');
  }
  const allRows = await getAllThreadRows();
  const matchingThreads = allRows.filter((row) => row.model_provider === providerName);
  const config = readConfig();
  const remainingConfigured = Array.from(config.providers.keys()).filter((name) => name !== providerName);
  const replacement = config.activeProvider === providerName ? remainingConfigured[0] || null : config.activeProvider;

  const backupDir = await createBackup("delete-provider", {
    rolloutPaths: deleteConversations ? matchingThreads.map((thread) => thread.rollout_path) : [],
    includeConfig: true,
    includeAuth: true,
    includeSessionIndex: true,
    includeManagerState: true,
    includeGlobalState: true,
  });

  const configChanged = removeProviderFromConfig(providerName, replacement);
  const authCleanup = cleanupAuthForProvider(providerName);
  let deletedThreads = 0;
  let trashPaths = [];

  if (deleteConversations && matchingThreads.length) {
    await runSql(`
      PRAGMA busy_timeout = 5000;
      BEGIN IMMEDIATE;
      DELETE FROM thread_dynamic_tools WHERE thread_id IN (${idsClause(matchingThreads.map((thread) => thread.id))});
      DELETE FROM stage1_outputs WHERE thread_id IN (${idsClause(matchingThreads.map((thread) => thread.id))});
      DELETE FROM thread_goals WHERE thread_id IN (${idsClause(matchingThreads.map((thread) => thread.id))});
      DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${idsClause(matchingThreads.map((thread) => thread.id))}) OR child_thread_id IN (${idsClause(matchingThreads.map((thread) => thread.id))});
      DELETE FROM threads WHERE id IN (${idsClause(matchingThreads.map((thread) => thread.id))});
      COMMIT;
    `);

    for (const thread of matchingThreads) {
      const trashPath = moveRolloutToTrash(thread.rollout_path);
      if (trashPath) trashPaths.push(trashPath);
    }

    rewriteSessionIndexRemoving(matchingThreads.map((thread) => thread.id));
    const managerState = readManagerState();
    for (const thread of matchingThreads) delete managerState.threads[thread.id];
    writeManagerState(managerState);
    const globalState = readGlobalState();
    if (removeThreadGlobalState(globalState, matchingThreads.map((thread) => thread.id))) {
      writeGlobalState(globalState);
    }
    deletedThreads = matchingThreads.length;
  }

  return {
    changed: Number(configChanged) + deletedThreads + Number(authCleanup.changed),
    configChanged,
    deletedThreads,
    authChanged: authCleanup.changed,
    authAction: authCleanup.action,
    backupDir,
    trashPaths,
  };
}

function getClaudeHome() {
  const candidates = [
    process.env.CLAUDE_HOME,
    path.join(os.homedir(), ".claude"),
    path.join(os.homedir(), ".config", "claude"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function claudeSettingsPath() {
  return path.join(getClaudeHome(), "settings.json");
}

function claudeConfigPath() {
  return path.join(getClaudeHome(), "config.json");
}

function claudeProvidersPath() {
  return path.join(getClaudeHome(), "provider-manager-providers.json");
}

function claudeHistoryPath() {
  return path.join(getClaudeHome(), "history.jsonl");
}

function claudeProjectsPath() {
  return path.join(getClaudeHome(), "projects");
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function maskSecretValue(key, value) {
  if (value === null || value === undefined) return value;
  const lower = String(key || "").toLowerCase();
  if (!/(token|key|secret|password|credential|auth)/.test(lower)) return value;
  const text = String(value);
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function maskSecrets(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      maskSecrets(entryValue, entryKey),
    ]));
  }
  return maskSecretValue(key, value);
}

function readClaudeProviderStore() {
  const parsed = readJsonFile(claudeProvidersPath());
  const providers = parsed && parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {};
  return {
    version: APP_VERSION,
    activeProvider: parsed && parsed.activeProvider ? String(parsed.activeProvider) : "",
    providers,
  };
}

function writeClaudeProviderStore(store) {
  writeJsonFile(claudeProvidersPath(), {
    version: APP_VERSION,
    activeProvider: store.activeProvider || "",
    providers: store.providers || {},
  });
}

function currentClaudeEnv(settings) {
  settings = settings && typeof settings === "object" ? settings : {};
  const env = settings && settings.env && typeof settings.env === "object" ? settings.env : {};
  return {
    baseUrl: String(env.ANTHROPIC_BASE_URL || settings.ANTHROPIC_BASE_URL || ""),
    authToken: String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || settings.ANTHROPIC_AUTH_TOKEN || settings.ANTHROPIC_API_KEY || ""),
    model: String(env.ANTHROPIC_MODEL || settings.ANTHROPIC_MODEL || ""),
    opusModel: String(env.ANTHROPIC_DEFAULT_OPUS_MODEL || settings.ANTHROPIC_DEFAULT_OPUS_MODEL || ""),
    sonnetModel: String(env.ANTHROPIC_DEFAULT_SONNET_MODEL || settings.ANTHROPIC_DEFAULT_SONNET_MODEL || ""),
    haikuModel: String(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || settings.ANTHROPIC_DEFAULT_HAIKU_MODEL || ""),
  };
}

function storedClaudeProviderValue(provider, camelKey, snakeKey) {
  return provider && (provider[camelKey] || provider[snakeKey] || "");
}

function normalizeClaudeProviderConfig(raw, existing = null) {
  const providerName = String(raw.name || raw.provider || raw.nameKey || "").trim();
  const displayName = providerName;
  const baseUrl = String(raw.baseUrl || raw.base_url || "").trim();
  const authToken = String(raw.authToken || raw.auth_token || raw.envKey || raw.env_key || "").trim();
  const model = String(raw.model || raw.anthropicModel || "").trim();
  const opusModel = String(raw.opusModel || raw.opus_model || raw.anthropicOpusModel || "").trim();
  const sonnetModel = String(raw.sonnetModel || raw.sonnet_model || raw.anthropicSonnetModel || "").trim();
  const haikuModel = String(raw.haikuModel || raw.haiku_model || raw.anthropicHaikuModel || "").trim();
  const oldProvider = String(raw.oldProvider || raw.old_provider || providerName).trim();

  if (!providerName) throw new Error("Provider name is required.");
  if (!displayName) throw new Error("Provider display name is required.");
  if (!baseUrl) throw new Error("Claude base_url is required.");
  if (!authToken && !(existing && existing.authToken)) throw new Error("Claude auth token is required.");
  if (!model) throw new Error("Claude model is required.");
  if (!opusModel) throw new Error("Claude opus_model is required.");
  if (!sonnetModel) throw new Error("Claude sonnet_model is required.");
  if (!haikuModel) throw new Error("Claude haiku_model is required.");

  return {
    oldProvider,
    name: providerName,
    displayName,
    baseUrl,
    authToken: authToken || (existing && existing.authToken) || "",
    model,
    opusModel,
    sonnetModel,
    haikuModel,
  };
}

function claudeProviderMatchesCurrent(provider, current) {
  if (!provider || !current) return false;
  return String(provider.baseUrl || "") === String(current.baseUrl || "")
    && String(provider.authToken || "") === String(current.authToken || "")
    && String(provider.model || "") === String(current.model || "")
    && String(provider.opusModel || "") === String(current.opusModel || "")
    && String(provider.sonnetModel || "") === String(current.sonnetModel || "")
    && String(provider.haikuModel || "") === String(current.haikuModel || "");
}

function publicClaudeProvider(provider, active) {
  return {
    name: provider.name,
    displayName: provider.displayName || provider.name,
    baseUrl: provider.baseUrl || "",
    envKey: provider.authToken ? maskSecretValue("ANTHROPIC_AUTH_TOKEN", provider.authToken) : "",
    hasAuthToken: Boolean(provider.authToken),
    model: provider.model || "",
    opusModel: provider.opusModel || "",
    sonnetModel: provider.sonnetModel || "",
    haikuModel: provider.haikuModel || "",
    configured: true,
    active: Boolean(active),
    virtual: Boolean(provider.virtual),
  };
}

function buildClaudeProviderState(settings) {
  const store = readClaudeProviderStore();
  const current = currentClaudeEnv(settings);
  const providers = [];
  let activeProvider = "";

  for (const [name, provider] of Object.entries(store.providers || {})) {
    const normalized = {
      name,
      displayName: provider.displayName || provider.name || name,
      baseUrl: storedClaudeProviderValue(provider, "baseUrl", "base_url"),
      authToken: provider.authToken || "",
      model: provider.model || "",
      opusModel: storedClaudeProviderValue(provider, "opusModel", "opus_model"),
      sonnetModel: storedClaudeProviderValue(provider, "sonnetModel", "sonnet_model"),
      haikuModel: storedClaudeProviderValue(provider, "haikuModel", "haiku_model"),
    };
    const active = claudeProviderMatchesCurrent(normalized, current);
    if (active) activeProvider = name;
    providers.push(publicClaudeProvider(normalized, active));
  }

  if (!activeProvider && (current.baseUrl || current.authToken)) {
    activeProvider = "__current__";
    providers.unshift(publicClaudeProvider({
      name: "__current__",
      displayName: current.model ? `当前设置 (${current.model})` : "当前设置",
      baseUrl: current.baseUrl,
      authToken: current.authToken,
      model: current.model,
      opusModel: current.opusModel,
      sonnetModel: current.sonnetModel,
      haikuModel: current.haikuModel,
      virtual: true,
    }, true));
  }

  providers.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.virtual !== b.virtual) return a.virtual ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { providers, activeProvider };
}

function applyClaudeProviderToSettings(provider) {
  const file = claudeSettingsPath();
  const settings = readJsonFile(file) || {};
  if (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env)) settings.env = {};
  settings.env.ANTHROPIC_BASE_URL = provider.baseUrl;
  settings.env.ANTHROPIC_AUTH_TOKEN = provider.authToken;
  settings.env.ANTHROPIC_MODEL = provider.model;
  settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.haikuModel;
  settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.sonnetModel;
  settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.opusModel;
  writeJsonFile(file, settings);
}

function safeRelativeFromClaudeHome(filePath) {
  const home = path.resolve(getClaudeHome());
  const absolute = path.resolve(filePath);
  const relative = path.relative(home, absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  const hash = crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 12);
  return path.join("external", `${hash}-${path.basename(filePath)}`);
}

function createClaudeBackup(label, files = []) {
  const backupRoot = path.join(getClaudeHome(), "provider-manager-backups");
  const backupDir = path.join(backupRoot, `${timestampForPath()}-${label.replace(/[^A-Za-z0-9_-]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const copied = [];
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    const destination = path.join(backupDir, "files", safeRelativeFromClaudeHome(file));
    copyFileWithParents(file, destination);
    copied.push(file);
  }

  fs.writeFileSync(
    path.join(backupDir, "manifest.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), label, claudeHome: getClaudeHome(), copied }, null, 2)}\n`,
    "utf8"
  );

  return backupDir;
}

async function saveClaudeProviderConfig(rawConfig) {
  const store = readClaudeProviderStore();
  const oldProvider = String(rawConfig.oldProvider || rawConfig.old_provider || rawConfig.provider || "").trim();
  const settings = readJsonFile(claudeSettingsPath()) || {};
  const current = currentClaudeEnv(settings);
  const storedExisting = oldProvider && store.providers ? store.providers[oldProvider] : null;
  const existing = storedExisting || (current.authToken ? { authToken: current.authToken } : null);
  const provider = normalizeClaudeProviderConfig(rawConfig || {}, existing);
  const isRename = provider.oldProvider && provider.oldProvider !== provider.name;
  const backupDir = createClaudeBackup("save-claude-provider", [claudeSettingsPath(), claudeProvidersPath()]);

  if (isRename && store.providers[provider.oldProvider]) delete store.providers[provider.oldProvider];
  store.providers[provider.name] = {
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    base_url: provider.baseUrl,
    authToken: provider.authToken,
    auth_token: provider.authToken,
    model: provider.model,
    anthropic_model: provider.model,
    opusModel: provider.opusModel,
    opus_model: provider.opusModel,
    sonnetModel: provider.sonnetModel,
    sonnet_model: provider.sonnetModel,
    haikuModel: provider.haikuModel,
    haiku_model: provider.haikuModel,
    updatedAt: new Date().toISOString(),
  };

  store.activeProvider = provider.name;
  applyClaudeProviderToSettings(provider);

  writeClaudeProviderStore(store);
  return { changed: 2, provider: provider.name, backupDir };
}

async function switchClaudeProvider(rawConfig) {
  const providerName = String(rawConfig.provider || "").trim();
  if (!providerName) throw new Error("Provider name is required.");
  if (providerName === "__current__") return { changed: 0, activeProvider: providerName, backupDir: null };

  const store = readClaudeProviderStore();
  const stored = store.providers[providerName];
  if (!stored) throw new Error("Claude provider profile was not found.");

  const provider = normalizeClaudeProviderConfig({
    provider: providerName,
    oldProvider: providerName,
    name: providerName,
    baseUrl: storedClaudeProviderValue(stored, "baseUrl", "base_url"),
    authToken: stored.authToken,
    model: stored.model,
    opusModel: storedClaudeProviderValue(stored, "opusModel", "opus_model"),
    sonnetModel: storedClaudeProviderValue(stored, "sonnetModel", "sonnet_model"),
    haikuModel: storedClaudeProviderValue(stored, "haikuModel", "haiku_model"),
  });
  const backupDir = createClaudeBackup("switch-claude-provider", [claudeSettingsPath(), claudeProvidersPath()]);
  applyClaudeProviderToSettings(provider);
  store.activeProvider = provider.name;
  writeClaudeProviderStore(store);
  return { changed: 1, activeProvider: provider.name, backupDir };
}

async function deleteClaudeProvider(providerName) {
  if (!providerName) throw new Error("Provider name is required.");
  if (providerName === "__current__") throw new Error("当前设置是从 settings.json 读取的临时配置，请先保存为 provider 后再删除。");

  const store = readClaudeProviderStore();
  if (!store.providers[providerName]) throw new Error("Claude provider profile was not found.");
  const backupDir = createClaudeBackup("delete-claude-provider", [claudeProvidersPath()]);
  delete store.providers[providerName];
  if (store.activeProvider === providerName) store.activeProvider = "";
  writeClaudeProviderStore(store);
  return { changed: 1, backupDir };
}

function listClaudeSessionFiles() {
  const root = claudeProjectsPath();
  if (!fs.existsSync(root)) return [];
  const files = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "provider-manager-trash") continue;
        walk(filePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(filePath);
      }
    }
  }

  walk(root);
  return files;
}

function readClaudeHistory() {
  const file = claudeHistoryPath();
  const bySession = new Map();
  let count = 0;
  if (!fs.existsSync(file)) return { count, bySession };

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      count += 1;
      if (!entry.sessionId) continue;
      const current = bySession.get(entry.sessionId) || {
        sessionId: entry.sessionId,
        displays: [],
        project: "",
        latestAtMs: 0,
      };
      if (entry.display && !current.displays.includes(entry.display)) current.displays.push(entry.display);
      if (entry.project) current.project = entry.project;
      const timestamp = Number(entry.timestamp || 0);
      if (timestamp > current.latestAtMs) current.latestAtMs = timestamp;
      bySession.set(entry.sessionId, current);
    } catch {
      // Claude history can be user-edited; skip malformed entries.
    }
  }

  return { count, bySession };
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function compactWhitespace(text) {
  return stripAnsi(text).replace(/\s+/g, " ").trim();
}

function stripClaudeCommandMarkup(text) {
  return String(text || "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/gi, "$1")
    .replace(/<command-message>([\s\S]*?)<\/command-message>/gi, "$1")
    .replace(/<command-name>([\s\S]*?)<\/command-name>/gi, "$1")
    .replace(/<command-args>([\s\S]*?)<\/command-args>/gi, "$1")
    .trim();
}

function isClaudeNoiseText(text) {
  const trimmed = String(text || "").trim();
  return !trimmed
    || trimmed.startsWith("<local-command-caveat>")
    || trimmed.startsWith("<command-name>")
    || trimmed.startsWith("<local-command-stdout>")
    || trimmed === "/model"
    || trimmed === "\\model";
}

function claudeContentPartToText(part) {
  if (part === null || part === undefined) return "";
  if (typeof part === "string") return part;
  if (typeof part !== "object") return String(part);
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.name === "string" && part.type) return `[${part.type}] ${part.name}`;
  if (part.type === "image" || part.type === "image_url") return "[image]";
  if (part.type === "document") return `[document] ${part.title || part.name || ""}`.trim();
  if (part.type === "thinking") return "";
  if (part.type === "tool_use") return `[tool_use] ${part.name || ""}`.trim();
  if (part.type === "tool_result") return "[tool_result]";
  if (part.type) return `[${part.type}]`;
  return "[attachment]";
}

function claudeMessageContentToText(content) {
  if (Array.isArray(content)) {
    return content.map(claudeContentPartToText).filter(Boolean).join("\n\n").trim();
  }
  return claudeContentPartToText(content).trim();
}

function extractClaudeChatMessage(entry, lineNumber) {
  if (!entry || (entry.type !== "user" && entry.type !== "assistant")) return null;
  const payload = entry.message && typeof entry.message === "object" ? entry.message : {};
  const role = payload.role || entry.type;
  if (role !== "user" && role !== "assistant") return null;

  const rawText = claudeMessageContentToText(payload.content);
  const text = trimClaudeMessageText(stripClaudeCommandMarkup(rawText));
  if (!text || isClaudeNoiseText(rawText)) return null;

  return {
    lineNumber,
    timestamp: entry.timestamp || "",
    role,
    text,
  };
}

function claudeTitleFromText(text) {
  const cleaned = compactWhitespace(stripClaudeCommandMarkup(text));
  if (!cleaned || isClaudeNoiseText(cleaned)) return "";
  if (cleaned.length <= MAX_CLAUDE_TITLE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_CLAUDE_TITLE_CHARS)}...`;
}

async function parseClaudeSessionFile(filePath, historyEntry = null, options = {}) {
  const stats = fs.statSync(filePath);
  const messages = [];
  let parseErrors = 0;
  let rawEntryCount = 0;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let title = "";
  let preview = "";
  let cwd = historyEntry ? historyEntry.project || "" : "";
  let version = "";
  let firstAtMs = 0;
  let latestAtMs = Number(stats.mtimeMs || 0);

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;
    rawEntryCount += 1;

    try {
      const entry = JSON.parse(line);
      if (entry.cwd && !cwd) cwd = entry.cwd;
      if (entry.version && !version) version = entry.version;
      const timestampMs = Date.parse(entry.timestamp || "");
      if (Number.isFinite(timestampMs)) {
        if (!firstAtMs || timestampMs < firstAtMs) firstAtMs = timestampMs;
        if (timestampMs > latestAtMs) latestAtMs = timestampMs;
      }

      const message = extractClaudeChatMessage(entry, lineNumber);
      if (!message) continue;
      if (message.role === "user") userMessageCount += 1;
      if (message.role === "assistant") assistantMessageCount += 1;
      if (!title && message.role === "user") title = claudeTitleFromText(message.text);
      if (!preview) preview = claudeTitleFromText(message.text);
      if (!options.summaryOnly) messages.push(message);
    } catch {
      parseErrors += 1;
    }
  }

  if (!title && historyEntry && historyEntry.displays && historyEntry.displays.length) {
    title = claudeTitleFromText(historyEntry.displays.find((display) => !isClaudeNoiseText(display)) || historyEntry.displays[0]);
  }
  if (!title) title = path.basename(filePath, ".jsonl");
  if (!preview) preview = title;

  return {
    id: path.basename(filePath, ".jsonl"),
    title,
    preview,
    cwd,
    projectKey: path.basename(path.dirname(filePath)),
    projectPath: cwd || (historyEntry && historyEntry.project) || "",
    filePath,
    fileSize: stats.size,
    createdAtMs: firstAtMs || Number(stats.birthtimeMs || stats.ctimeMs || 0),
    updatedAtMs: latestAtMs || Number(stats.mtimeMs || 0),
    version,
    rawEntryCount,
    messageCount: userMessageCount + assistantMessageCount,
    userMessageCount,
    assistantMessageCount,
    parseErrors,
    messages,
  };
}

function buildClaudeProjects(sessions) {
  const projects = new Map();
  for (const session of sessions) {
    const key = session.projectKey || "Unknown";
    const current = projects.get(key) || {
      key,
      path: session.projectPath || session.cwd || "",
      sessionCount: 0,
      messageCount: 0,
      latestUpdatedAtMs: 0,
    };
    current.sessionCount += 1;
    current.messageCount += session.messageCount || 0;
    if (!current.path && (session.projectPath || session.cwd)) current.path = session.projectPath || session.cwd;
    current.latestUpdatedAtMs = Math.max(current.latestUpdatedAtMs, session.updatedAtMs || 0);
    projects.set(key, current);
  }

  return Array.from(projects.values()).sort((a, b) => b.latestUpdatedAtMs - a.latestUpdatedAtMs);
}

async function readClaudeState() {
  const home = getClaudeHome();
  const settings = readJsonFile(claudeSettingsPath());
  const config = readJsonFile(claudeConfigPath());
  const providerState = buildClaudeProviderState(settings || {});
  const history = readClaudeHistory();
  const files = listClaudeSessionFiles();
  const sessions = [];

  for (const filePath of files) {
    const id = path.basename(filePath, ".jsonl");
    sessions.push(await parseClaudeSessionFile(filePath, history.bySession.get(id), { summaryOnly: true }));
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    claudeHome: home,
    settingsPath: claudeSettingsPath(),
    configPath: claudeConfigPath(),
    historyPath: claudeHistoryPath(),
    projectsPath: claudeProjectsPath(),
    hasHome: fs.existsSync(home),
    hasSettings: fs.existsSync(claudeSettingsPath()),
    hasConfig: fs.existsSync(claudeConfigPath()),
    settings: maskSecrets(settings || {}),
    config: maskSecrets(config || {}),
    model: settings && settings.model ? settings.model : "",
    effortLevel: settings && settings.effortLevel ? settings.effortLevel : "",
    env: maskSecrets(settings && settings.env ? settings.env : {}),
    activeProvider: providerState.activeProvider,
    providers: providerState.providers,
    historyCount: history.count,
    projects: buildClaudeProjects(sessions),
    sessions,
    generatedAt: new Date().toISOString(),
  };
}

async function readClaudeSession(sessionId) {
  if (!sessionId) throw new Error("Claude session id is required.");
  const history = readClaudeHistory();
  const filePath = listClaudeSessionFiles().find((candidate) => path.basename(candidate, ".jsonl") === sessionId);
  if (!filePath) throw new Error("Claude session was not found.");
  return parseClaudeSessionFile(filePath, history.bySession.get(sessionId), { summaryOnly: false });
}

function safeRelativeFromClaudeHome(filePath) {
  const home = path.resolve(getClaudeHome());
  const absolute = path.resolve(filePath);
  const relative = path.relative(home, absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  const hash = crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 12);
  return path.join("external", `${hash}-${path.basename(filePath)}`);
}

function moveClaudeSessionToTrash(filePath, trashRoot) {
  const destination = path.join(trashRoot, safeRelativeFromClaudeHome(filePath));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(filePath, destination);
  } catch {
    fs.copyFileSync(filePath, destination);
    fs.unlinkSync(filePath);
  }
  return destination;
}

async function deleteClaudeSessions(ids) {
  const cleanIds = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  if (!cleanIds.length) throw new Error("No Claude session IDs were provided.");

  const byId = new Map(listClaudeSessionFiles().map((filePath) => [path.basename(filePath, ".jsonl"), filePath]));
  const missing = cleanIds.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Claude session was not found: ${missing[0]}`);

  const trashRoot = path.join(getClaudeHome(), "provider-manager-trash", timestampForPath());
  const trashPaths = [];
  for (const id of cleanIds) {
    trashPaths.push(moveClaudeSessionToTrash(byId.get(id), trashRoot));
  }

  return { changed: cleanIds.length, trashDir: trashRoot, trashPaths };
}

function collectPathStats(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return { files: 0, directories: 0, bytes: 0 };
  }

  const stats = fs.lstatSync(targetPath);
  if (!stats.isDirectory()) {
    return { files: 1, directories: 0, bytes: Number(stats.size || 0) };
  }

  const total = { files: 0, directories: 1, bytes: 0 };
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const child = collectPathStats(path.join(targetPath, entry.name));
    total.files += child.files;
    total.directories += child.directories;
    total.bytes += child.bytes;
  }
  return total;
}

function providerManagerBackupRoots() {
  const roots = [
    path.join(getCodexHome(), "provider-manager-backups"),
    path.join(getClaudeHome(), "provider-manager-backups"),
  ];
  const seen = new Set();
  return roots.filter((root) => {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanupProviderManagerBackups() {
  const deleted = [];
  for (const root of providerManagerBackupRoots()) {
    if (!fs.existsSync(root)) continue;
    const stats = collectPathStats(root);
    fs.rmSync(root, { recursive: true, force: true });
    deleted.push({ root, ...stats });
  }

  return {
    changed: deleted.length,
    deletedRoots: deleted.length,
    deletedFiles: deleted.reduce((sum, item) => sum + item.files, 0),
    deletedDirectories: deleted.reduce((sum, item) => sum + item.directories, 0),
    deletedBytes: deleted.reduce((sum, item) => sum + item.bytes, 0),
    roots: deleted.map((item) => item.root),
  };
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function embeddedAssetName(requested) {
  return `public${requested.replace(/\\/g, "/")}`;
}

function getEmbeddedAsset(requested) {
  if (!isSeaExecutable()) return null;
  try {
    const contentType = contentTypeFor(requested);
    if (/^text\/|javascript|json|svg/.test(contentType)) {
      return sea.getAsset(embeddedAssetName(requested), "utf8");
    }
    return Buffer.from(sea.getRawAsset(embeddedAssetName(requested)));
  } catch {
    return null;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : {});
    });
    req.on("error", reject);
  });
}

async function routeApi(req, res, url) {
  const pathname = url.pathname;
  try {
    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, { ok: true, data: await readState() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/claude/state") {
      sendJson(res, 200, { ok: true, data: await readClaudeState() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/thread") {
      const id = url.searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { ok: false, error: "Thread id is required." });
        return;
      }
      sendJson(res, 200, { ok: true, data: await readConversation(id) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/claude/session") {
      const id = url.searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { ok: false, error: "Claude session id is required." });
        return;
      }
      sendJson(res, 200, { ok: true, data: await readClaudeSession(id) });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method not allowed." });
      return;
    }

    const body = await readBody(req);
    let result;
    if (pathname === "/api/heartbeat") {
      sawHeartbeat = true;
      lastHeartbeatAt = Date.now();
      result = { alive: true };
    } else if (pathname === "/api/thread/move") {
      result = await moveThreads(body.ids || [], body.provider);
    } else if (pathname === "/api/thread/delete") {
      result = await deleteThreads(body.ids || []);
    } else if (pathname === "/api/thread/sync") {
      result = await syncThreads(body.ids || [], body.providers || []);
    } else if (pathname === "/api/sync-all") {
      result = await syncAllThreads();
    } else if (pathname === "/api/cleanup-backups") {
      result = cleanupProviderManagerBackups();
    } else if (pathname === "/api/repair-visibility") {
      result = await repairGlobalStateVisibility();
    } else if (pathname === "/api/provider/save") {
      result = await saveProviderConfig(body);
    } else if (pathname === "/api/provider/switch") {
      result = await switchProvider(body);
    } else if (pathname === "/api/provider/delete") {
      result = await deleteProvider(body.provider, Boolean(body.deleteConversations));
    } else if (pathname === "/api/claude/provider/save") {
      result = await saveClaudeProviderConfig(body);
    } else if (pathname === "/api/claude/provider/switch") {
      result = await switchClaudeProvider(body);
    } else if (pathname === "/api/claude/provider/delete") {
      result = await deleteClaudeProvider(body.provider);
    } else if (pathname === "/api/claude/session/delete") {
      result = await deleteClaudeSessions(body.ids || []);
    } else {
      sendJson(res, 404, { ok: false, error: "Unknown API route." });
      return;
    }

    sendJson(res, 200, { ok: true, data: result });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
}

function serveStatic(req, res, pathname) {
  const publicDir = path.join(__dirname, "public");
  const requested = pathname === "/" ? "/index.html" : pathname;
  const embedded = getEmbeddedAsset(requested);
  if (embedded !== null) {
    res.writeHead(200, { "Content-Type": contentTypeFor(requested) });
    res.end(embedded);
    return;
  }

  const filePath = path.resolve(publicDir, `.${decodeURIComponent(requested)}`);
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${DEFAULT_PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  });
}

function findEdgeExecutable() {
  if (process.platform !== "win32") return null;
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function openDefaultBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore" });
    return;
  }
  spawn("xdg-open", [url], { stdio: "ignore" });
}

function openDesktopWindow(url, server) {
  if (process.env.CPM_NO_AUTO_OPEN === "1") return;

  const edge = findEdgeExecutable();
  if (!edge) {
    openDefaultBrowser(url);
    return;
  }

  const profileDir = path.join(os.tmpdir(), `provider-manager-${process.pid}`);
  fs.mkdirSync(profileDir, { recursive: true });
  spawn(edge, [
    `--app=${url}`,
    "--window-size=1280,860",
    "--no-first-run",
    `--user-data-dir=${profileDir}`,
  ], {
    windowsHide: true,
    stdio: "ignore",
  });
}

function startDesktopShutdownMonitor(server) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const noInitialHeartbeat = !sawHeartbeat && now - startedAt > 120000;
    const heartbeatExpired = sawHeartbeat && now - lastHeartbeatAt > 20000;
    if (!noInitialHeartbeat && !heartbeatExpired) return;

    clearInterval(timer);
    server.close(() => process.exit(0));
  }, 5000);
}

function startAuthMonitor() {
  if (authWatcherTimer) return;
  setAuthWatcherBaselineFromFile();
  authWatcherTimer = setInterval(() => {
    try {
      persistObservedAuthIfNeeded();
    } catch {
      // Keep the monitor best-effort; malformed files should not stop the server.
    }
  }, 2000);
}

function startServer() {
  const shouldOpenWindow = isSeaExecutable() || process.env.CPM_DESKTOP === "1";

  function listen(port) {
    const server = createServer();
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE" && port < DEFAULT_PORT + 50) {
        listen(port + 1);
        return;
      }
      console.error(error);
      process.exit(1);
    });

    server.listen(port, HOST, () => {
      const url = `http://${HOST}:${port}`;
      console.log(`ProviderManager running at ${url}`);
      console.log(`CODEX_HOME=${getCodexHome()}`);
      if (shouldOpenWindow) {
        openDesktopWindow(url, server);
        if (process.env.CPM_NO_AUTO_OPEN !== "1") startDesktopShutdownMonitor(server);
      }
      startAuthMonitor();
    });
  }

  listen(DEFAULT_PORT);
}

if (require.main === module || isSeaExecutable()) {
  startServer();
}

module.exports = {
  createServer,
  startServer,
  readState,
  moveThreads,
  deleteThreads,
  syncThreads,
  syncAllThreads,
  readConversation,
  repairGlobalStateVisibility,
  saveProviderConfig,
  switchProvider,
  deleteProvider,
  readClaudeState,
  readClaudeSession,
  saveClaudeProviderConfig,
  switchClaudeProvider,
  deleteClaudeProvider,
  deleteClaudeSessions,
  cleanupProviderManagerBackups,
};
