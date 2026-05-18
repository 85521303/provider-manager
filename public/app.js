let activeApp = "codex";
let activeScope = "__all__";
let codexState = null;
let claudeState = null;
let sidebarCollapsed = localStorage.getItem("providerManager.sidebarCollapsed") === "1";
const selectedIds = new Set();

const elements = {
  pageShell: document.getElementById("pageShell"),
  homePath: document.getElementById("homePath"),
  modeTabs: Array.from(document.querySelectorAll(".mode-tab")),
  sidebarToggle: document.getElementById("sidebarToggle"),
  scopeTitle: document.getElementById("scopeTitle"),
  scopeMeta: document.getElementById("scopeMeta"),
  allScopeButton: document.getElementById("allScopeButton"),
  allScopeIcon: document.getElementById("allScopeIcon"),
  allScopeLabel: document.getElementById("allScopeLabel"),
  allScopeMeta: document.getElementById("allScopeMeta"),
  allCount: document.getElementById("allCount"),
  providerList: document.getElementById("providerList"),
  addProviderBtn: document.getElementById("addProviderBtn"),
  viewEyebrow: document.getElementById("viewEyebrow"),
  viewTitle: document.getElementById("viewTitle"),
  viewSubtitle: document.getElementById("viewSubtitle"),
  summaryGrid: document.getElementById("summaryGrid"),
  threadRows: document.getElementById("threadRows"),
  emptyState: document.getElementById("emptyState"),
  searchInput: document.getElementById("searchInput"),
  modelFilter: document.getElementById("modelFilter"),
  startDateFilter: document.getElementById("startDateFilter"),
  endDateFilter: document.getElementById("endDateFilter"),
  statusFilter: document.getElementById("statusFilter"),
  clearFiltersBtn: document.getElementById("clearFiltersBtn"),
  selectAll: document.getElementById("selectAll"),
  selectedCount: document.getElementById("selectedCount"),
  targetProvider: document.getElementById("targetProvider"),
  cleanupBackupsBtn: document.getElementById("cleanupBackupsBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  moveBtn: document.getElementById("moveBtn"),
  syncBtn: document.getElementById("syncBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  syncAllBtn: document.getElementById("syncAllBtn"),
  toast: document.getElementById("toast"),
  providerDialog: document.getElementById("providerDialog"),
  providerDialogTitle: document.getElementById("providerDialogTitle"),
  providerDialogText: document.getElementById("providerDialogText"),
  deleteProviderThreads: document.getElementById("deleteProviderThreads"),
  confirmDeleteProvider: document.getElementById("confirmDeleteProvider"),
  codexProviderConfigDialog: document.getElementById("codexProviderConfigDialog"),
  codexProviderConfigForm: document.getElementById("codexProviderConfigForm"),
  codexProviderConfigTitle: document.getElementById("codexProviderConfigTitle"),
  codexProviderConfigText: document.getElementById("codexProviderConfigText"),
  codexProviderConfigOriginal: document.getElementById("codexProviderConfigOriginal"),
  codexProviderConfigKey: document.getElementById("codexProviderConfigKey"),
  codexProviderConfigName: document.getElementById("codexProviderConfigName"),
  codexProviderConfigBaseUrl: document.getElementById("codexProviderConfigBaseUrl"),
  codexProviderConfigEnvKey: document.getElementById("codexProviderConfigEnvKey"),
  cancelCodexProviderConfig: document.getElementById("cancelCodexProviderConfig"),
  confirmSaveCodexProvider: document.getElementById("confirmSaveCodexProvider"),
  claudeProviderConfigDialog: document.getElementById("claudeProviderConfigDialog"),
  claudeProviderConfigForm: document.getElementById("claudeProviderConfigForm"),
  claudeProviderConfigTitle: document.getElementById("claudeProviderConfigTitle"),
  claudeProviderConfigText: document.getElementById("claudeProviderConfigText"),
  claudeProviderConfigOriginal: document.getElementById("claudeProviderConfigOriginal"),
  claudeProviderConfigName: document.getElementById("claudeProviderConfigName"),
  claudeProviderConfigBaseUrl: document.getElementById("claudeProviderConfigBaseUrl"),
  claudeProviderConfigAuthToken: document.getElementById("claudeProviderConfigAuthToken"),
  claudeProviderConfigModel: document.getElementById("claudeProviderConfigModel"),
  claudeProviderConfigOpusModel: document.getElementById("claudeProviderConfigOpusModel"),
  claudeProviderConfigSonnetModel: document.getElementById("claudeProviderConfigSonnetModel"),
  claudeProviderConfigHaikuModel: document.getElementById("claudeProviderConfigHaikuModel"),
  cancelClaudeProviderConfig: document.getElementById("cancelClaudeProviderConfig"),
  confirmSaveClaudeProvider: document.getElementById("confirmSaveClaudeProvider"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmText: document.getElementById("confirmText"),
  cancelConfirm: document.getElementById("cancelConfirm"),
  confirmAction: document.getElementById("confirmAction"),
  threadDialog: document.getElementById("threadDialog"),
  threadDialogTitle: document.getElementById("threadDialogTitle"),
  threadDialogMeta: document.getElementById("threadDialogMeta"),
  threadMessages: document.getElementById("threadMessages"),
  closeThreadDialog: document.getElementById("closeThreadDialog"),
};

function currentState() {
  return activeApp === "codex" ? codexState : claudeState;
}

function formatDate(ms) {
  if (!ms) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function dateStartMs(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function dateEndMs(value) {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 7000);
}

function authActionMessage(result) {
  if (!result || !result.authAction) return "";
  const parts = [];
  if (result.authSaved) parts.push("已保存当前 OpenAI 登录态");
  if (result.authAction === "restored-auth") parts.push("已恢复目标 OpenAI 登录态");
  if (result.authAction === "cleared-auth-awaiting-login") parts.push("已清空 auth.json，等待 Codex 重新登录");
  if (result.authAction === "renamed-auth" || result.authAction === "renamed-current-auth-provider") parts.push("已迁移 OpenAI 登录态");
  if (result.authAction === "deleted-auth") parts.push("已删除该 provider 的登录态");
  return parts.length ? ` ${parts.join("，")}。` : "";
}

function confirmDialog(options) {
  const { title = "确认操作", message, confirmText = "确认", danger = true } = options || {};
  elements.confirmTitle.textContent = title;
  elements.confirmText.textContent = message || "";
  elements.confirmAction.textContent = confirmText;
  elements.confirmAction.className = danger ? "danger-btn" : "primary-btn";
  return new Promise((resolve) => {
    const cleanup = (value) => {
      elements.cancelConfirm.removeEventListener("click", onCancel);
      elements.confirmAction.removeEventListener("click", onConfirm);
      elements.confirmDialog.removeEventListener("cancel", onDialogCancel);
      elements.confirmDialog.removeEventListener("close", onDialogClose);
      if (elements.confirmDialog.open) elements.confirmDialog.close();
      resolve(value);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    const onDialogCancel = (event) => {
      event.preventDefault();
      cleanup(false);
    };
    const onDialogClose = () => cleanup(false);
    elements.cancelConfirm.addEventListener("click", onCancel);
    elements.confirmAction.addEventListener("click", onConfirm);
    elements.confirmDialog.addEventListener("cancel", onDialogCancel);
    elements.confirmDialog.addEventListener("close", onDialogClose);
    elements.confirmDialog.showModal();
    elements.confirmDialog.focus({ preventScroll: true });
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.body ? "POST" : "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "请求失败");
  return payload.data;
}

function threadStatusMatches(thread, status) {
  if (status === "__all__") return true;
  if (status === "archived") return thread.archived;
  if (status === "synced") return thread.syncedCopy;
  if (status === "missing") return !thread.rolloutExists;
  if (status === "mismatch") return Boolean(thread.sessionProvider && thread.sessionProvider !== thread.provider);
  if (status === "normal") {
    return !thread.archived
      && !thread.syncedCopy
      && thread.rolloutExists
      && !(thread.sessionProvider && thread.sessionProvider !== thread.provider);
  }
  return true;
}

function claudeStatusMatches(session, status) {
  if (status === "__all__") return true;
  if (status === "parse-errors") return session.parseErrors > 0;
  if (status === "empty") return !session.messageCount;
  if (status === "normal") return session.messageCount > 0 && !session.parseErrors;
  return true;
}

function modelMatches(record, value, fieldName = "model") {
  if (!value || value === "__all__") return true;
  if (value === "__empty__") return !record[fieldName];
  return record[fieldName] === value;
}

function getFilteredCodexThreads() {
  if (!codexState) return [];
  const query = elements.searchInput.value.trim().toLowerCase();
  const model = elements.modelFilter.value;
  const status = elements.statusFilter.value;
  const startMs = dateStartMs(elements.startDateFilter.value);
  const endMs = dateEndMs(elements.endDateFilter.value);

  return codexState.threads.filter((thread) => {
    if (activeScope !== "__all__" && thread.provider !== activeScope) return false;
    if (!modelMatches(thread, model, "model")) return false;
    if (!threadStatusMatches(thread, status)) return false;
    if (startMs !== null && thread.updatedAtMs < startMs) return false;
    if (endMs !== null && thread.updatedAtMs > endMs) return false;
    if (!query) return true;

    const text = [
      thread.id,
      thread.title,
      thread.preview,
      thread.provider,
      thread.cwd,
      thread.model,
      thread.reasoningEffort,
    ].join(" ").toLowerCase();
    return text.includes(query);
  });
}

function getFilteredClaudeSessions() {
  if (!claudeState) return [];
  const query = elements.searchInput.value.trim().toLowerCase();
  const version = elements.modelFilter.value;
  const status = elements.statusFilter.value;
  const startMs = dateStartMs(elements.startDateFilter.value);
  const endMs = dateEndMs(elements.endDateFilter.value);

  return claudeState.sessions.filter((session) => {
    if (!modelMatches(session, version, "version")) return false;
    if (!claudeStatusMatches(session, status)) return false;
    if (startMs !== null && session.updatedAtMs < startMs) return false;
    if (endMs !== null && session.updatedAtMs > endMs) return false;
    if (!query) return true;

    const text = [
      session.id,
      session.title,
      session.preview,
      session.cwd,
      session.projectKey,
      session.version,
      session.filePath,
    ].join(" ").toLowerCase();
    return text.includes(query);
  });
}

function getFilteredRecords() {
  return activeApp === "codex" ? getFilteredCodexThreads() : getFilteredClaudeSessions();
}

function providerSubtitle(provider) {
  const parts = [];
  parts.push(provider.configured ? "已配置" : "仅存在于对话");
  if (provider.active) parts.push("当前默认");
  if (provider.archivedCount) parts.push(`${provider.archivedCount} 已归档`);
  return parts.join(" · ");
}

function claudeProviderSubtitle(provider) {
  const parts = [];
  if (provider.model) parts.push(provider.model);
  parts.push(provider.hasAuthToken ? "Token 已保存" : "Token 未保存");
  if (provider.virtual) parts.push("来自 settings.json");
  if (provider.active) parts.push("当前使用");
  return parts.join(" · ");
}

function setAllScopeIcon(appName) {
  const isCodex = appName === "codex";
  elements.allScopeIcon.className = `scope-letter scope-logo ${isCodex ? "scope-logo-codex" : "scope-logo-claude"}`;
  elements.allScopeIcon.innerHTML = `<img src="${isCodex ? "/assets/official/openai-mark.svg" : "/assets/official/claude-mark.svg"}" alt="" />`;
}

function renderShell() {
  const state = currentState();
  elements.pageShell.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  elements.sidebarToggle.innerHTML = sidebarCollapsed
    ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5l5 5-5 5" /></svg>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5l-5 5 5 5" /></svg>';
  elements.sidebarToggle.title = sidebarCollapsed ? "展开侧边栏" : "收起侧边栏";
  elements.sidebarToggle.setAttribute("aria-label", elements.sidebarToggle.title);
  elements.modeTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.app === activeApp);
  });

  if (activeApp === "codex") {
    setAllScopeIcon("codex");
    elements.viewEyebrow.textContent = "Codex";
    elements.viewTitle.textContent = "会话管理";
    elements.viewSubtitle.textContent = "管理 Codex provider、默认模型供应商和本地对话记录。";
    elements.homePath.textContent = state ? state.codexHome : "读取 Codex 数据中...";
    elements.searchInput.placeholder = "搜索标题、工作目录、模型或 ID";
    elements.syncAllBtn.hidden = false;
    elements.targetProvider.hidden = false;
    elements.moveBtn.hidden = false;
    elements.syncBtn.hidden = false;
  } else {
    setAllScopeIcon("claude");
    elements.viewEyebrow.textContent = "Claude Code";
    elements.viewTitle.textContent = "会话管理";
    elements.viewSubtitle.textContent = "管理 Claude Code 的 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN，并查看本地 JSONL 会话。";
    elements.homePath.textContent = state ? state.claudeHome : "读取 Claude 数据中...";
    elements.searchInput.placeholder = "搜索会话、项目、工作目录或 ID";
    elements.syncAllBtn.hidden = true;
    elements.targetProvider.hidden = true;
    elements.moveBtn.hidden = true;
    elements.syncBtn.hidden = true;
  }
}

function renderScopes() {
  const state = currentState();
  elements.providerList.innerHTML = "";
  elements.allScopeButton.classList.toggle("active", activeScope === "__all__");

  if (!state) {
    elements.scopeTitle.textContent = "Providers 共0项";
    elements.scopeMeta.hidden = true;
    elements.allCount.textContent = "0";
    return;
  }

  if (activeApp === "codex") {
    elements.scopeTitle.textContent = `Providers 共${state.providers.length}项`;
    elements.scopeMeta.hidden = true;
    elements.allScopeLabel.textContent = "全部对话";
    elements.allScopeMeta.textContent = state.activeProvider ? `默认 ${state.activeProvider}` : "未设置默认 provider";
    elements.allCount.textContent = String(state.threads.length);

    const providers = [...state.providers].sort((a, b) => {
      const aOpenai = isOpenAiAuthProviderName(a.name);
      const bOpenai = isOpenAiAuthProviderName(b.name);
      if (aOpenai !== bOpenai) return aOpenai ? -1 : 1;
      return 0;
    });

    for (const provider of providers) {
      const row = document.createElement("div");
      row.className = "scope-row";

      const button = document.createElement("button");
      button.className = `scope-item${activeScope === provider.name ? " active" : ""}`;
      button.type = "button";
      button.innerHTML = `
        <em class="scope-letter">${escapeHtml(scopeInitial(provider.displayName || provider.name))}</em>
        <span>
          <strong>${escapeHtml(provider.displayName || provider.name)}</strong>
          <small>${escapeHtml(providerSubtitle(provider))}</small>
        </span>
        <b>${provider.threadCount}</b>
      `;
      button.addEventListener("click", () => {
        activeScope = provider.name;
        selectedIds.clear();
        render();
      });

      const actions = document.createElement("div");
      actions.className = "scope-actions";

      const switchButton = document.createElement("button");
      switchButton.className = "scope-action-btn";
      switchButton.type = "button";
      switchButton.textContent = "切换";
      switchButton.title = "设为 Codex 默认 provider";
      switchButton.disabled = Boolean(provider.active);
      if (switchButton.disabled) switchButton.title = "当前 provider 已在使用中";
      switchButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (switchButton.disabled) return;
        switchProvider(provider);
      });

      const configButton = document.createElement("button");
      configButton.className = "scope-action-btn";
      configButton.type = "button";
      configButton.textContent = "配置";
      configButton.title = "配置 provider";
      configButton.disabled = isBuiltInOpenAiProviderName(provider.name);
      if (configButton.disabled) configButton.title = "内置 openai provider 不支持配置";
      configButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (configButton.disabled) return;
        openProviderConfigDialog(provider);
      });

      const deleteButton = document.createElement("button");
      deleteButton.className = "scope-action-btn danger";
      deleteButton.type = "button";
      deleteButton.textContent = "删除";
      deleteButton.title = "删除 provider";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openProviderDeleteDialog(provider);
      });

      actions.appendChild(switchButton);
      actions.appendChild(configButton);
      actions.appendChild(deleteButton);
      row.appendChild(button);
      row.appendChild(actions);
      elements.providerList.appendChild(row);
    }
    return;
  }

  elements.scopeTitle.textContent = `Providers 共${state.providers.length}项`;
  elements.scopeMeta.hidden = true;
  elements.allScopeLabel.textContent = "全部会话";
  elements.allScopeMeta.textContent = state.activeProvider ? `当前 ${state.activeProvider}` : "Claude Code";
  elements.allCount.textContent = String(state.sessions.length);

  for (const provider of state.providers) {
    const row = document.createElement("div");
    row.className = "scope-row";
    const button = document.createElement("button");
    button.className = `scope-item${provider.active ? " active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <em class="scope-letter">${escapeHtml(scopeInitial(provider.displayName || provider.name))}</em>
      <span>
        <strong>${escapeHtml(provider.displayName || provider.name)}</strong>
        <small title="${escapeAttr(provider.baseUrl)}">${escapeHtml(claudeProviderSubtitle(provider))}</small>
      </span>
      <b>${provider.active ? "当前" : "可用"}</b>
    `;
    button.addEventListener("click", () => {
      activeScope = provider.name;
      selectedIds.clear();
      render();
    });

    const actions = document.createElement("div");
    actions.className = "scope-actions";

    const switchButton = document.createElement("button");
    switchButton.className = "scope-action-btn";
    switchButton.type = "button";
    switchButton.textContent = "切换";
    switchButton.title = "设为 Claude Code 当前 provider";
    switchButton.disabled = provider.active;
    switchButton.addEventListener("click", (event) => {
      event.stopPropagation();
      switchProvider(provider);
    });

    const configButton = document.createElement("button");
    configButton.className = "scope-action-btn";
    configButton.type = "button";
    configButton.textContent = "配置";
    configButton.title = "配置 Claude provider";
    configButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProviderConfigDialog(provider);
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "scope-action-btn danger";
    deleteButton.type = "button";
    deleteButton.textContent = "删除";
    deleteButton.title = "删除 Claude provider";
    deleteButton.disabled = provider.virtual;
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProviderDeleteDialog(provider);
    });

    actions.appendChild(switchButton);
    actions.appendChild(configButton);
    actions.appendChild(deleteButton);
    row.appendChild(button);
    row.appendChild(actions);
    elements.providerList.appendChild(row);
  }
}

function renderSummary() {
  const state = currentState();
  if (!state) {
    elements.summaryGrid.innerHTML = "";
    return;
  }

  const filtered = getFilteredRecords();
  let cards;
  if (activeApp === "codex") {
    const totalTokens = filtered.reduce((sum, thread) => sum + Number(thread.tokensUsed || 0), 0);
    const missingRollouts = filtered.filter((thread) => !thread.rolloutExists).length;
    const syncedCopies = filtered.filter((thread) => thread.syncedCopy).length;
    cards = [
      ["Provider", state.providers.length],
      ["显示对话", filtered.length],
      ["同步副本", syncedCopies],
      ["缺失文件", missingRollouts],
      ["Tokens", totalTokens.toLocaleString("zh-CN")],
    ];
  } else {
    const messageCount = filtered.reduce((sum, session) => sum + Number(session.messageCount || 0), 0);
    const parseErrors = filtered.reduce((sum, session) => sum + Number(session.parseErrors || 0), 0);
    const model = state.model || (state.env && state.env.ANTHROPIC_MODEL) || "-";
    cards = [
      ["项目", state.projects.length],
      ["显示会话", filtered.length],
      ["消息", messageCount.toLocaleString("zh-CN")],
      ["解析异常", parseErrors],
      ["模型", model],
    ];
  }

  elements.summaryGrid.innerHTML = cards.map(([label, value]) => `
    <div class="summary-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function renderTargetOptions() {
  if (activeApp !== "codex" || !codexState) {
    elements.targetProvider.innerHTML = "";
    return;
  }
  const current = elements.targetProvider.value;
  elements.targetProvider.innerHTML = codexState.providers
    .map((provider) => `<option value="${escapeAttr(provider.name)}">${escapeHtml(provider.displayName || provider.name)}</option>`)
    .join("");
  if (current && codexState.providers.some((provider) => provider.name === current)) {
    elements.targetProvider.value = current;
  }
}

function renderModelFilter() {
  const state = currentState();
  if (!state) return;
  const current = elements.modelFilter.value || "__all__";

  if (activeApp === "codex") {
    const models = Array.from(new Set(state.threads.map((thread) => thread.model || "__empty__"))).sort((a, b) => a.localeCompare(b));
    elements.modelFilter.innerHTML = [
      '<option value="__all__">全部模型</option>',
      ...models.map((model) => {
        const label = model === "__empty__" ? "未记录模型" : model;
        return `<option value="${escapeAttr(model)}">${escapeHtml(label)}</option>`;
      }),
    ].join("");
    if (models.includes(current) || current === "__all__") elements.modelFilter.value = current;
    return;
  }

  const versions = Array.from(new Set(state.sessions.map((session) => session.version || "__empty__"))).sort((a, b) => a.localeCompare(b));
  elements.modelFilter.innerHTML = [
    '<option value="__all__">全部版本</option>',
    ...versions.map((version) => {
      const label = version === "__empty__" ? "未记录版本" : version;
      return `<option value="${escapeAttr(version)}">${escapeHtml(label)}</option>`;
    }),
  ].join("");
  if (versions.includes(current) || current === "__all__") elements.modelFilter.value = current;
}

function renderStatusFilter() {
  const current = elements.statusFilter.value || "__all__";
  if (activeApp === "codex") {
    elements.statusFilter.innerHTML = `
      <option value="__all__">全部状态</option>
      <option value="normal">正常</option>
      <option value="archived">已归档</option>
      <option value="synced">同步副本</option>
      <option value="missing">文件缺失</option>
      <option value="mismatch">Provider 不一致</option>
    `;
  } else {
    elements.statusFilter.innerHTML = `
      <option value="__all__">全部状态</option>
      <option value="normal">正常</option>
      <option value="parse-errors">解析异常</option>
      <option value="empty">空会话</option>
    `;
  }
  const allowed = Array.from(elements.statusFilter.options).some((option) => option.value === current);
  elements.statusFilter.value = allowed ? current : "__all__";
}

function renderRows() {
  const records = getFilteredRecords();
  elements.threadRows.innerHTML = "";
  elements.emptyState.hidden = records.length > 0;
  elements.emptyState.textContent = activeApp === "codex" ? "没有匹配的对话" : "没有匹配的 Claude 会话";

  for (const record of records) {
    const row = document.createElement("article");
    row.className = "record-card";
    row.tabIndex = 0;
    row.innerHTML = activeApp === "codex" ? codexRowHtml(record) : claudeRowHtml(record);

    row.addEventListener("click", (event) => {
      if (event.target.closest("button,input,select,a")) return;
      openRecordDialog(record.id, activeApp);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") openRecordDialog(record.id, activeApp);
    });
    row.querySelector("input[type='checkbox']").addEventListener("change", (event) => {
      if (event.currentTarget.checked) selectedIds.add(record.id);
      else selectedIds.delete(record.id);
      renderSelection();
    });
    row.querySelector(".row-delete-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSingleRecord(record, activeApp);
    });

    elements.threadRows.appendChild(row);
  }
}

function codexRowHtml(thread) {
  const cwd = displayPath(thread.cwd);
  return `
    <div class="record-select">
      <input type="checkbox" data-id="${escapeAttr(thread.id)}" ${selectedIds.has(thread.id) ? "checked" : ""} />
    </div>
    <div class="record-main">
      <div class="record-title-row">
        <h3 title="${escapeAttr(thread.title)}">${escapeHtml(thread.title)}</h3>
        <time>${formatDate(thread.updatedAtMs)}</time>
      </div>
      <p class="record-path" title="${escapeAttr(cwd)}">${escapeHtml(cwd || thread.id)}</p>
      <div class="record-info-line">
        <div class="status-stack">${codexStatusBadges(thread)}</div>
        <div class="record-meta">
          <span class="badge">${escapeHtml(thread.provider)}</span>
          <span class="meta-pill">${escapeHtml(thread.model || "未记录模型")}</span>
          ${thread.reasoningEffort ? `<span class="meta-pill">${escapeHtml(thread.reasoningEffort)}</span>` : ""}
        </div>
      </div>
    </div>
    <div class="record-actions">
      <button class="row-delete-btn" type="button" title="删除该对话">删除</button>
    </div>
  `;
}

function claudeRowHtml(session) {
  const cwd = displayPath(session.cwd || session.filePath);
  return `
    <div class="record-select">
      <input type="checkbox" data-id="${escapeAttr(session.id)}" ${selectedIds.has(session.id) ? "checked" : ""} />
    </div>
    <div class="record-main">
      <div class="record-title-row">
        <h3 title="${escapeAttr(session.title)}">${escapeHtml(session.title)}</h3>
        <time>${formatDate(session.updatedAtMs)}</time>
      </div>
      <p class="record-path" title="${escapeAttr(cwd)}">${escapeHtml(displayPath(session.cwd) || session.id)}</p>
      <div class="record-info-line">
        <div class="status-stack">${claudeStatusBadges(session)}</div>
        <div class="record-meta">
          <span class="meta-pill">${Number(session.messageCount || 0).toLocaleString("zh-CN")} 消息</span>
          <span class="meta-pill">${escapeHtml(formatBytes(session.fileSize))}</span>
          ${session.version ? `<span class="meta-pill">${escapeHtml(session.version)}</span>` : ""}
        </div>
      </div>
    </div>
    <div class="record-actions">
      <button class="row-delete-btn" type="button" title="删除该会话">删除</button>
    </div>
  `;
}

function codexStatusBadges(thread) {
  const badges = [];
  if (thread.archived) badges.push('<span class="badge">已归档</span>');
  if (thread.syncedCopy) badges.push('<span class="badge sync">同步副本</span>');
  if (!thread.rolloutExists) badges.push('<span class="badge warning">文件缺失</span>');
  if (thread.sessionProvider && thread.sessionProvider !== thread.provider) {
    badges.push('<span class="badge warning">provider 不一致</span>');
  }
  return badges.length ? badges.join("") : '<span class="badge ok">正常</span>';
}

function claudeStatusBadges(session) {
  const badges = [];
  if (!session.messageCount) badges.push('<span class="badge warning">空会话</span>');
  if (session.parseErrors) badges.push(`<span class="badge warning">${session.parseErrors} 解析异常</span>`);
  return badges.length ? badges.join("") : '<span class="badge ok">正常</span>';
}

function renderSelection() {
  const count = selectedIds.size;
  elements.selectedCount.textContent = count ? `已选择 ${count}` : "未选择";
  elements.moveBtn.disabled = activeApp !== "codex" || !count;
  elements.syncBtn.disabled = activeApp !== "codex" || !count;
  elements.deleteBtn.disabled = !count;

  const records = getFilteredRecords();
  const selectAll = elements.selectAll;
  if (selectAll) {
    selectAll.checked = records.length > 0 && records.every((record) => selectedIds.has(record.id));
    selectAll.indeterminate = records.some((record) => selectedIds.has(record.id)) && !selectAll.checked;
  }
}

function render() {
  renderShell();
  renderStatusFilter();
  renderScopes();
  renderTargetOptions();
  renderModelFilter();
  renderRows();
  renderSummary();
  renderSelection();
}

async function loadActiveState() {
  elements.reloadBtn.disabled = true;
  try {
    if (activeApp === "codex") {
      codexState = await api("/api/state");
    } else {
      claudeState = await api("/api/claude/state");
    }
    selectedIds.clear();
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.reloadBtn.disabled = false;
  }
}

async function runAction(action, message) {
  try {
    const result = await action();
    await loadActiveState();
    const backup = result.backupDir ? ` 备份：${result.backupDir}` : "";
    const trash = result.trashDir ? ` 回收区：${result.trashDir}` : "";
    const auth = authActionMessage(result);
    showToast(`${message}。变更 ${result.changed || 0} 项。${auth}${backup}${trash}`);
  } catch (error) {
    showToast(error.message);
  }
}

function selectedArray() {
  return Array.from(selectedIds);
}

async function deleteSingleRecord(record, appName) {
  if (appName === "codex") {
    const confirmed = await confirmDialog({
      title: "删除对话",
      message: `删除对话「${record.title}」？rollout 文件会移入 provider-manager-trash。`,
      confirmText: "删除",
    });
    if (!confirmed) return;
    await runAction(
      () => api("/api/thread/delete", { body: { ids: [record.id] } }),
      "删除完成"
    );
    return;
  }

  const confirmed = await confirmDialog({
    title: "删除 Claude 会话",
    message: `删除 Claude 会话「${record.title}」？JSONL 文件会移入 provider-manager-trash。`,
    confirmText: "删除",
  });
  if (!confirmed) return;
  await runAction(
    () => api("/api/claude/session/delete", { body: { ids: [record.id] } }),
    "Claude 会话删除完成"
  );
}

async function cleanupBackups() {
  const confirmed = await confirmDialog({
    title: "清理缓存",
    message: "删除 Codex 和 Claude Code 的 provider-manager-backups 备份文件？不会删除 provider 配置、登录态或会话记录。",
    confirmText: "清理",
  });
  if (!confirmed) return;

  elements.cleanupBackupsBtn.disabled = true;
  try {
    const result = await api("/api/cleanup-backups", { body: {} });
    const roots = result.deletedRoots || 0;
    const files = result.deletedFiles || 0;
    const bytes = formatBytes(result.deletedBytes || 0);
    showToast(`缓存已清理。删除 ${roots} 个备份目录，${files} 个文件，释放 ${bytes}。`);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.cleanupBackupsBtn.disabled = false;
  }
}

function openProviderDeleteDialog(provider) {
  if (activeApp === "claude") {
    elements.providerDialogTitle.textContent = `删除 ${provider.name}`;
    elements.providerDialogText.textContent = provider.virtual
      ? "当前设置来自 Claude settings.json，请先保存为 provider 后再删除。"
      : "删除后只会移除 ProviderManager 保存的 Claude provider profile，不会删除 Claude 会话。";
    elements.deleteProviderThreads.checked = false;
    elements.deleteProviderThreads.closest(".check-line").hidden = true;
    elements.confirmDeleteProvider.disabled = Boolean(provider.virtual);
    elements.providerDialog.dataset.provider = provider.name;
    elements.providerDialog.showModal();
    return;
  }

  elements.providerDialogTitle.textContent = `删除 ${provider.name}`;
  elements.providerDialogText.textContent = provider.configured
    ? "默认只从 Codex config.toml 移除该 provider。勾选后会同时删除该 provider 下的对话记录。"
    : "该 provider 没有配置段，只存在于会话记录中。勾选后会删除该 provider 下的对话记录。";
  elements.deleteProviderThreads.closest(".check-line").hidden = false;
  elements.confirmDeleteProvider.disabled = false;
  elements.deleteProviderThreads.checked = !provider.configured;
  elements.providerDialog.dataset.provider = provider.name;
  elements.providerDialog.showModal();
}

function providerHasCompleteConfig(provider) {
  if (activeApp === "claude") {
    return Boolean(provider.baseUrl
      && provider.hasAuthToken
      && provider.model
      && provider.opusModel
      && provider.sonnetModel
      && provider.haikuModel
      && !provider.virtual);
  }
  if (isOpenAiAuthProviderName(provider.name)) return true;
  return Boolean(provider.configured && provider.displayName && provider.baseUrl && provider.envKey);
}

function isOpenAiAuthProviderName(providerName) {
  const name = String(providerName || "").trim().toLowerCase();
  return name === "openai";
}

function isBuiltInOpenAiProviderName(providerName) {
  return String(providerName || "").trim().toLowerCase() === "openai";
}

function blankCodexProvider() {
  return { name: "", displayName: "", baseUrl: "", envKey: "", configured: false };
}

function blankClaudeProvider() {
  return {
    name: "",
    displayName: "",
    baseUrl: "",
    hasAuthToken: false,
    model: "",
    opusModel: "",
    sonnetModel: "",
    haikuModel: "",
    virtual: false,
  };
}

function openCodexProviderConfigDialog(provider = blankCodexProvider()) {
  const isNew = !provider.name;
  elements.codexProviderConfigTitle.textContent = isNew ? "添加 Codex Provider" : `配置 ${provider.name}`;
  elements.codexProviderConfigText.textContent = "保存后会写入 config.toml；如果修改 Provider 名，会同步更新该 provider 的对话记录。";
  elements.codexProviderConfigOriginal.value = provider.name || "";
  elements.codexProviderConfigKey.value = provider.name || "";
  elements.codexProviderConfigName.value = provider.displayName || provider.name || "";
  elements.codexProviderConfigBaseUrl.value = provider.baseUrl || "";
  elements.codexProviderConfigEnvKey.value = provider.envKey || "";
  elements.codexProviderConfigDialog.showModal();
  elements.codexProviderConfigDialog.focus({ preventScroll: true });
}

function openClaudeProviderConfigDialog(provider = blankClaudeProvider()) {
  const isNew = !provider.name || provider.virtual;
  elements.claudeProviderConfigTitle.textContent = isNew ? "添加 Claude Provider" : `配置 ${provider.name}`;
  elements.claudeProviderConfigText.textContent = "保存后会写入 Claude provider profile，并同步更新 Claude Code settings.json。";
  elements.claudeProviderConfigOriginal.value = provider.virtual ? "" : provider.name || "";
  elements.claudeProviderConfigName.value = provider.virtual ? "" : provider.name || "";
  elements.claudeProviderConfigBaseUrl.value = provider.baseUrl || "";
  elements.claudeProviderConfigAuthToken.value = provider.hasAuthToken ? "********" : "";
  elements.claudeProviderConfigAuthToken.placeholder = provider.hasAuthToken ? "留空则保留已保存 token" : "";
  elements.claudeProviderConfigAuthToken.required = !provider.hasAuthToken;
  elements.claudeProviderConfigAuthToken.dataset.preserve = provider.hasAuthToken ? "1" : "";
  elements.claudeProviderConfigModel.value = provider.model || "";
  elements.claudeProviderConfigOpusModel.value = provider.opusModel || "";
  elements.claudeProviderConfigSonnetModel.value = provider.sonnetModel || "";
  elements.claudeProviderConfigHaikuModel.value = provider.haikuModel || "";
  elements.claudeProviderConfigDialog.showModal();
  elements.claudeProviderConfigDialog.focus({ preventScroll: true });
}

function openProviderConfigDialog(provider) {
  if (activeApp === "claude") openClaudeProviderConfigDialog(provider);
  else openCodexProviderConfigDialog(provider);
}

function openAddProviderDialog() {
  if (activeApp === "claude") openClaudeProviderConfigDialog();
  else openCodexProviderConfigDialog();
}

function codexProviderConfigPayload() {
  return {
    oldProvider: elements.codexProviderConfigOriginal.value.trim(),
    provider: elements.codexProviderConfigKey.value.trim(),
    name: elements.codexProviderConfigName.value.trim(),
    baseUrl: elements.codexProviderConfigBaseUrl.value.trim(),
    envKey: elements.codexProviderConfigEnvKey.value.trim(),
  };
}

function claudeProviderConfigPayload() {
  const name = elements.claudeProviderConfigName.value.trim();
  const authTokenValue = elements.claudeProviderConfigAuthToken.value.trim();
  const preserveToken = elements.claudeProviderConfigAuthToken.dataset.preserve === "1";
  return {
    oldProvider: elements.claudeProviderConfigOriginal.value.trim(),
    provider: name,
    name,
    displayName: name,
    baseUrl: elements.claudeProviderConfigBaseUrl.value.trim(),
    authToken: preserveToken && authTokenValue === "********" ? "" : authTokenValue,
    model: elements.claudeProviderConfigModel.value.trim(),
    opusModel: elements.claudeProviderConfigOpusModel.value.trim(),
    sonnetModel: elements.claudeProviderConfigSonnetModel.value.trim(),
    haikuModel: elements.claudeProviderConfigHaikuModel.value.trim(),
  };
}

async function saveCodexProviderConfig(event) {
  event.preventDefault();
  const body = codexProviderConfigPayload();
  if (!body.provider || !body.name) {
    showToast("请填写 Provider 名和 name。");
    return;
  }

  if (isBuiltInOpenAiProviderName(body.provider)) {
    showToast("内置 openai provider 不支持配置，只允许存在这一项。");
    return;
  }

  if (!body.baseUrl || !body.envKey) {
    showToast("请填写 Provider 名、name、base_url 和 env_key。");
    return;
  }

  elements.confirmSaveCodexProvider.disabled = true;
  try {
    const result = await api("/api/provider/save", { body });
    if (activeScope === body.oldProvider) activeScope = body.provider;
    elements.codexProviderConfigDialog.close();
    await loadActiveState();
    const backup = result.backupDir ? ` 备份：${result.backupDir}` : "";
    const auth = authActionMessage(result);
    showToast(`Provider 配置已保存。变更 ${result.changed || 0} 项。${auth}${backup}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.confirmSaveCodexProvider.disabled = false;
  }
}

async function saveClaudeProviderConfig(event) {
  event.preventDefault();
  const body = claudeProviderConfigPayload();
  const missing = !body.name || !body.baseUrl || !body.model || !body.opusModel || !body.sonnetModel || !body.haikuModel || (!body.authToken && elements.claudeProviderConfigAuthToken.required);
  if (missing) {
    showToast("请填写 name、base_url、auth_token 和四个 model 字段。已有 token 的 provider 可留空 token。");
    return;
  }

  elements.confirmSaveClaudeProvider.disabled = true;
  try {
    const result = await api("/api/claude/provider/save", { body });
    if (activeScope === body.oldProvider) activeScope = body.provider;
    elements.claudeProviderConfigAuthToken.dataset.preserve = body.authToken ? "1" : "";
    elements.claudeProviderConfigDialog.close();
    await loadActiveState();
    const backup = result.backupDir ? ` 备份：${result.backupDir}` : "";
    showToast(`Claude provider 配置已保存并同步 settings.json。变更 ${result.changed || 0} 项。${backup}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.confirmSaveClaudeProvider.disabled = false;
  }
}

async function switchProvider(provider) {
  if (activeApp === "claude") {
    if (provider.virtual) {
      openProviderConfigDialog(provider);
      showToast("当前设置需要先保存为 Claude provider profile。");
      return;
    }
    if (!providerHasCompleteConfig(provider)) {
      openProviderConfigDialog(provider);
      showToast("请先补全该 Claude provider 的 base_url、auth_token 和 model 配置。");
      return;
    }
    await runAction(
      () => api("/api/claude/provider/switch", { body: { provider: provider.name } }),
      `已切换 Claude provider 到 ${provider.name}`
    );
    return;
  }

  if (!providerHasCompleteConfig(provider)) {
    openProviderConfigDialog(provider);
    showToast("请先补全该 provider 的配置。");
    return;
  }

  if (isOpenAiAuthProviderName(provider.name)) {
    await runAction(
      () => api("/api/provider/switch", { body: { provider: provider.name } }),
      `已切换到 ${provider.name}`
    );
    return;
  }

  await runAction(
    () => api("/api/provider/switch", {
      body: {
        provider: provider.name,
        name: provider.displayName || provider.name,
        baseUrl: provider.baseUrl,
        envKey: provider.envKey,
      },
    }),
    `已切换到 ${provider.name}`
  );
}

async function openRecordDialog(recordId, appName) {
  elements.threadDialogTitle.textContent = "对话记录";
  elements.threadDialogMeta.textContent = appName === "codex" ? "正在读取 rollout JSONL..." : "正在读取 Claude JSONL...";
  elements.threadMessages.innerHTML = '<div class="empty-state">加载中</div>';
  elements.threadDialog.showModal();

  try {
    const conversation = appName === "codex"
      ? await api(`/api/thread?id=${encodeURIComponent(recordId)}`)
      : await api(`/api/claude/session?id=${encodeURIComponent(recordId)}`);

    elements.threadDialogTitle.textContent = conversation.title;
    elements.threadDialogMeta.textContent = appName === "codex"
      ? [
        conversation.provider,
        conversation.model || "未记录模型",
        formatDate(conversation.updatedAtMs),
        displayPath(conversation.cwd),
      ].filter(Boolean).join(" · ")
      : [
        "Claude Code",
        conversation.version || "未记录版本",
        formatDate(conversation.updatedAtMs),
        displayPath(conversation.cwd),
      ].filter(Boolean).join(" · ");

    if (!conversation.messages.length) {
      elements.threadMessages.innerHTML = '<div class="empty-state">该 JSONL 中没有可展示的用户/助手消息</div>';
      return;
    }

    elements.threadMessages.innerHTML = conversation.messages.map((message) => `
      <article class="chat-message ${message.role}">
        <div class="chat-message-meta">${roleLabel(message.role)} · ${escapeHtml(formatDate(Date.parse(message.timestamp)))}</div>
        <pre>${escapeHtml(message.text)}</pre>
      </article>
    `).join("");
  } catch (error) {
    elements.threadDialogMeta.textContent = "";
    elements.threadMessages.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function roleLabel(role) {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return role;
}

function clearFilters() {
  elements.searchInput.value = "";
  elements.modelFilter.value = "__all__";
  elements.startDateFilter.value = "";
  elements.endDateFilter.value = "";
  elements.statusFilter.value = "__all__";
  selectedIds.clear();
  render();
}

function refreshForFilterChange() {
  selectedIds.clear();
  renderRows();
  renderSummary();
  renderSelection();
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem("providerManager.sidebarCollapsed", sidebarCollapsed ? "1" : "0");
  renderShell();
}

function switchApp(appName) {
  if (activeApp === appName) return;
  activeApp = appName;
  activeScope = "__all__";
  selectedIds.clear();
  clearFilters();
  renderShell();
  if (!currentState()) {
    loadActiveState();
  } else {
    render();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scopeInitial(value) {
  const text = String(value || "?").trim();
  if (!text) return "?";
  const compact = text.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, "");
  return (compact || text).slice(0, 2).toUpperCase();
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, " ");
}

function displayPath(value) {
  const text = String(value || "");
  return text.replace(/^\\\\\?\\/, "");
}

elements.modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => switchApp(tab.dataset.app));
});

elements.sidebarToggle.addEventListener("click", toggleSidebar);

elements.allScopeButton.addEventListener("click", () => {
  activeScope = "__all__";
  selectedIds.clear();
  render();
});

elements.reloadBtn.addEventListener("click", loadActiveState);
elements.cleanupBackupsBtn.addEventListener("click", cleanupBackups);
elements.addProviderBtn.addEventListener("click", openAddProviderDialog);
elements.searchInput.addEventListener("input", refreshForFilterChange);
elements.modelFilter.addEventListener("change", refreshForFilterChange);
elements.startDateFilter.addEventListener("change", refreshForFilterChange);
elements.endDateFilter.addEventListener("change", refreshForFilterChange);
elements.statusFilter.addEventListener("change", refreshForFilterChange);
elements.clearFiltersBtn.addEventListener("click", clearFilters);
elements.closeThreadDialog.addEventListener("click", () => elements.threadDialog.close());
elements.cancelCodexProviderConfig.addEventListener("click", () => elements.codexProviderConfigDialog.close());
elements.codexProviderConfigForm.addEventListener("submit", saveCodexProviderConfig);
elements.cancelClaudeProviderConfig.addEventListener("click", () => elements.claudeProviderConfigDialog.close());
elements.claudeProviderConfigForm.addEventListener("submit", saveClaudeProviderConfig);

elements.selectAll.addEventListener("change", () => {
  const records = getFilteredRecords();
  if (elements.selectAll.checked) {
    for (const record of records) selectedIds.add(record.id);
  } else {
    for (const record of records) selectedIds.delete(record.id);
  }
  renderRows();
  renderSelection();
});

elements.moveBtn.addEventListener("click", async () => {
  const provider = elements.targetProvider.value;
  if (activeApp !== "codex" || !provider || !selectedIds.size) return;
  const confirmed = await confirmDialog({
    title: "移动对话",
    message: `把 ${selectedIds.size} 个对话移动到 ${provider}？`,
    confirmText: "移动",
    danger: false,
  });
  if (!confirmed) return;
  runAction(
    () => api("/api/thread/move", { body: { ids: selectedArray(), provider } }),
    "移动完成"
  );
});

elements.syncBtn.addEventListener("click", () => {
  const provider = elements.targetProvider.value;
  if (activeApp !== "codex" || !provider || !selectedIds.size) return;
  runAction(
    () => api("/api/thread/sync", { body: { ids: selectedArray(), providers: [provider] } }),
    "同步完成"
  );
});

elements.deleteBtn.addEventListener("click", async () => {
  if (!selectedIds.size) return;
  if (activeApp === "codex") {
    const confirmed = await confirmDialog({
      title: "删除对话",
      message: `删除 ${selectedIds.size} 个对话？rollout 文件会移入 provider-manager-trash。`,
      confirmText: "删除",
    });
    if (!confirmed) return;
    runAction(
      () => api("/api/thread/delete", { body: { ids: selectedArray() } }),
      "删除完成"
    );
    return;
  }

  const confirmed = await confirmDialog({
    title: "删除 Claude 会话",
    message: `删除 ${selectedIds.size} 个 Claude 会话？JSONL 文件会移入 provider-manager-trash。`,
    confirmText: "删除",
  });
  if (!confirmed) return;
  runAction(
    () => api("/api/claude/session/delete", { body: { ids: selectedArray() } }),
    "Claude 会话删除完成"
  );
});

elements.syncAllBtn.addEventListener("click", async () => {
  if (activeApp !== "codex") return;
  const confirmed = await confirmDialog({
    title: "同步全部",
    message: "把所有逻辑对话同步到所有 provider？较旧的同步副本会被最新内容刷新。",
    confirmText: "同步",
    danger: false,
  });
  if (!confirmed) return;
  runAction(() => api("/api/sync-all", { body: {} }), "全量同步完成");
});

elements.confirmDeleteProvider.addEventListener("click", async (event) => {
  event.preventDefault();
  const provider = elements.providerDialog.dataset.provider;
  if (activeApp === "claude") {
    const confirmed = await confirmDialog({
      title: "删除 Claude Provider",
      message: `再次确认：删除 Claude provider profile ${provider}？`,
      confirmText: "删除",
    });
    if (!confirmed) return;
    elements.providerDialog.close();
    runAction(
      () => api("/api/claude/provider/delete", { body: { provider } }),
      "Claude provider 删除完成"
    );
    return;
  }

  const deleteConversations = elements.deleteProviderThreads.checked;
  const detail = deleteConversations ? "并删除该 provider 下的全部对话" : "仅删除 provider 配置";
  const confirmed = await confirmDialog({
    title: "删除 Provider",
    message: `再次确认：删除 ${provider}，${detail}？`,
    confirmText: "删除",
  });
  if (!confirmed) return;
  elements.providerDialog.close();
  runAction(
    () => api("/api/provider/delete", { body: { provider, deleteConversations } }),
    "Provider 删除完成"
  );
});

render();
loadActiveState();

function sendHeartbeat() {
  fetch("/api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .catch(() => {});
}

sendHeartbeat();
window.setInterval(sendHeartbeat, 5000);
