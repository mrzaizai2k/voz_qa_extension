// prompts.js

export const SYSTEM_PROMPT = `Bạn là chuyên gia phân tích tri thức cộng đồng.

Nhiệm vụ:
- Đọc toàn bộ nội dung thread được cung cấp.
- Hiểu chính xác câu hỏi của người dùng.
- Chỉ sử dụng thông tin xuất hiện trong thread.
- Ưu tiên comment có kinh nghiệm thực tế, dữ kiện cụ thể, lập luận rõ ràng.

Bỏ qua:
- meme
- joke
- spam
- off-topic
- cãi nhau vô ích

Không sử dụng format cố định — hãy chọn cách trình bày phù hợp với loại câu hỏi.

Mục tiêu:
Trả lời đúng câu hỏi của người dùng thay vì tóm tắt thread.`;

export function buildContext(posts, maxPosts = 400) {
  return posts
    .slice(0, maxPosts)
    .map((p) => `[${p.author_username}]: ${p.content_text}`)
    .join("\n");
}

export function buildUserPrompt({
  question,
  context,
  postCount,
}) {
  return [
    `Tổng số bài viết: ${postCount}`,
    "",
    "### NỘI DUNG THREAD",
    context,
    "",
    "---",
    "### CÂU HỎI CỦA NGƯỜI DÙNG",
    question,
  ].join("\n");
}

export function buildMessages({
  question,
  context,
  postCount,
}) {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: buildUserPrompt({
        question,
        context,
        postCount,
      }),
    },
  ];
}

export function buildAnthropicPayload({
  question,
  context,
  postCount,
}) {
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt({
          question,
          context,
          postCount,
        }),
      },
    ],
  };
}