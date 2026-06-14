// popup.js

// ── State ──────────────────────────────────────────────────────────────────
let currentProvider = "openai";
let currentThreadId = null;
let currentUrl      = null;
let isStreaming     = false;

// ── DOM refs ───────────────────────────────────────────────────────────────
const apiKeyInput      = document.getElementById("apiKey");
const modelSelect      = document.getElementById("modelSelect");
const modelSpinner     = document.getElementById("modelSpinner");
const btnRefreshModels = document.getElementById("btnRefreshModels");
const btnSaveKey       = document.getElementById("btnSaveKey");
const btnCrawl         = document.getElementById("btnCrawl");
const btnAsk           = document.getElementById("btnAsk");
const questionEl       = document.getElementById("question");
const statusBar        = document.getElementById("statusBar");
const cacheInfo        = document.getElementById("cacheInfo");
const cacheTitle       = document.getElementById("cacheTitle");
const cacheMeta        = document.getElementById("cacheMeta");
const btnClearCache    = document.getElementById("btnClearCache");
const answerWrap       = document.getElementById("answerWrap");
const answerBox        = document.getElementById("answerBox");

// ── Helpers ────────────────────────────────────────────────────────────────

function setStatus(msg, type = "info") {
  statusBar.textContent = msg;
  statusBar.className   = type;
}

function clearStatus() {
  statusBar.className   = "";
  statusBar.textContent = "";
}

function storageKey(provider) {
  return `voz_apikey_${provider}`;
}
function modelStorageKey(provider) {
  return `voz_model_${provider}`;
}

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

function savedModelsKey(provider) { return `voz_models_${provider}`; }

function saveModels(provider, models) {
  chrome.storage.local.set({ [savedModelsKey(provider)]: models });
}

function loadSavedModels(provider) {
  return new Promise((res) =>
    chrome.storage.local.get(savedModelsKey(provider), (d) => res(d[savedModelsKey(provider)] || []))
  );
}

function populateModelSelect(models, selectedModel = "") {
  modelSelect.innerHTML = "";
  if (!models.length) {
    modelSelect.innerHTML = '<option value="">— no models found —</option>';
    return;
  }
  models.forEach((id) => {
    const opt    = document.createElement("option");
    opt.value    = id;
    opt.textContent = id;
    if (id === selectedModel) opt.selected = true;
    modelSelect.appendChild(opt);
  });
}

async function fetchAndPopulateModels(provider, apiKey, forceRefresh = false) {
  if (!apiKey) {
    modelSelect.innerHTML = '<option value="">— enter API key first —</option>';
    return;
  }

  // Try cached list first (unless forced refresh)
  if (!forceRefresh) {
    const saved = await loadSavedModels(provider);
    if (saved.length) {
      const chosen = await loadModelChoice(provider);
      populateModelSelect(saved, chosen);
      return;
    }
  }

  // Fetch from API
  modelSpinner.style.display = "block";
  btnRefreshModels.disabled  = true;
  modelSelect.disabled       = true;

  try {
    const resp = await chrome.runtime.sendMessage({ type: "FETCH_MODELS", provider, apiKey });
    if (resp.ok && resp.models.length) {
      saveModels(provider, resp.models);
      const chosen = await loadModelChoice(provider);
      populateModelSelect(resp.models, chosen);
    } else {
      setStatus("Could not fetch models — using defaults", "warn");
    }
  } catch (e) {
    setStatus("Error fetching models: " + e.message, "error");
  } finally {
    modelSpinner.style.display = "none";
    btnRefreshModels.disabled  = false;
    modelSelect.disabled       = false;
  }
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
    questionEl.disabled     = true;
    btnAsk.disabled         = true;
  }
}

// ── Provider toggle ────────────────────────────────────────────────────────

document.querySelectorAll(".provider-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".provider-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentProvider = btn.dataset.provider;

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

// Save model choice whenever user changes selection
modelSelect.addEventListener("change", () => {
  saveModelChoice(currentProvider, modelSelect.value);
});

// ── Refresh models button ──────────────────────────────────────────────────

btnRefreshModels.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setStatus("Enter your API key first.", "warn"); return; }
  await fetchAndPopulateModels(currentProvider, key, true);
});

// ── Crawl ──────────────────────────────────────────────────────────────────

btnCrawl.addEventListener("click", async () => {
  if (!currentUrl) { setStatus("Not on a VOZ thread page.", "warn"); return; }

  btnCrawl.disabled = true;
  setStatus("⏳ Crawling page 1…", "info");
  answerWrap.style.display = "none";
  answerBox.innerHTML      = "";

  try {
    const resp = await chrome.runtime.sendMessage({ type: "CRAWL_THREAD", url: currentUrl });
    if (resp.ok) {
      setStatus(
        resp.cached
          ? `✅ Loaded from cache — ${resp.data.post_count} posts`
          : `✅ Done — ${resp.data.post_count} posts across ${resp.data.total_pages} pages`,
        "success"
      );
      currentThreadId = resp.data.thread_id;
      await refreshCacheInfo(currentThreadId);
    } else {
      setStatus("❌ Crawl failed: " + resp.error, "error");
    }
  } catch (e) {
    setStatus("❌ " + e.message, "error");
  } finally {
    btnCrawl.disabled = false;
  }
});

// ── Streaming answer ───────────────────────────────────────────────────────

// Listen for streamed chunks from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CRAWL_PROGRESS") {
    setStatus(`⏳ Crawling page ${msg.page} / ${msg.total}…`, "info");
    return;
  }

  if (msg.type === "LLM_STREAM_CHUNK") {
    // Remove blinking cursor, append token, re-add cursor
    const cursor = answerBox.querySelector(".cursor");
    if (cursor) cursor.remove();
    // Append as text node to avoid XSS and preserve whitespace
    answerBox.appendChild(document.createTextNode(msg.token));
    // Re-add cursor
    const cur = document.createElement("span");
    cur.className = "cursor";
    answerBox.appendChild(cur);
    answerBox.scrollTop = answerBox.scrollHeight;
    return;
  }

  if (msg.type === "LLM_STREAM_DONE") {
    // Remove cursor
    const cursor = answerBox.querySelector(".cursor");
    if (cursor) cursor.remove();
    isStreaming     = false;
    btnAsk.disabled = false;
    btnAsk.textContent = "Ask AI";
    return;
  }

  if (msg.type === "LLM_STREAM_ERROR") {
    const cursor = answerBox.querySelector(".cursor");
    if (cursor) cursor.remove();
    setStatus("❌ LLM error: " + msg.error, "error");
    isStreaming     = false;
    btnAsk.disabled = false;
    btnAsk.textContent = "Ask AI";
    return;
  }
});

btnAsk.addEventListener("click", async () => {
  if (isStreaming) return;

  const question = questionEl.value.trim();
  if (!question)       { setStatus("Enter a question first.", "warn"); return; }
  if (!currentThreadId){ setStatus("Crawl the thread first.", "warn"); return; }

  const apiKey = apiKeyInput.value.trim();
  const model  = modelSelect.value;
  if (!apiKey) { setStatus("Enter your API key.", "warn"); return; }
  if (!model)  { setStatus("Select a model.", "warn");     return; }

  isStreaming        = true;
  btnAsk.disabled    = true;
  btnAsk.textContent = "Streaming…";
  clearStatus();

  // Clear previous answer
  answerBox.innerHTML      = "";
  answerWrap.style.display = "block";

  // Add initial cursor
  const cur = document.createElement("span");
  cur.className = "cursor";
  answerBox.appendChild(cur);

  try {
    const resp = await chrome.runtime.sendMessage({
      type:       "ASK_QUESTION",
      threadId:   currentThreadId,
      question,
      provider:   currentProvider,
      model,
      apiKey,
      baseUrl:    null,
    });

    if (!resp.ok) {
      setStatus("❌ " + resp.error, "error");
      isStreaming        = false;
      btnAsk.disabled    = false;
      btnAsk.textContent = "Ask AI";
    }
    // If resp.ok + resp.streaming === true → chunks arrive via onMessage above
  } catch (e) {
    setStatus("❌ " + e.message, "error");
    isStreaming        = false;
    btnAsk.disabled    = false;
    btnAsk.textContent = "Ask AI";
  }
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  // Get current tab URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url   = tab?.url || "";

  if (/voz\.vn\/t\//.test(url)) {
    currentUrl = url;
    clearStatus();
  } else {
    setStatus("⚠️ Open a voz.vn thread first.", "warn");
    btnCrawl.disabled = true;
  }

  // Extract thread ID from URL if possible
  const m = url.match(/\.(\d+)\/?/);
  if (m) {
    currentThreadId = m[1];
    await refreshCacheInfo(currentThreadId);
  }

  // Load saved provider choice
  const savedProvider = await new Promise((res) =>
    chrome.storage.local.get("voz_provider", (d) => res(d.voz_provider || "openai"))
  );
  currentProvider = savedProvider;
  document.querySelectorAll(".provider-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.provider === currentProvider);
  });

  // Load API key for provider and populate models
  const key = await loadApiKey(currentProvider);
  apiKeyInput.value = key;
  await fetchAndPopulateModels(currentProvider, key);
}

// Save provider choice when toggled
document.querySelectorAll(".provider-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    chrome.storage.local.set({ voz_provider: btn.dataset.provider });
  });
});

init();