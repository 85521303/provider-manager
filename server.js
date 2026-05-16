const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const sea = require("node:sea");

const execFileAsync = promisify(execFile);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT || 3767);
const APP_VERSION = 1;
const MAX_FIRST_LINE_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGE_CHARS = 40000;
let embeddedSqlitePath = null;
let lastHeartbeatAt = 0;
let sawHeartbeat = false;

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
    const runtimeDir = path.join(os.tmpdir(), "codex-provider-manager-runtime");
    const sqliteExe = path.join(runtimeDir, "sqlite3.exe");
    writeEmbeddedAsset("vendor/sqlite3.exe", sqliteExe);
    try {
      writeEmbeddedAsset("vendor/sqlite3.dll", path.join(runtimeDir, "sqlite3.dll"));
    } catch {
      // Some sqlite3.exe builds are fully static and do not need a DLL.
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
  const firstLine = newlineIndex >= 0 ? content.slice(0, newlineIndex).replace(/\r$/, "") : content;
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
  if (!fs.existsSync(file)) return { version: APP_VERSION, threads: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: parsed.version || APP_VERSION,
      threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
    };
  } catch {
    return { version: APP_VERSION, threads: {} };
  }
}

function writeManagerState(state) {
  const file = managerStatePath();
  fs.writeFileSync(file, `${JSON.stringify({ version: APP_VERSION, threads: state.threads || {} }, null, 2)}\n`, "utf8");
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
  return [
    providerSectionHeader(provider.name),
    `name = ${tomlString(provider.displayName)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
    `env_key = ${tomlString(provider.envKey)}`,
  ];
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

function buildProviders(threads, config) {
  const providers = new Map();

  for (const provider of config.providers.values()) {
    providers.set(provider.name, {
      name: provider.name,
      displayName: provider.displayName || provider.name,
      baseUrl: provider.baseUrl || "",
      envKey: provider.envKey || "",
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

async function syncThreads(ids, targetProviders) {
  const targets = Array.from(new Set((targetProviders || []).map(String).filter(Boolean)));
  if (!targets.length) throw new Error("At least one target provider is required.");

  const allRows = await getAllThreadRows();
  const selected = allRows.filter((row) => ids.includes(row.id));
  if (!selected.length) throw new Error("No matching conversations were found.");

  const managerState = readManagerState();
  const backupDir = await createBackup("sync", {
    rolloutPaths: selected.map((thread) => thread.rollout_path),
    includeSessionIndex: true,
    includeManagerState: true,
    includeGlobalState: true,
  });
  const globalState = readGlobalState();

  const existing = new Set();
  for (const row of allRows) {
    existing.add(`${syncKeyForThread(row, managerState)}::${row.model_provider}`);
  }

  const created = [];
  const skipped = [];
  for (const row of selected) {
    const syncKey = syncKeyForThread(row, managerState);
    for (const target of targets) {
      if (target === row.model_provider) {
        skipped.push({ sourceId: row.id, targetProvider: target, reason: "same-provider" });
        continue;
      }
      const key = `${syncKey}::${target}`;
      if (existing.has(key)) {
        skipped.push({ sourceId: row.id, targetProvider: target, reason: "already-exists" });
        continue;
      }
      const result = await insertDuplicateThread(row, target, managerState, globalState);
      existing.add(key);
      created.push(result);
    }
  }

  writeManagerState(managerState);
  writeGlobalState(globalState);
  return { changed: created.length, created, skipped, backupDir };
}

async function syncAllThreads() {
  const allRows = await getAllThreadRows();
  const config = readConfig();
  const providers = buildProviders(allRows, config).map((provider) => provider.name);
  if (providers.length < 2) throw new Error("At least two providers are required to sync all conversations.");

  const managerState = readManagerState();
  const backupDir = await createBackup("sync-all", {
    rolloutPaths: allRows.map((thread) => thread.rollout_path),
    includeSessionIndex: true,
    includeManagerState: true,
    includeGlobalState: true,
  });
  const globalState = readGlobalState();

  const groups = new Map();
  for (const row of allRows) {
    const syncKey = syncKeyForThread(row, managerState);
    if (!groups.has(syncKey)) groups.set(syncKey, []);
    groups.get(syncKey).push(row);
  }

  const created = [];
  const skipped = [];
  for (const [syncKey, group] of groups.entries()) {
    const byProvider = new Map(group.map((row) => [row.model_provider, row]));
    const preferredSource = group.find((row) => !managerState.threads[row.id]) || group[0];

    for (const provider of providers) {
      if (byProvider.has(provider)) {
        skipped.push({ syncKey, targetProvider: provider, reason: "already-exists" });
        continue;
      }

      const result = await insertDuplicateThread(preferredSource, provider, managerState, globalState);
      byProvider.set(provider, { ...preferredSource, id: result.newId, model_provider: provider });
      created.push(result);
    }
  }

  writeManagerState(managerState);
  writeGlobalState(globalState);
  return { changed: created.length, created, skipped, backupDir };
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
    includeManagerState: isRename,
  });

  const configChanged = updateProviderInConfig(provider, {
    oldProvider,
    activeProvider: currentConfig.activeProvider === oldProvider ? provider.name : undefined,
  });
  const renamed = await renameProviderInThreads(oldProvider, provider.name, rows);

  return {
    changed: Number(configChanged) + renamed.changed + Number(renamed.managerStateChanged),
    configChanged,
    renamedThreads: renamed.changed,
    managerStateChanged: renamed.managerStateChanged,
    provider: provider.name,
    backupDir,
  };
}

async function switchProvider(rawConfig) {
  const input = rawConfig || {};
  const providerName = String(input.provider || "").trim();
  if (!providerName) throw new Error("Provider name is required.");

  const config = readConfig();
  const existing = config.providers.get(providerName);
  const provider = normalizeProviderConfig({
    provider: providerName,
    oldProvider: providerName,
    name: input.name ?? input.displayName ?? (existing ? existing.displayName : providerName),
    baseUrl: input.baseUrl ?? input.base_url ?? (existing ? existing.baseUrl : ""),
    envKey: input.envKey ?? input.env_key ?? (existing ? existing.envKey : ""),
  });

  const backupDir = await createBackup("switch-provider", { includeConfig: true });
  const configChanged = updateProviderInConfig(provider, { activeProvider: provider.name });
  return {
    changed: Number(configChanged),
    configChanged,
    activeProvider: provider.name,
    backupDir,
  };
}

async function deleteProvider(providerName, deleteConversations) {
  if (!providerName) throw new Error("Provider name is required.");
  const allRows = await getAllThreadRows();
  const matchingThreads = allRows.filter((row) => row.model_provider === providerName);
  const config = readConfig();
  const remainingConfigured = Array.from(config.providers.keys()).filter((name) => name !== providerName);
  const replacement = config.activeProvider === providerName ? remainingConfigured[0] || null : config.activeProvider;

  const backupDir = await createBackup("delete-provider", {
    rolloutPaths: deleteConversations ? matchingThreads.map((thread) => thread.rollout_path) : [],
    includeConfig: true,
    includeSessionIndex: true,
    includeManagerState: true,
    includeGlobalState: true,
  });

  const configChanged = removeProviderFromConfig(providerName, replacement);
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

  return { changed: Number(configChanged) + deletedThreads, configChanged, deletedThreads, backupDir, trashPaths };
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function embeddedAssetName(requested) {
  return `public${requested.replace(/\\/g, "/")}`;
}

function getEmbeddedAsset(requested) {
  if (!isSeaExecutable()) return null;
  try {
    return sea.getAsset(embeddedAssetName(requested), "utf8");
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

    if (req.method === "GET" && pathname === "/api/thread") {
      const id = url.searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { ok: false, error: "Thread id is required." });
        return;
      }
      sendJson(res, 200, { ok: true, data: await readConversation(id) });
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
    } else if (pathname === "/api/repair-visibility") {
      result = await repairGlobalStateVisibility();
    } else if (pathname === "/api/provider/save") {
      result = await saveProviderConfig(body);
    } else if (pathname === "/api/provider/switch") {
      result = await switchProvider(body);
    } else if (pathname === "/api/provider/delete") {
      result = await deleteProvider(body.provider, Boolean(body.deleteConversations));
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

  const profileDir = path.join(os.tmpdir(), `codex-provider-manager-${process.pid}`);
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
      console.log(`Codex Provider Manager running at ${url}`);
      console.log(`CODEX_HOME=${getCodexHome()}`);
      if (shouldOpenWindow) {
        openDesktopWindow(url, server);
        if (process.env.CPM_NO_AUTO_OPEN !== "1") startDesktopShutdownMonitor(server);
      }
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
};
