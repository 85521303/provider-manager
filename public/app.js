let state = null;
let activeProvider = "__all__";
const selectedIds = new Set();

const elements = {
  codexHome: document.getElementById("codexHome"),
  allCount: document.getElementById("allCount"),
  providerList: document.getElementById("providerList"),
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
  providerConfigDialog: document.getElementById("providerConfigDialog"),
  providerConfigForm: document.getElementById("providerConfigForm"),
  providerConfigTitle: document.getElementById("providerConfigTitle"),
  providerConfigText: document.getElementById("providerConfigText"),
  providerConfigOriginal: document.getElementById("providerConfigOriginal"),
  providerConfigKey: document.getElementById("providerConfigKey"),
  providerConfigName: document.getElementById("providerConfigName"),
  providerConfigBaseUrl: document.getElementById("providerConfigBaseUrl"),
  providerConfigEnvKey: document.getElementById("providerConfigEnvKey"),
  cancelProviderConfig: document.getElementById("cancelProviderConfig"),
  confirmSaveProvider: document.getElementById("confirmSaveProvider"),
  threadDialog: document.getElementById("threadDialog"),
  threadDialogTitle: document.getElementById("threadDialogTitle"),
  threadDialogMeta: document.getElementById("threadDialogMeta"),
  threadMessages: document.getElementById("threadMessages"),
  closeThreadDialog: document.getElementById("closeThreadDialog"),
};

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

function modelMatches(thread, value) {
  if (!value || value === "__all__") return true;
  if (value === "__empty__") return !thread.model;
  return thread.model === value;
}

function getFilteredThreads() {
  if (!state) return [];
  const query = elements.searchInput.value.trim().toLowerCase();
  const model = elements.modelFilter.value;
  const status = elements.statusFilter.value;
  const startMs = dateStartMs(elements.startDateFilter.value);
  const endMs = dateEndMs(elements.endDateFilter.value);

  return state.threads.filter((thread) => {
    if (activeProvider !== "__all__" && thread.provider !== activeProvider) return false;
    if (!modelMatches(thread, model)) return false;
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

function providerSubtitle(provider) {
  const parts = [];
  parts.push(provider.configured ? "已配置" : "仅存在于对话");
  if (provider.active) parts.push("当前默认");
  if (provider.archivedCount) parts.push(`${provider.archivedCount} 已归档`);
  return parts.join(" · ");
}

function renderProviders() {
  elements.providerList.innerHTML = "";
  elements.allCount.textContent = String(state.threads.length);
  document.querySelector('[data-provider="__all__"]').classList.toggle("active", activeProvider === "__all__");

  for (const provider of state.providers) {
    const item = document.createElement("div");
    item.className = "provider-row";

    const button = document.createElement("button");
    button.className = `provider-item${activeProvider === provider.name ? " active" : ""}`;
    button.dataset.provider = provider.name;
    button.innerHTML = `
      <span>
        ${escapeHtml(provider.displayName || provider.name)}
        <small class="provider-meta">${escapeHtml(providerSubtitle(provider))}</small>
      </span>
      <strong>${provider.threadCount}</strong>
    `;
    button.addEventListener("click", () => {
      activeProvider = provider.name;
      selectedIds.clear();
      render();
    });

    const actions = document.createElement("div");
    actions.className = "provider-row-actions";

    const switchButton = document.createElement("button");
    switchButton.className = "provider-action-btn";
    switchButton.textContent = "切换";
    switchButton.title = "设为 Codex 默认 provider";
    switchButton.addEventListener("click", (event) => {
      event.stopPropagation();
      switchProvider(provider);
    });

    const configButton = document.createElement("button");
    configButton.className = "provider-action-btn";
    configButton.textContent = "配置";
    configButton.title = "配置 provider";
    configButton.disabled = provider.name.toLowerCase() === "openai";
    if (configButton.disabled) configButton.title = "openai provider 不支持配置";
    configButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (configButton.disabled) return;
      openProviderConfigDialog(provider);
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "provider-action-btn danger";
    deleteButton.textContent = "删除";
    deleteButton.title = "删除 provider";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProviderDeleteDialog(provider);
    });

    actions.appendChild(switchButton);
    actions.appendChild(configButton);
    actions.appendChild(deleteButton);
    item.appendChild(button);
    item.appendChild(actions);
    elements.providerList.appendChild(item);
  }
}

function renderSummary() {
  const filtered = getFilteredThreads();
  const totalTokens = filtered.reduce((sum, thread) => sum + Number(thread.tokensUsed || 0), 0);
  const missingRollouts = filtered.filter((thread) => !thread.rolloutExists).length;
  const syncedCopies = filtered.filter((thread) => thread.syncedCopy).length;
  const cards = [
    ["Provider", state.providers.length],
    ["显示对话", filtered.length],
    ["同步副本", syncedCopies],
    ["缺失文件", missingRollouts],
    ["Tokens", totalTokens.toLocaleString("zh-CN")],
  ];
  elements.summaryGrid.innerHTML = cards.map(([label, value]) => `
    <div class="summary-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");
}

function renderTargetOptions() {
  const current = elements.targetProvider.value;
  elements.targetProvider.innerHTML = state.providers
    .map((provider) => `<option value="${escapeHtml(provider.name)}">${escapeHtml(provider.displayName || provider.name)}</option>`)
    .join("");
  if (current && state.providers.some((provider) => provider.name === current)) {
    elements.targetProvider.value = current;
  }
}

function renderModelFilter() {
  const current = elements.modelFilter.value || "__all__";
  const models = Array.from(new Set(state.threads.map((thread) => thread.model || "__empty__"))).sort((a, b) => a.localeCompare(b));
  elements.modelFilter.innerHTML = [
    '<option value="__all__">全部模型</option>',
    ...models.map((model) => {
      const label = model === "__empty__" ? "未记录模型" : model;
      return `<option value="${escapeHtml(model)}">${escapeHtml(label)}</option>`;
    }),
  ].join("");
  if (models.includes(current) || current === "__all__") elements.modelFilter.value = current;
}

function renderThreads() {
  const threads = getFilteredThreads();
  elements.threadRows.innerHTML = "";
  elements.emptyState.hidden = threads.length > 0;
  elements.selectAll.checked = threads.length > 0 && threads.every((thread) => selectedIds.has(thread.id));
  elements.selectAll.indeterminate = threads.some((thread) => selectedIds.has(thread.id)) && !elements.selectAll.checked;

  for (const thread of threads) {
    const row = document.createElement("tr");
    row.className = "thread-row";
    row.tabIndex = 0;
    row.innerHTML = `
      <td class="check-cell"><input type="checkbox" data-id="${escapeHtml(thread.id)}" ${selectedIds.has(thread.id) ? "checked" : ""} /></td>
      <td>
        <div class="thread-title" title="${escapeAttr(thread.title)}">${escapeHtml(thread.title)}</div>
        <div class="thread-sub" title="${escapeAttr(thread.cwd)}">${escapeHtml(thread.cwd || thread.id)}</div>
      </td>
      <td><span class="badge">${escapeHtml(thread.provider)}</span></td>
      <td>
        <div>${escapeHtml(thread.model || "-")}</div>
        <div class="thread-sub">${escapeHtml(thread.reasoningEffort || "")}</div>
      </td>
      <td>${formatDate(thread.updatedAtMs)}</td>
      <td><div class="status-stack">${statusBadges(thread)}</div></td>
      <td class="row-actions-cell"><button class="row-delete-btn" title="删除该对话">删除</button></td>
    `;

    row.addEventListener("click", (event) => {
      if (event.target.closest("button,input,select,a")) return;
      openThreadDialog(thread.id);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") openThreadDialog(thread.id);
    });
    row.querySelector("input[type='checkbox']").addEventListener("change", (event) => {
      if (event.currentTarget.checked) selectedIds.add(thread.id);
      else selectedIds.delete(thread.id);
      renderSelection();
    });
    row.querySelector(".row-delete-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSingleThread(thread);
    });

    elements.threadRows.appendChild(row);
  }
}

function statusBadges(thread) {
  const badges = [];
  if (thread.archived) badges.push('<span class="badge">已归档</span>');
  if (thread.syncedCopy) badges.push('<span class="badge sync">同步副本</span>');
  if (!thread.rolloutExists) badges.push('<span class="badge warning">文件缺失</span>');
  if (thread.sessionProvider && thread.sessionProvider !== thread.provider) {
    badges.push('<span class="badge warning">provider 不一致</span>');
  }
  return badges.length ? badges.join("") : '<span class="badge">正常</span>';
}

function renderSelection() {
  const count = selectedIds.size;
  elements.selectedCount.textContent = count ? `已选择 ${count}` : "未选择";
  elements.moveBtn.disabled = !count;
  elements.syncBtn.disabled = !count;
  elements.deleteBtn.disabled = !count;

  const threads = getFilteredThreads();
  elements.selectAll.checked = threads.length > 0 && threads.every((thread) => selectedIds.has(thread.id));
  elements.selectAll.indeterminate = threads.some((thread) => selectedIds.has(thread.id)) && !elements.selectAll.checked;
}

function render() {
  if (!state) return;
  elements.codexHome.textContent = state.codexHome;
  renderProviders();
  renderTargetOptions();
  renderModelFilter();
  renderThreads();
  renderSummary();
  renderSelection();
}

async function loadState() {
  elements.reloadBtn.disabled = true;
  try {
    state = await api("/api/state");
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
    await loadState();
    const backup = result.backupDir ? ` 备份：${result.backupDir}` : "";
    showToast(`${message}。变更 ${result.changed || 0} 项。${backup}`);
  } catch (error) {
    showToast(error.message);
  }
}

function selectedArray() {
  return Array.from(selectedIds);
}

async function deleteSingleThread(thread) {
  if (!window.confirm(`删除对话「${thread.title}」？rollout 文件会移入 provider-manager-trash。`)) return;
  await runAction(
    () => api("/api/thread/delete", { body: { ids: [thread.id] } }),
    "删除完成"
  );
}

function openProviderDeleteDialog(provider) {
  elements.providerDialogTitle.textContent = `删除 ${provider.name}`;
  elements.providerDialogText.textContent = provider.configured
    ? "默认只从 Codex config.toml 移除该 provider。勾选后会同时删除该 provider 下的对话记录。"
    : "该 provider 没有配置段，只存在于会话记录中。勾选后会删除该 provider 下的对话记录。";
  elements.deleteProviderThreads.checked = !provider.configured;
  elements.providerDialog.dataset.provider = provider.name;
  elements.providerDialog.showModal();
}

function providerHasCompleteConfig(provider) {
  return Boolean(provider.configured && provider.displayName && provider.baseUrl && provider.envKey);
}

function openProviderConfigDialog(provider) {
  elements.providerConfigTitle.textContent = `配置 ${provider.name}`;
  elements.providerConfigText.textContent = "保存后会写入 config.toml；如果修改 Provider 名，会同步更新该 provider 的对话记录。";
  elements.providerConfigOriginal.value = provider.name;
  elements.providerConfigKey.value = provider.name;
  elements.providerConfigName.value = provider.displayName || provider.name;
  elements.providerConfigBaseUrl.value = provider.baseUrl || "";
  elements.providerConfigEnvKey.value = provider.envKey || "";
  elements.providerConfigDialog.showModal();
  elements.providerConfigKey.focus();
  elements.providerConfigKey.select();
}

function providerConfigPayload() {
  return {
    oldProvider: elements.providerConfigOriginal.value.trim(),
    provider: elements.providerConfigKey.value.trim(),
    name: elements.providerConfigName.value.trim(),
    baseUrl: elements.providerConfigBaseUrl.value.trim(),
    envKey: elements.providerConfigEnvKey.value.trim(),
  };
}

async function saveProviderConfig(event) {
  event.preventDefault();
  const body = providerConfigPayload();
  if (!body.provider || !body.name || !body.baseUrl || !body.envKey) {
    showToast("请填写 Provider 名、name、base_url 和 env_key。");
    return;
  }

  elements.confirmSaveProvider.disabled = true;
  try {
    const result = await api("/api/provider/save", { body });
    if (activeProvider === body.oldProvider) activeProvider = body.provider;
    elements.providerConfigDialog.close();
    await loadState();
    const backup = result.backupDir ? ` 备份：${result.backupDir}` : "";
    showToast(`Provider 配置已保存。变更 ${result.changed || 0} 项。${backup}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.confirmSaveProvider.disabled = false;
  }
}

async function switchProvider(provider) {
  if (!providerHasCompleteConfig(provider)) {
    openProviderConfigDialog(provider);
    showToast("请先补全该 provider 的配置。");
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

async function openThreadDialog(threadId) {
  elements.threadDialogTitle.textContent = "对话记录";
  elements.threadDialogMeta.textContent = "正在读取 rollout JSONL...";
  elements.threadMessages.innerHTML = '<div class="empty-state">加载中</div>';
  elements.threadDialog.showModal();

  try {
    const conversation = await api(`/api/thread?id=${encodeURIComponent(threadId)}`);
    elements.threadDialogTitle.textContent = conversation.title;
    elements.threadDialogMeta.textContent = [
      conversation.provider,
      conversation.model || "未记录模型",
      formatDate(conversation.updatedAtMs),
      conversation.cwd,
    ].filter(Boolean).join(" · ");

    if (!conversation.messages.length) {
      elements.threadMessages.innerHTML = '<div class="empty-state">该 rollout 中没有可展示的用户/助手消息</div>';
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
  renderThreads();
  renderSummary();
  renderSelection();
}

function refreshForFilterChange() {
  selectedIds.clear();
  renderThreads();
  renderSummary();
  renderSelection();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, " ");
}

document.querySelector('[data-provider="__all__"]').addEventListener("click", () => {
  activeProvider = "__all__";
  selectedIds.clear();
  render();
});

elements.reloadBtn.addEventListener("click", loadState);
elements.searchInput.addEventListener("input", refreshForFilterChange);
elements.modelFilter.addEventListener("change", refreshForFilterChange);
elements.startDateFilter.addEventListener("change", refreshForFilterChange);
elements.endDateFilter.addEventListener("change", refreshForFilterChange);
elements.statusFilter.addEventListener("change", refreshForFilterChange);
elements.clearFiltersBtn.addEventListener("click", clearFilters);
elements.closeThreadDialog.addEventListener("click", () => elements.threadDialog.close());
elements.cancelProviderConfig.addEventListener("click", () => elements.providerConfigDialog.close());
elements.providerConfigForm.addEventListener("submit", saveProviderConfig);

elements.selectAll.addEventListener("change", () => {
  const threads = getFilteredThreads();
  if (elements.selectAll.checked) {
    for (const thread of threads) selectedIds.add(thread.id);
  } else {
    for (const thread of threads) selectedIds.delete(thread.id);
  }
  renderThreads();
  renderSelection();
});

elements.moveBtn.addEventListener("click", () => {
  const provider = elements.targetProvider.value;
  if (!provider || !selectedIds.size) return;
  if (!window.confirm(`把 ${selectedIds.size} 个对话移动到 ${provider}？`)) return;
  runAction(
    () => api("/api/thread/move", { body: { ids: selectedArray(), provider } }),
    "移动完成"
  );
});

elements.syncBtn.addEventListener("click", () => {
  const provider = elements.targetProvider.value;
  if (!provider || !selectedIds.size) return;
  runAction(
    () => api("/api/thread/sync", { body: { ids: selectedArray(), providers: [provider] } }),
    "同步完成"
  );
});

elements.deleteBtn.addEventListener("click", () => {
  if (!selectedIds.size) return;
  if (!window.confirm(`删除 ${selectedIds.size} 个对话？rollout 文件会移入 provider-manager-trash。`)) return;
  runAction(
    () => api("/api/thread/delete", { body: { ids: selectedArray() } }),
    "删除完成"
  );
});

elements.syncAllBtn.addEventListener("click", () => {
  if (!window.confirm("把所有逻辑对话补齐同步到所有 provider？已存在的同步目标会跳过。")) return;
  runAction(() => api("/api/sync-all", { body: {} }), "全量同步完成");
});

elements.confirmDeleteProvider.addEventListener("click", (event) => {
  event.preventDefault();
  const provider = elements.providerDialog.dataset.provider;
  const deleteConversations = elements.deleteProviderThreads.checked;
  const detail = deleteConversations ? "并删除该 provider 下的全部对话" : "仅删除 provider 配置";
  if (!window.confirm(`再次确认：删除 ${provider}，${detail}？`)) return;
  elements.providerDialog.close();
  runAction(
    () => api("/api/provider/delete", { body: { provider, deleteConversations } }),
    "Provider 删除完成"
  );
});

loadState();

function sendHeartbeat() {
  fetch("/api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .catch(() => {});
}

sendHeartbeat();
window.setInterval(sendHeartbeat, 5000);
