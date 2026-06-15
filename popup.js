// popup.js

// ── State ──────────────────────────────────────────────────────────────────
let currentProvider = "openai";
let currentThreadId = null;
let currentUrl      = null;
let isStreaming     = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const apiKeyInput      = document.getElementById("apiKey");
const modelInput       = document.getElementById("modelInput");      // ← now an <input list>
const modelList        = document.getElementById("modelList");        // ← datalist
const modelSpinner     = document.getElementById("modelSpinner");
const btnRefreshModels = document.getElementById("btnRefreshModels");
const btnSaveKey       = document.getElementById("btnSaveKey");
const btnAsk           = document.getElementById("btnAsk");
const questionEl       = document.getElementById("question");
const statusBar        = document.getElementById("statusBar");
const cacheInfo        = document.getElementById("cacheInfo");
const cacheTitle       = document.getElementById("cacheTitle");
const cacheMeta        = document.getElementById("cacheMeta");
const btnClearCache    = document.getElementById("btnClearCache");
const answerWrap       = document.getElementById("answerWrap");
const answerBox        = document.getElementById("answerBox");
const configSection    = document.getElementById("configSection");
const btnToggleConfig  = document.getElementById("btnToggleConfig");
const btnExpand        = document.getElementById("btnExpand");
const btnCollapse      = document.getElementById("btnCollapse");

// ── Auto resize question box ──────────────────────────────────────────────

function autoResizeQuestion() {
  questionEl.style.height = "auto";
  questionEl.style.height = questionEl.scrollHeight + "px";
}

questionEl.addEventListener("input", autoResizeQuestion);

// ── Helpers ────────────────────────────────────────────────────────────────

function setStatus(msg, type = "info") {
  statusBar.textContent = msg;
  statusBar.className   = type;
}
function clearStatus() {
  statusBar.className   = "";
  statusBar.textContent = "";
}

function storageKey(provider)      { return `voz_apikey_${provider}`; }
function modelStorageKey(provider) { return `voz_model_${provider}`; }
function savedModelsKey(provider)  { return `voz_models_${provider}`; }

function saveApiKey(provider, key) {
  chrome.storage.local.set({ [storageKey(provider)]: key });
}
function loadApiKey(provider) {
  return new Promise((res) =>
    chrome.storage.local.get(storageKey(provider), (d) => res(d[storageKey(provider)] || ""))
  );
}
function saveModelChoice(provider, model) {
  chrome.storage.local.set({ [modelStorageKey(provider)]: model });
}
function loadModelChoice(provider) {
  return new Promise((res) =>
    chrome.storage.local.get(modelStorageKey(provider), (d) => res(d[modelStorageKey(provider)] || ""))
  );
}
function saveModels(provider, models) {
  chrome.storage.local.set({ [savedModelsKey(provider)]: models });
}
function loadSavedModels(provider) {
  return new Promise((res) =>
    chrome.storage.local.get(savedModelsKey(provider), (d) => res(d[savedModelsKey(provider)] || []))
  );
}

// ── Populate datalist (replaces populateModelSelect) ──────────────────────

function populateModelDatalist(models, selectedModel = "") {
  modelList.innerHTML = "";
  models.forEach((id) => {
    const opt   = document.createElement("option");
    opt.value   = id;
    modelList.appendChild(opt);
  });
  // Set input value to saved choice if it exists in list, else first model
  if (selectedModel && models.includes(selectedModel)) {
    modelInput.value = selectedModel;
  } else if (models.length) {
    modelInput.value = models[0];
  }
}

async function fetchAndPopulateModels(provider, apiKey, forceRefresh = false) {
  if (!apiKey) {
    modelList.innerHTML  = "";
    modelInput.value     = "";
    modelInput.placeholder = "— enter API key first —";
    return;
  }

  if (!forceRefresh) {
    const saved = await loadSavedModels(provider);
    if (saved.length) {
      const chosen = await loadModelChoice(provider);
      populateModelDatalist(saved, chosen);
      return;
    }
  }

  modelSpinner.style.display = "block";
  btnRefreshModels.disabled  = true;
  modelInput.disabled        = true;

  try {
    const resp = await chrome.runtime.sendMessage({ type: "FETCH_MODELS", provider, apiKey });
    if (resp.ok && resp.models.length) {
      saveModels(provider, resp.models);
      const chosen = await loadModelChoice(provider);
      populateModelDatalist(resp.models, chosen);
    } else {
      setStatus("Could not fetch models — using defaults", "warn");
    }
  } catch (e) {
    setStatus("Error fetching models: " + e.message, "error");
  } finally {
    modelSpinner.style.display = "none";
    btnRefreshModels.disabled  = false;
    modelInput.disabled        = false;
  }
}

// ── Persist answer across tab switches ────────────────────────────────────
// Save/restore answer text via chrome.storage.session (cleared on browser restart)

function persistAnswer(threadId, text) {
  if (!threadId) return;
  chrome.storage.session.set({ [`voz_answer_${threadId}`]: text });
}

async function restoreAnswer(threadId) {
  if (!threadId) return;
  return new Promise((res) =>
    chrome.storage.session.get(`voz_answer_${threadId}`, (d) => res(d[`voz_answer_${threadId}`] || ""))
  );
}

function persistQuestion(threadId, text) {
  if (!threadId) return;
  chrome.storage.session.set({ [`voz_question_${threadId}`]: text });
}

async function restoreQuestion(threadId) {
  if (!threadId) return "";
  return new Promise((res) =>
    chrome.storage.session.get(`voz_question_${threadId}`, (d) => res(d[`voz_question_${threadId}`] || ""))
  );
}

// ── Cache UI ───────────────────────────────────────────────────────────────

async function refreshCacheInfo(threadId) {
  if (!threadId) return;
  const resp = await chrome.runtime.sendMessage({ type: "GET_CACHE_INFO", threadId });
  if (resp.ok && resp.cached) {
    cacheInfo.style.display = "block";
    cacheTitle.textContent  = resp.title || "(no title)";
    const d = new Date(resp.crawled_at);
    cacheMeta.textContent   = `${resp.post_count} posts · crawled ${d.toLocaleTimeString()}`;
    questionEl.disabled     = false;
    btnAsk.disabled         = false;
  } else {
    cacheInfo.style.display = "none";
    // Don't disable question/ask — auto-crawl will handle it
  }
}

// ── Provider toggle ────────────────────────────────────────────────────────

document.querySelectorAll(".provider-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".provider-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentProvider = btn.dataset.provider;
    chrome.storage.local.set({ voz_provider: currentProvider });

    const key = await loadApiKey(currentProvider);
    apiKeyInput.value = key;
    await fetchAndPopulateModels(currentProvider, key);
  });
});

// ── Save key ───────────────────────────────────────────────────────────────

btnSaveKey.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setStatus("Please enter an API key.", "warn"); return; }
  saveApiKey(currentProvider, key);
  setStatus("API key saved. Fetching models…", "info");
  await fetchAndPopulateModels(currentProvider, key, true);
  clearStatus();
});

// Save model choice whenever user changes the input
modelInput.addEventListener("change", () => {
  saveModelChoice(currentProvider, modelInput.value.trim());
});

// ── Refresh models ─────────────────────────────────────────────────────────

btnRefreshModels.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setStatus("Enter your API key first.", "warn"); return; }
  await fetchAndPopulateModels(currentProvider, key, true);
});

// ── Expand / collapse size ─────────────────────────────────────────────────

btnExpand.addEventListener("click", () => {
  document.body.classList.add("expanded");
  btnExpand.style.display   = "none";
  btnCollapse.style.display = "inline-block";
  chrome.storage.session.set({ voz_expanded: true });
});

btnCollapse.addEventListener("click", () => {
  document.body.classList.remove("expanded");
  btnCollapse.style.display = "none";
  btnExpand.style.display   = "inline-block";
  chrome.storage.session.set({ voz_expanded: false });
});

// ── Collapse config ────────────────────────────────────────────────────────

btnToggleConfig.addEventListener("click", () => {
  const collapsed = configSection.classList.toggle("collapsed");
  btnToggleConfig.title = collapsed ? "Show settings" : "Hide settings";
  chrome.storage.session.set({ voz_config_collapsed: collapsed });
});

// ── Auto-crawl + Ask ───────────────────────────────────────────────────────

async function ensureCrawled() {
  // Check cache first
  const resp = await chrome.runtime.sendMessage({ type: "GET_CACHE_INFO", threadId: currentThreadId });
  if (resp.ok && resp.cached) return true;

  // Need to crawl
  if (!currentUrl) { setStatus("Not on a VOZ thread page.", "warn"); return false; }
  setStatus("⏳ Crawling page 1…", "info");

  const crawlResp = await chrome.runtime.sendMessage({ type: "CRAWL_THREAD", url: currentUrl });
  if (crawlResp.ok) {
    setStatus(
      `✅ Done — ${crawlResp.data.post_count} posts across ${crawlResp.data.total_pages} pages`,
      "success"
    );
    currentThreadId = crawlResp.data.thread_id;
    await refreshCacheInfo(currentThreadId);
    return true;
  } else {
    setStatus("❌ Crawl failed: " + crawlResp.error, "error");
    return false;
  }
}

// ── Streaming answer ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CRAWL_PROGRESS") {
    setStatus(`⏳ Crawling page ${msg.page} / ${msg.total}…`, "info");
    return;
  }

  if (msg.type === "LLM_STREAM_CHUNK") {
    const cursor = answerBox.querySelector(".cursor");
    if (cursor) cursor.remove();
    answerBox.appendChild(document.createTextNode(msg.token));
    const cur = document.createElement("span");
    cur.className = "cursor";
    answerBox.appendChild(cur);
    answerBox.scrollTop = answerBox.scrollHeight;

    // Persist incrementally (debounced via timeout)
    clearTimeout(answerBox._persistTimer);
    answerBox._persistTimer = setTimeout(() => {
      persistAnswer(currentThreadId, answerBox.textContent.replace(/\u00a0/g, "").trimEnd());
    }, 400);
    return;
  }

  if (msg.type === "LLM_STREAM_DONE") {
    const cursor = answerBox.querySelector(".cursor");
    if (cursor) cursor.remove();
    // Final persist
    persistAnswer(currentThreadId, answerBox.textContent.trimEnd());
    isStreaming        = false;
    btnAsk.disabled    = false;
    btnAsk.textContent = "Ask AI";
    return;
  }

  if (msg.type === "LLM_STREAM_ERROR") {
    const cursor = answerBox.querySelector(".cursor");
    if (cursor) cursor.remove();
    setStatus("❌ LLM error: " + msg.error, "error");
    isStreaming        = false;
    btnAsk.disabled    = false;
    btnAsk.textContent = "Ask AI";
    return;
  }
});

btnAsk.addEventListener("click", async () => {
  if (isStreaming) return;

  const question = questionEl.value.trim();
  if (!question) { setStatus("Enter a question first.", "warn"); return; }

  const apiKey = apiKeyInput.value.trim();
  const model  = modelInput.value.trim();
  if (!apiKey) { setStatus("Enter your API key.", "warn"); return; }
  if (!model)  { setStatus("Select a model.",     "warn"); return; }

  // Auto-crawl if needed
  const ready = await ensureCrawled();
  if (!ready) return;

  isStreaming        = true;
  btnAsk.disabled    = true;
  btnAsk.textContent = "Streaming…";
  clearStatus();

  // Clear previous answer
  answerBox.innerHTML      = "";
  answerWrap.style.display = "block";

  // Persist question
  persistQuestion(currentThreadId, question);

  // Add initial cursor
  const cur = document.createElement("span");
  cur.className = "cursor";
  answerBox.appendChild(cur);

  try {
    const resp = await chrome.runtime.sendMessage({
      type:     "ASK_QUESTION",
      threadId: currentThreadId,
      question,
      provider: currentProvider,
      model,
      apiKey,
      baseUrl:  null,
    });

    if (!resp.ok) {
      setStatus("❌ " + resp.error, "error");
      isStreaming        = false;
      btnAsk.disabled    = false;
      btnAsk.textContent = "Ask AI";
    }
  } catch (e) {
    setStatus("❌ " + e.message, "error");
    isStreaming        = false;
    btnAsk.disabled    = false;
    btnAsk.textContent = "Ask AI";
  }
});

// ── Clear cache ────────────────────────────────────────────────────────────

btnClearCache.addEventListener("click", async () => {
  if (!currentThreadId) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_CACHE", threadId: currentThreadId });
  // Also clear persisted answer/question for this thread
  chrome.storage.session.remove([
    `voz_answer_${currentThreadId}`,
    `voz_question_${currentThreadId}`,
  ]);
  cacheInfo.style.display  = "none";
  answerWrap.style.display = "none";
  answerBox.innerHTML      = "";
  questionEl.value         = "";
  autoResizeQuestion();
  clearStatus();
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  // Current tab URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url   = tab?.url || "";

  if (/voz\.vn\/t\//.test(url)) {
    currentUrl = url;
    clearStatus();
  } else {
    setStatus("⚠️ Open a voz.vn thread first.", "warn");
  }

  // Extract thread ID
  const m = url.match(/\.(\d+)\/?/);
  if (m) {
    currentThreadId = m[1];
    await refreshCacheInfo(currentThreadId);

    // Restore persisted question
    const savedQ = await restoreQuestion(currentThreadId);
    if (savedQ) {
      questionEl.value    = savedQ;
      questionEl.disabled = false;
      btnAsk.disabled     = false;
      autoResizeQuestion();
    }

    // Restore persisted answer
    const savedA = await restoreAnswer(currentThreadId);
    if (savedA) {
      answerWrap.style.display = "block";
      answerBox.textContent    = savedA;
    }
  }

  // Restore provider
  const savedProvider = await new Promise((res) =>
    chrome.storage.local.get("voz_provider", (d) => res(d.voz_provider || "openai"))
  );
  currentProvider = savedProvider;
  document.querySelectorAll(".provider-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.provider === currentProvider);
  });

  // Restore expanded state
  const { voz_expanded } = await new Promise((res) =>
    chrome.storage.session.get("voz_expanded", res)
  );
  if (voz_expanded) {
    document.body.classList.add("expanded");
    btnExpand.style.display   = "none";
    btnCollapse.style.display = "inline-block";
  }

  // Restore config collapsed state
  const { voz_config_collapsed } = await new Promise((res) =>
    chrome.storage.session.get("voz_config_collapsed", res)
  );
  if (voz_config_collapsed) {
    configSection.classList.add("collapsed");
    btnToggleConfig.title = "Show settings";
  }

  // Load API key + models
  const key = await loadApiKey(currentProvider);
  apiKeyInput.value = key;
  await fetchAndPopulateModels(currentProvider, key);

  // Enable question/ask if on a voz thread (auto-crawl handles the rest)
  if (/voz\.vn\/t\//.test(url)) {
    questionEl.disabled = false;
    btnAsk.disabled     = false;
  }
  autoResizeQuestion();

}

init();