import "dotenv/config";
import { Bot, GrammyError, HttpError } from "grammy";
import { loadConfig } from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import { chat, clearHistory, directKey, businessKey } from "./ai.js";
import { upsertConnection, canReply, getOwnerUserId } from "./connections.js";
import { findKeywordReply, isSheetsEnabled } from "./sheets.js";
import { logMessage, buildCustomerName } from "./logger.js";
import { registerOwnerReply, isHumanTakeover, activeTakeoverCount,
         pauseChat, resumeChat, listPausedChats, listActiveTakeovers } from "./takeover.js";

// ─── Startup ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌  TELEGRAM_BOT_TOKEN is not set. Exiting.");
  process.exit(1);
}

let systemPrompt: string;
try {
  const config = loadConfig();
  systemPrompt = buildSystemPrompt(config);
  console.log("✅  Business config loaded.");
} catch (err) {
  console.error("❌  Failed to load config:", err);
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Grace-period delay applied before every auto-reply.
 * During this window the owner can manually reply first, which sets the
 * takeover flag and causes the bot to abort the pending reply.
 * Configurable via BOT_REPLY_DELAY_MS env (default 3 seconds).
 */
const BOT_REPLY_DELAY_MS = parseInt(
  process.env.BOT_REPLY_DELAY_MS ?? "3000",
  10
);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Business API error helper ────────────────────────────────────────────────
/**
 * Log business-specific API errors clearly.
 *
 * BUSINESS_CONNECTION_INVALID  – connection_id changed because the owner
 *   updated their bot settings. A new updateBotBusinessConnect will arrive
 *   with the new connection_id. Nothing to do but log.
 *
 * BUSINESS_CONNECTION_NOT_ALLOWED – bot does not have business mode enabled
 *   in BotFather, or the method is not allowed over a business connection.
 *
 * BOT_ACCESS_FORBIDDEN – operation not permitted over this connection.
 */
function handleBusinessApiError(err: unknown, connectionId: string): void {
  if (err instanceof GrammyError) {
    const desc = err.description;
    if (desc.includes("BUSINESS_CONNECTION_INVALID")) {
      console.warn(
        `[business] ⚠️  BUSINESS_CONNECTION_INVALID  conn=${connectionId}\n` +
          "  → Owner changed bot settings. Waiting for new business_connection update."
      );
    } else if (desc.includes("BUSINESS_CONNECTION_NOT_ALLOWED")) {
      console.error(
        `[business] ❌  BUSINESS_CONNECTION_NOT_ALLOWED  conn=${connectionId}\n` +
          "  → Ensure 'Allow connecting to Business accounts' is ON in @BotFather."
      );
    } else if (desc.includes("BOT_ACCESS_FORBIDDEN")) {
      console.error(
        `[business] ❌  BOT_ACCESS_FORBIDDEN  conn=${connectionId}\n` +
          "  → Operation not permitted over this business connection."
      );
    } else {
      console.error(`[business] API error  conn=${connectionId}:`, desc);
    }
  } else {
    console.error(`[business] Unexpected error  conn=${connectionId}:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TELEGRAM BUSINESS MODE
//
//  How it works:
//    1. Business owner goes to Settings → Telegram Business → Chatbots
//    2. They connect this bot to their business account
//    3. Customer messages arrive here as `business_message` updates
//    4. Bot replies using business_connection_id → message appears from the owner
//
//  Reference: https://telegram.org/blog/telegram-business
// ─────────────────────────────────────────────────────────────────────────────

/** Fired when a business account connects or disconnects this bot.
 *
 *  BusinessConnection fields (Bot API):
 *    .id          – connection identifier used in all related updates
 *    .user        – the business account owner (User object)
 *    .user_chat_id– private chat id with the owner
 *    .date        – unix timestamp
 *    .can_reply   – bot is allowed to send messages on behalf of the user
 *    .is_enabled  – false → paused or removed
 *
 *  Reference: https://core.telegram.org/api/bots/connected-business-bots
 */
bot.on("business_connection", async (ctx) => {
  const conn = ctx.businessConnection;
  // Persist in cache (or remove if disabled)
  upsertConnection(conn);

  if (!conn.is_enabled) {
    // Connection was paused or fully removed — clear all history for this connection
    // We don't have a per-connection clear, but we log it clearly
    console.log(
      `[business] ⚠️  Connection disabled  id=${conn.id}  owner=${conn.user.id}`
    );
  }
});

/**
 * Fired when a customer sends a message to the business owner's personal account.
 *
 * IMPORTANT (from the API spec):
 *  - Must check `can_reply` right from the BusinessConnection before sending.
 *    If can_reply=false the bot received the message for logging/CRM only,
 *    and MUST NOT attempt to reply.
 *  - Replies MUST include `business_connection_id`; without it the message
 *    goes to a void and the customer never sees it.
 *  - Error `BUSINESS_CONNECTION_INVALID` means the connection_id changed
 *    (e.g. owner changed bot settings). Treat it as non-fatal and log clearly.
 */
bot.on("business_message", async (ctx) => {
  const msg = ctx.businessMessage;
  // business_connection_id is always present on business_message updates
  const connectionId = msg.business_connection_id!;

  // ── Rights check ──────────────────────────────────────────────────────────
  if (!canReply(connectionId)) {
    console.log(
      `[business] 👁  Read-only connection=${connectionId} — message logged, no reply sent`
    );
    return;
  }

  // ── Owner self-message check ──────────────────────────────────────────────
  // When the business owner manually types a reply, the bot still receives
  // the message as a business_message update. We must NOT auto-reply — that
  // would create an infinite loop or duplicate reply visible to the customer.
  // We log the owner's message as OUT (人工回复) for a complete chat history.
  const ownerUserId = getOwnerUserId(connectionId);
  if (msg.from && ownerUserId !== undefined && msg.from.id === ownerUserId) {
    console.log(
      `[business] 🙋  Owner manual reply  conn=${connectionId}  "${msg.text?.slice(0, 60) ?? "[non-text]"}"`
    );
    // Register the manual reply → activates / resets takeover TTL for this chat
    registerOwnerReply(connectionId, msg.chat.id);
    // Log owner's manual message as an outgoing human reply
    void logMessage({
      direction: "OUT",
      customerId: msg.chat.id,
      customerName: buildCustomerName(msg.chat),
      connectionId,
      text: msg.text?.trim() ?? "[非文字消息 / Non-text]",
      replyType: "人工回复",
    });
    return; // ← do NOT auto-reply
  }

  const text = msg.text?.trim();

  // ── Build customer display name ───────────────────────────────────────────
  const customerName = buildCustomerName(msg.chat);

  if (!text) {
    // Non-text (photo, sticker, file, …) — politely ask for text
    // Still log the incoming non-text message
    void logMessage({
      direction: "IN",
      customerId: msg.chat.id,
      customerName,
      connectionId,
      text: "[非文字消息 / Non-text message]",
      replyType: "",
    });
    const noTextReply =
      "抱歉，我目前只支持文字消息，请用文字描述您的需求。\n" +
      "Sorry, I only support text messages. Please describe your needs in text.";
    try {
      await ctx.api.sendMessage(msg.chat.id, noTextReply, {
        business_connection_id: connectionId,
      });
      void logMessage({
        direction: "OUT",
        customerId: msg.chat.id,
        customerName,
        connectionId,
        text: noTextReply,
        replyType: "系统消息",
      });
    } catch (err) {
      handleBusinessApiError(err, connectionId);
    }
    return;
  }

  const key = businessKey(connectionId, msg.chat.id);
  console.log(
    `[business] 📨  conn=${connectionId}  customer=${msg.chat.id}  "${text.slice(0, 60)}"`
  );

  // ── Log the incoming customer message (fire-and-forget) ────────────────────
  void logMessage({
    direction: "IN",
    customerId: msg.chat.id,
    customerName,
    connectionId,
    text,
    replyType: "",
  });

  // ── Human takeover check ─────────────────────────────────────────────────
  // If the owner has recently sent a manual reply in this chat, we yield to
  // them and skip the auto-reply to prevent the customer seeing two replies.
  if (isHumanTakeover(connectionId, msg.chat.id)) {
    console.log(
      `[takeover] 🤫  Skipping auto-reply  conn=${connectionId}  chat=${msg.chat.id} — human is handling`
    );
    return;
  }

  // Show typing action to the customer
  try {
    await ctx.api.sendChatAction(msg.chat.id, "typing", {
      business_connection_id: connectionId,
    });
  } catch { /* non-critical */ }

  try {
    // ── Step 1: Check Google Sheets for a preset keyword reply ───────────────
    const presetReply = await findKeywordReply(text);

    if (presetReply !== null) {
      // Keyword matched — apply grace-period delay then re-check takeover
      await sleep(BOT_REPLY_DELAY_MS);
      if (isHumanTakeover(connectionId, msg.chat.id)) {
        console.log(`[takeover] 🤫  Aborted keyword reply  conn=${connectionId}  chat=${msg.chat.id}`);
        return;
      }
      // Send the preset reply directly, skip AI
      await ctx.api.sendMessage(msg.chat.id, presetReply, {
        business_connection_id: connectionId,
      });
      void logMessage({
        direction: "OUT",
        customerId: msg.chat.id,
        customerName,
        connectionId,
        text: presetReply,
        replyType: "预设关键词",
      });
      return;
    }

    // ── Step 2: No keyword match — let AI handle the message ─────────────────
    const aiReply = await chat(key, text, systemPrompt);
    // Apply grace-period delay then re-check takeover before sending
    await sleep(BOT_REPLY_DELAY_MS);
    if (isHumanTakeover(connectionId, msg.chat.id)) {
      console.log(`[takeover] 🤫  Aborted AI reply  conn=${connectionId}  chat=${msg.chat.id}`);
      return;
    }
    await ctx.api.sendMessage(msg.chat.id, aiReply, {
      business_connection_id: connectionId,
    });
    void logMessage({
      direction: "OUT",
      customerId: msg.chat.id,
      customerName,
      connectionId,
      text: aiReply,
      replyType: "AI生成",
    });
  } catch (err) {
    handleBusinessApiError(err, connectionId);
    try {
      await ctx.api.sendMessage(
        msg.chat.id,
        "⚠️ 抱歉，处理您的请求时出现了错误，请稍后重试。\n" +
          "Sorry, something went wrong. Please try again shortly.",
        { business_connection_id: connectionId }
      );
    } catch { /* best-effort error reply */ }
  }
});

/**
 * Customer edited a message — we skip re-answering to avoid confusion.
 */
bot.on("edited_business_message", (ctx) => {
  console.log(
    `[business] ✏️  Edited message from customer=${ctx.editedBusinessMessage.chat.id} (skipped)`
  );
});

/**
 * Messages deleted — clear that customer's history so context stays accurate.
 */
bot.on("deleted_business_messages", (ctx) => {
  const del = ctx.deletedBusinessMessages;
  const key = businessKey(del.business_connection_id!, del.chat.id);
  clearHistory(key);
  console.log(`[business] 🗑  History cleared  key=${key}`);
});

/**
 * Inline keyboard button pressed inside a business chat.
 *
 * Per the spec: callback queries from business chats arrive as normal
 * `callback_query` updates with a `business_connection_id` field set.
 * They must be answered with answerCallbackQuery — do NOT wrap in
 * invokeWithBusinessConnection.
 *
 * Reference: https://core.telegram.org/api/bots/connected-business-bots
 *   "…which when pressed will emit an updateBusinessBotCallbackQuery
 *    which should be handled … (without wrapping the query in an
 *    invokeWithBusinessConnection)"
 */
bot.on("callback_query:data", async (ctx) => {
  const query = ctx.callbackQuery;
  // business_connection_id is present on the raw Bot API callback_query object
  // when the button was pressed inside a business-managed chat; Grammy types
  // expose it via the raw object cast.
  const businessConnId: string | undefined = (query as Record<string, unknown>).business_connection_id as string | undefined;

  if (businessConnId) {
    console.log(
      `[business] 🔘  Callback  conn=${businessConnId}  data="${query.data}"  user=${query.from.id}`
    );
    // Answer the callback to dismiss the loading spinner on Telegram's side
    await ctx.answerCallbackQuery({ text: "✅" }).catch(() => {/* ignore */});
  } else {
    // Regular (non-business) callback — just acknowledge
    await ctx.answerCallbackQuery().catch(() => {/* ignore */});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DIRECT BOT MODE  (for testing / dev — chatting directly with the bot)
// ─────────────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 你好！欢迎来到 zznet 程序项目团队客服中心。\n" +
      "Hello! Welcome to zznet Software Team support.\n\n" +
      "请告诉我您需要什么帮助？/ How can I help you today?\n\n" +
      "发送 /reset 可清除对话记录 / Send /reset to clear history."
  );
});

bot.command("reset", async (ctx) => {
  clearHistory(directKey(ctx.chat.id));
  await ctx.reply(
    "✅ 对话记录已清除，我们重新开始吧！\n" +
      "Conversation history cleared. Let's start fresh!"
  );
});

// ─── Owner management commands (send these directly to the bot) ───────────────

/**
 * /pause <chatId>
 * Indefinitely pause bot auto-replies for a specific customer chat.
 * The owner's chatId in Telegram is a negative number for groups,
 * or a positive number for private chats.
 *
 * Example: /pause 123456789
 */
bot.command("pause", async (ctx) => {
  const arg = ctx.match?.trim();
  const chatId = arg ? parseInt(arg, 10) : NaN;
  if (isNaN(chatId)) {
    await ctx.reply(
      "❌ 请提供客户 Chat ID\n" +
      "Usage: /pause <chatId>\n\n" +
      "如何查找 chatId? 发送 /status 查看当前活跃对话列表。"
    );
    return;
  }
  pauseChat(chatId);
  await ctx.reply(`🔒 Chat \`${chatId}\` 已暂停自动回复。\n发送 /resume ${chatId} 可恢复。`);
});

/**
 * /resume <chatId>
 * Resume bot auto-replies for a specific customer chat.
 *
 * Example: /resume 123456789
 */
bot.command("resume", async (ctx) => {
  const arg = ctx.match?.trim();
  const chatId = arg ? parseInt(arg, 10) : NaN;
  if (isNaN(chatId)) {
    await ctx.reply(
      "❌ 请提供客户 Chat ID\n" +
      "Usage: /resume <chatId>"
    );
    return;
  }
  resumeChat(chatId);
  await ctx.reply(`✅ Chat \`${chatId}\` 已恢复自动回复。`);
});

/**
 * /status
 * Show all chats currently under human takeover (paused or TTL-active).
 */
bot.command("status", async (ctx) => {
  const paused = listPausedChats();
  const ttlActive = listActiveTakeovers().filter((t) => !t.locked);

  const lines: string[] = ["*🤖 Bot Takeover Status*\n"];

  if (paused.length === 0 && ttlActive.length === 0) {
    lines.push("✅ 所有对话均处于自动回复模式（无接管）");
  } else {
    if (paused.length > 0) {
      lines.push(`🔒 *永久暂停* (${paused.length})`);
      for (const id of paused) {
        lines.push(`  • chatId \`${id}\` — /resume ${id}`);
      }
    }
    if (ttlActive.length > 0) {
      lines.push(`\n⏳ *TTL 接管中* (${ttlActive.length})`);
      for (const t of ttlActive) {
        const minsLeft = t.expiresInMs !== null
          ? Math.ceil(t.expiresInMs / 60000)
          : '∞';
        lines.push(`  • chatId \`${t.chatId}\` conn \`${t.connectionId.slice(0, 8)}\` — ${minsLeft} 分钟后恢复`);
      }
    }
  }

  lines.push(`\n⏱ 回复延迟: ${BOT_REPLY_DELAY_MS / 1000}s | TTL: ${parseInt(process.env.TAKEOVER_TTL_MS ?? "600000", 10) / 60000}min`);
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "🤖 *zznet 客服机器人 / Support Bot*\n\n" +
      "• 直接发送消息提问 / Just send a message to ask\n" +
      "• /reset — 清除对话历史 / Clear conversation history\n" +
      "• /help — 显示此帮助 / Show this help\n\n" +
      "💼 *Telegram Business 连接方式：*\n" +
      "设置 → Telegram Business → 聊天机器人\n" +
      "Settings → Telegram Business → Chatbots",
    { parse_mode: "Markdown" }
  );
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;

  const key = directKey(ctx.chat.id);
  await ctx.replyWithChatAction("typing");

  try {
    // ── Step 1: Check Google Sheets for a preset keyword reply ───────────────
    const presetReply = await findKeywordReply(text);
    if (presetReply !== null) {
      await ctx.reply(presetReply);
      return;
    }

    // ── Step 2: No keyword match — AI handles the message ────────────────────
    const aiReply = await chat(key, text, systemPrompt);
    await ctx.reply(aiReply);
  } catch (err) {
    console.error(`[direct] Error  chat=${ctx.chat.id}:`, err);
    await ctx.reply(
      "⚠️ 抱歉，处理您的请求时出现了错误，请稍后重试。\n" +
        "Sorry, something went wrong. Please try again shortly."
    );
  }
});

bot.on("message", async (ctx) => {
  await ctx.reply(
    "抱歉，我目前只支持文字消息，请用文字描述您的需求。\n" +
      "Sorry, I only support text messages. Please describe your needs in text."
  );
});

// ─── Global error handler ─────────────────────────────────────────────────────

bot.catch((err) => {
  console.error(`[bot] Error on update ${err.ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("[bot] Grammy:", e.description);
  } else if (e instanceof HttpError) {
    console.error("[bot] HTTP:", e);
  } else {
    console.error("[bot] Unknown:", e);
  }
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.start({
  // Declare all update types the bot needs.
  // business_* types MUST be listed explicitly or Telegram will not deliver them.
  // callback_query is needed for inline button presses in business chats.
  allowed_updates: [
    "message",
    "callback_query",
    "business_connection",
    "business_message",
    "edited_business_message",
    "deleted_business_messages",
  ],
  onStart: (info) => {
    console.log(`\n🚀  Bot @${info.username} is live!`);
    console.log(`    Model  : ${process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile"}`);
    console.log(`    Sheets : ${isSheetsEnabled() ? "✅ Keyword lookup enabled" : "⚠️  Disabled (set GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_SPREADSHEET_ID)"}`);
    console.log(`    Takeover TTL: ${process.env.TAKEOVER_TTL_MS ?? "600000"}ms  (active sessions: ${activeTakeoverCount()})`);
    console.log("    Modes  : Direct bot + Telegram Business chatbot\n");
  },
});
