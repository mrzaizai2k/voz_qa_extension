// content.js — runs on voz.vn/t/* pages

function extractPosts() {
  const posts = [];
  const articles = document.querySelectorAll(".block-body article.message");

  articles.forEach((el) => {
    const postId = (el.getAttribute("data-content") || "").replace("post-", "") || null;

    const uEl = el.querySelector(".message-userDetails .username");
    const username = uEl ? uEl.textContent.trim() : "Unknown";
    const userId = uEl ? uEl.getAttribute("data-user-id") : null;

    const tEl = el.querySelector(".message-attribution-main time");
    const createdDate = tEl ? tEl.getAttribute("datetime") : "";

    const mEl = el.querySelector(".message-lastEdit time");
    const modifiedDate = mEl ? mEl.getAttribute("datetime") : null;

    const cEl = el.querySelector(".message-body .bbWrapper");
    let content = cEl ? cEl.innerText.trim() : "";
    content = content.replace(/Click to expand\.\.\./g, "").trim();
    content = content.replace(/\n+/g, " ").replace(/\r/g, "");

    posts.push({
      post_id: postId,
      author_username: username,
      author_user_id: userId,
      created_date: createdDate,
      modified_date: modifiedDate,
      content_text: content,
    });
  });

  return posts;
}

function getThreadMeta() {
  const titleEl = document.querySelector(".p-title-value");
  const title = titleEl ? titleEl.textContent.trim() : document.title;

  // Parse total pages from nav
  let totalPages = 1;
  const nav = document.querySelector("nav.pageNavWrapper");
  if (nav) {
    const pageLinks = nav.querySelectorAll(".pageNav-page a");
    const nums = Array.from(pageLinks)
      .map((a) => parseInt(a.textContent.trim(), 10))
      .filter((n) => !isNaN(n));
    if (nums.length) totalPages = Math.max(...nums);
  }

  return { title, totalPages, url: window.location.href };
}

// Listen for messages from the popup/background
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_META") {
    sendResponse(getThreadMeta());
  } else if (msg.type === "GET_POSTS") {
    sendResponse(extractPosts());
  }
  return true;
});
