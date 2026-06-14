// background.js — service worker (NO DOMParser, NO innerText — not available here)

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Referer": "https://voz.vn/",
};

// In-memory store: threadId -> { title, url, posts, crawledAt }
const threadCache = {};

// ── Tiny HTML helpers ──────────────────────────────────────────────────────

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function clean(html) {
  return decodeEntities(stripTags(html));
}

function extractBlock(html, selector) {
  const start = html.indexOf(selector);
  if (start === -1) return null;
  let tagStart = html.lastIndexOf("<", start);
  if (tagStart === -1) return null;
  let tagEnd = html.indexOf(">", tagStart);
  if (tagEnd === -1) return null;

  const tagMatch = html.slice(tagStart + 1, tagEnd).match(/^(\w+)/);
  if (!tagMatch) return null;
  const tagName = tagMatch[1].toLowerCase();

  let depth = 1;
  let pos = tagEnd + 1;
  const openTag  = new RegExp(`<${tagName}[\\s>]`, "gi");
  const closeTag = new RegExp(`<\\/${tagName}>`, "gi");

  while (depth > 0 && pos < html.length) {
    openTag.lastIndex  = pos;
    closeTag.lastIndex = pos;
    const nextOpen  = openTag.exec(html);
    const nextClose = closeTag.exec(html);

    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      pos = nextOpen.index + 1;
    } else {
      depth--;
      if (depth === 0) return html.slice(tagEnd + 1, nextClose.index);
      pos = nextClose.index + 1;
    }
  }
  return null;
}

// ── Parsers ────────────────────────────────────────────────────────────────

function extractThreadId(url) {
  const m = url.match(/\.(\d+)\/?/);
  return m ? m[1] : null;
}

function parseTitle(html) {
  const m = html.match(/class="p-title-value"[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) return clean(m[1]);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? clean(t[1]).replace(/\s*\|.*$/, "").trim() : "";
}

function parseTotalPages(html) {
  // Strategy 1: pageNav-page links
  const pageNumRe = /pageNav-page[^>]*>[\s\S]*?<a[^>]+>(\d+)<\/a>/gi;
  const nums = [];
  let m;
  while ((m = pageNumRe.exec(html)) !== null) nums.push(parseInt(m[1], 10));
  if (nums.length) return Math.max(...nums);

  // Strategy 2: href containing /page-N
  const hrefRe = /href="[^"]*\/page-(\d+)[^"]*"/gi;
  const hrefNums = [];
  while ((m = hrefRe.exec(html)) !== null) hrefNums.push(parseInt(m[1], 10));
  if (hrefNums.length) return Math.max(...hrefNums);

  // Strategy 3: data-last or data-page attributes
  const dataRe = /data-last="(\d+)"|data-page="(\d+)"/gi;
  const dataNums = [];
  while ((m = dataRe.exec(html)) !== null) dataNums.push(parseInt(m[1] || m[2], 10));
  if (dataNums.length) return Math.max(...dataNums);

  // Strategy 4: "Trang X / Y" or "Page X of Y"
  const ofRe = /(?:trang|page)\s+\d+\s*(?:\/|of)\s*(\d+)/gi;
  while ((m = ofRe.exec(html)) !== null) return parseInt(m[1], 10);

  return 1;
}

function parsePosts(html) {
  const posts = [];
  const articleRe = /<article\b[^>]*class="[^"]*\bmessage\b[^"]*"[^>]*data-content="post-(\d+)"[^>]*>/gi;
  const articleStarts = [];
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    articleStarts.push({ index: m.index, postId: m[1] });
  }

  for (let i = 0; i < articleStarts.length; i++) {
    const start  = articleStarts[i].index;
    const end    = i + 1 < articleStarts.length ? articleStarts[i + 1].index : html.length;
    const chunk  = html.slice(start, end);
    const postId = articleStarts[i].postId;

    const uMatch   = chunk.match(/class="[^"]*\busername\b[^"]*"[^>]*data-user-id="(\d+)"[^>]*>([\s\S]*?)<\/[^>]+>/i)
                  || chunk.match(/class="[^"]*\busername\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    const username = uMatch ? clean(uMatch[uMatch.length - 1]) : "Unknown";
    const userId   = uMatch && uMatch.length >= 3 ? uMatch[1] : null;

    const tMatch       = chunk.match(/message-attribution-main[\s\S]*?<time[^>]+datetime="([^"]+)"/i);
    const createdDate  = tMatch ? tMatch[1] : "";

    const mMatch       = chunk.match(/message-lastEdit[\s\S]*?<time[^>]+datetime="([^"]+)"/i);
    const modifiedDate = mMatch ? mMatch[1] : null;

    const bbIdx = chunk.indexOf('class="bbWrapper"');
    let content = "";
    if (bbIdx !== -1) {
      const inner = extractBlock(chunk, 'class="bbWrapper"');
      if (inner) {
        content = clean(inner)
          .replace(/Click to expand\.\.\./g, "")
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    posts.push({
      post_id:          postId,
      author_username:  username,
      author_user_id:   userId,
      created_date:     createdDate,
      modified_date:    modifiedDate,
      content_text:     content,
    });
  }

  return posts;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

async function fetchPage(url, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.text();
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    } catch (e) {
      console.error("[VOZ-QA] Fetch error:", e.message, "attempt", i);
      if (i === retries) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

// ── Concurrent crawl helpers ───────────────────────────────────────────────

async function fetchPageWithIndex(baseUrl, pageNum) {
  const url  = `${baseUrl.replace(/\/$/, "")}/page-${pageNum}`;
  const html = await fetchPage(url);
  return { pageNum, html };
}

async function crawlPagesInBatches(baseUrl, totalPages, batchSize = 5, sendProgress = null) {
  const allPosts = [];
  // Pages 2..totalPages (page 1 already fetched)
  const pageNums = [];
  for (let p = 2; p <= totalPages; p++) pageNums.push(p);

  for (let i = 0; i < pageNums.length; i += batchSize) {
    const batch   = pageNums.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((p) => fetchPageWithIndex(baseUrl, p)));

    // Sort results by page number to preserve post order
    results.sort((a, b) => a.pageNum - b.pageNum);

    for (const { pageNum, html } of results) {
      if (html) {
        const posts = parsePosts(html);
        console.log(`[VOZ-QA] Page ${pageNum}: ${posts.length} posts`);
        allPosts.push(...posts);
      }
      if (sendProgress) {
        sendProgress({ status: "crawling", page: pageNum, total: totalPages });
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < pageNums.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return allPosts;
}

// ── Main crawl ─────────────────────────────────────────────────────────────

async function crawlThread(threadUrl, sendProgress) {
  const threadId = extractThreadId(threadUrl);
  if (!threadId) throw new Error("Cannot extract thread ID from URL: " + threadUrl);

  console.log("[VOZ-QA] Starting crawl for threadId:", threadId);
  sendProgress({ status: "crawling", page: 1, total: "?" });

  const html1 = await fetchPage(threadUrl);
  if (!html1) throw new Error("Failed to fetch page 1 — got null response");

  const title      = parseTitle(html1);
  const totalPages = parseTotalPages(html1);
  const page1Posts = parsePosts(html1);

  console.log("[VOZ-QA] title:", title, "| pages:", totalPages, "| p1 posts:", page1Posts.length);
  sendProgress({ status: "crawling", page: 1, total: totalPages });

  const remainingPosts = totalPages > 1
    ? await crawlPagesInBatches(threadUrl, totalPages, 5, sendProgress)
    : [];

  const allPosts = [...page1Posts, ...remainingPosts];

  const data = {
    thread_id:   threadId,
    title,
    url:         threadUrl,
    crawled_at:  new Date().toISOString(),
    total_pages: totalPages,
    post_count:  allPosts.length,
    posts:       allPosts,
  };

  threadCache[threadId] = data;
  console.log("[VOZ-QA] Crawl complete. Total posts:", allPosts.length);
  return data;
}

// ── Model fetching ─────────────────────────────────────────────────────────

async function fetchOpenAIModels(apiKey) {
  const FALLBACK = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"];
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return FALLBACK;
    const data = await res.json();
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => /gpt/i.test(id))
      .sort()
      .reverse();
    return ids.length ? ids : FALLBACK;
  } catch (e) {
    console.error("[VOZ-QA] fetchOpenAIModels error:", e);
    return FALLBACK;
  }
}

async function fetchAnthropicModels(apiKey) {
  const FALLBACK = [
    "claude-opus-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307",
  ];
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key":          apiKey,
        "anthropic-version":  "2023-06-01",
        "content-type":       "application/json",
      },
    });
    if (!res.ok) return FALLBACK;
    const data = await res.json();
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => /claude/i.test(id))
      .sort()
      .reverse();
    return ids.length ? ids : FALLBACK;
  } catch (e) {
    console.error("[VOZ-QA] fetchAnthropicModels error:", e);
    return FALLBACK;
  }
}

// ── LLM streaming ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Bạn là chuyên gia phân tích tri thức cộng đồng.

Nhiệm vụ:
- Đọc toàn bộ nội dung thread được cung cấp.
- Hiểu chính xác câu hỏi của người dùng.
- Chỉ sử dụng thông tin xuất hiện trong thread.
- Ưu tiên comment có kinh nghiệm thực tế, dữ kiện cụ thể, lập luận rõ ràng.

Bỏ qua: meme, joke, spam, off-topic, cãi nhau vô ích.

Không sử dụng format cố định — hãy chọn cách trình bày phù hợp với loại câu hỏi.

Mục tiêu: Trả lời đúng câu hỏi của người dùng thay vì tóm tắt thread.`;

function buildContext(posts, maxPosts = 400) {
  return posts
    .slice(0, maxPosts)
    .map((p) => `[${p.author_username}]: ${p.content_text}`)
    .join("\n");
}

// Stream tokens back via chrome.runtime.sendMessage to the popup
async function callLLMStream({ provider, model, apiKey, baseUrl, context, question, postCount, tabId }) {
  const userContent =
    `Tổng số bài viết: ${postCount}\n\n` +
    `### NỘI DUNG THREAD\n${context}\n\n` +
    `---\n### CÂU HỎI CỦA NGƯỜI DÙNG\n${question}`;

  let url, headers, body;

  if (provider === "anthropic") {
    url     = "https://api.anthropic.com/v1/messages";
    headers = {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = JSON.stringify({
      model,
      max_tokens: 2048,
      stream:     true,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userContent }],
    });
  } else {
    url     = baseUrl || "https://api.openai.com/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model,
      max_tokens: 2048,
      stream:     true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userContent },
      ],
    });
  }

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM error ${res.status}: ${err}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = "";

  function sendChunk(token) {
    chrome.runtime.sendMessage({ type: "LLM_STREAM_CHUNK", token });
  }
  function sendDone() {
    chrome.runtime.sendMessage({ type: "LLM_STREAM_DONE" });
  }
  function sendError(msg) {
    chrome.runtime.sendMessage({ type: "LLM_STREAM_ERROR", error: msg });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));

          if (provider === "anthropic") {
            // Anthropic SSE: event types content_block_delta
            const delta = json.delta?.text;
            if (delta) sendChunk(delta);
          } else {
            // OpenAI SSE
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) sendChunk(delta);
          }
        } catch (_) {
          // malformed JSON line — skip
        }
      }
    }
    sendDone();
  } catch (e) {
    sendError(e.message);
  }
}

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log("[VOZ-QA] Message received:", msg.type);

  // ── Crawl ──
  if (msg.type === "CRAWL_THREAD") {
    const { url } = msg;
    const threadId = extractThreadId(url);

    if (threadCache[threadId]) {
      console.log("[VOZ-QA] Returning cached data for", threadId);
      sendResponse({ ok: true, cached: true, data: threadCache[threadId] });
      return true;
    }

    crawlThread(url, (progress) => {
      console.log("[VOZ-QA] Progress:", progress);
      // Forward progress to popup
      chrome.runtime.sendMessage({ type: "CRAWL_PROGRESS", ...progress }).catch(() => {});
    })
      .then((data) => sendResponse({ ok: true, cached: false, data }))
      .catch((e)  => sendResponse({ ok: false, error: e.message }));

    return true;
  }

  // ── Ask (streaming) ──
  if (msg.type === "ASK_QUESTION") {
    const { threadId, question, provider, model, apiKey, baseUrl } = msg;
    const cached = threadCache[threadId];
    if (!cached) {
      sendResponse({ ok: false, error: "Thread not crawled yet." });
      return true;
    }

    const context = buildContext(cached.posts);
    // Acknowledge immediately; actual tokens arrive via sendMessage
    sendResponse({ ok: true, streaming: true });

    callLLMStream({
      provider, model, apiKey, baseUrl,
      context, question,
      postCount: cached.post_count,
    }).catch((e) => {
      console.error("[VOZ-QA] LLM stream error:", e);
      chrome.runtime.sendMessage({ type: "LLM_STREAM_ERROR", error: e.message }).catch(() => {});
    });

    return true;
  }

  // ── Fetch models ──
  if (msg.type === "FETCH_MODELS") {
    const { provider, apiKey } = msg;
    const fetcher = provider === "anthropic" ? fetchAnthropicModels : fetchOpenAIModels;
    fetcher(apiKey)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((e)     => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Cache helpers ──
  if (msg.type === "GET_CACHE_INFO") {
    const cached = threadCache[msg.threadId];
    if (cached) {
      sendResponse({ ok: true, cached: true, title: cached.title, post_count: cached.post_count, crawled_at: cached.crawled_at });
    } else {
      sendResponse({ ok: true, cached: false });
    }
    return true;
  }

  if (msg.type === "CLEAR_CACHE") {
    if (msg.threadId && threadCache[msg.threadId]) delete threadCache[msg.threadId];
    sendResponse({ ok: true });
    return true;
  }
});