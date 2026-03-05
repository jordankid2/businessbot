import "dotenv/config";
import { Bot, GrammyError, HttpError } from "grammy";
import { chat, clearHistory, directKey, businessKey } from "./ai.js";
import { upsertConnection, canReply, getOwnerUserId } from "./connections.js";
import { findKeywordReply, isSheetsEnabled } from "./sheets.js";
import { logMessage, buildCustomerName } from "./logger.js";
import { transcribeVoice, analyzePhoto, analyzeVideo, assessFileRisk } from "./media.js";
import { detectGender } from "./gender.js";
import { registerOwnerReply, isHumanTakeover, clearAutoTakeover, isChatPaused,
         activeTakeoverCount,
  pauseChat, resumeChat, listPausedChats, listActiveTakeovers
} from "./takeover.js";
import { getOrProvisionUserSheet, isAdmin } from "./registry.js";
import { getAdminPrompt, DEFAULT_SYSTEM_PROMPT } from "./adminPrompt.js";
import { initDb } from "./db.js";

// ─── Startup ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌  TELEGRAM_BOT_TOKEN is not set. Exiting.");
  process.exit(1);
}

// DEFAULT_SYSTEM_PROMPT is the platform-level fallback.
// Each admin overrides this via their own Prompts sheet.
console.log("✅  Bot starting — per-admin prompts and keywords stored in PostgreSQL.");

const bot = new Bot(BOT_TOKEN);

// ─── Startup anti-replay guard ───────────────────────────────────────────────
// Prevents the bot from replaying old pending updates after restart.
const PROCESS_STARTED_AT_UNIX = Math.floor(Date.now() / 1000);
const IGNORE_OLD_UPDATES_ON_START =
  (process.env.IGNORE_OLD_UPDATES_ON_START ?? "true").toLowerCase() !== "false";
const OLD_UPDATE_GRACE_SECONDS = parseInt(
  process.env.OLD_UPDATE_GRACE_SECONDS ?? "5",
  10
);
const DROP_PENDING_UPDATES =
  (process.env.DROP_PENDING_UPDATES ?? "true").toLowerCase() !== "false";

function isStaleMessageDate(messageDateUnix: number): boolean {
  if (!IGNORE_OLD_UPDATES_ON_START) return false;
  return messageDateUnix < PROCESS_STARTED_AT_UNIX - OLD_UPDATE_GRACE_SECONDS;
}

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

/**
 * Build a gender-aware system prompt addition for AI calls.
 * If gender is unknown we send the base prompt unchanged.
 */
function withGenderCtx(basePrompt: string, gender: string): string {
  return gender === "未知"
    ? basePrompt
    : `${basePrompt}\n\n[当前对话对象性别: ${gender}，请据此调整称谓与语气]`;
}

/**
 * Check that the sender is a registered platform admin.
 * Replies with an error and returns false if not.
 */
async function requireAdmin(ctx: { from?: { id: number }; reply: (text: string) => Promise<unknown> }): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("⛔ 无法识别用户身份。");
    return false;
  }
  const allowed = await isAdmin(userId);
  if (!allowed) {
    await ctx.reply("⛔ 此功能仅限平台管理员使用。\nThis command is for administrators only.");
    return false;
  }
  return true;
}

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
  upsertConnection(conn);

  if (conn.is_enabled) {
    // ── Admin whitelist check ──────────────────────────────────────────────────────────
    const adminAllowed = await isAdmin(conn.user.id);
    if (!adminAllowed) {
      console.warn(
        `[business] ⛔  userId=${conn.user.id} connected but is NOT in Admins whitelist — ignoring.`
      );
      return;
    }
    console.log(`[business] ✅  Admin connected  id=${conn.id}  userId=${conn.user.id}`);
    // Pre-provision admin spreadsheet so first message is faster
    void getOrProvisionUserSheet(
      conn.user.id,
      conn.user.username ?? "",
      conn.user.first_name ?? ""
    );
  } else {
    console.log(`[business] ⚠️  Connection disabled  id=${conn.id}  userId=${conn.user.id}`);
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

  // Ignore backlog messages sent before this process started.
  if (isStaleMessageDate(msg.date)) {
    console.log(
      `[startup-guard] ⏭ Skipped stale business message  chat=${msg.chat.id}  msgDate=${msg.date}`
    );
    return;
  }

  // business_connection_id is always present on business_message updates
  const connectionId = msg.business_connection_id!;

  // ── Rights check ──────────────────────────────────────────────────────────
  if (!canReply(connectionId)) {
    console.log(
      `[business] 👁  Read-only connection=${connectionId} — message logged, no reply sent`
    );
    return;
  }

  // ── Only handle 1-on-1 private chats ────────────────────────────────────────
  if (msg.chat.type !== "private") {
    console.log(
      `[business] ⏭️  Ignoring non-private chat type=${msg.chat.type}  conn=${connectionId}`
    );
    return;
  }

  // ── Sender identity gate ───────────────────────────────────────────────────
  // Every message MUST have a known sender (msg.from). Without it we cannot
  // distinguish owner-sent from customer-sent, so we skip entirely.
  if (!msg.from) {
    console.log(`[business] ⏭️  No sender (msg.from missing)  conn=${connectionId} — skipped`);
    return;
  }

  // ── Owner lookup ──────────────────────────────────────────────────────────
  // After a bot restart the in-memory connection cache is empty.
  // We try to restore it via getBotBusinessConnection before giving up.
  let ownerUserId = getOwnerUserId(connectionId);
  if (ownerUserId === undefined) {
    try {
      const fetchedConn = await bot.api.getBusinessConnection(connectionId);
      upsertConnection(fetchedConn);
      ownerUserId = fetchedConn.user.id;
      console.log(`[business] 🔄 Restored connection from API  conn=${connectionId}  owner=${ownerUserId}`);
    } catch (err) {
      console.warn(
        `[business] ⚠️  Could not restore connection conn=${connectionId}:`,
        (err as Error).message
      );
      return;
    }
  }

  // ── Owner self-message check ───────────────────────────────────────────────
  // The bot receives the owner's OWN outgoing messages as business_message
  // updates. We MUST NOT auto-reply to them (loop + duplicate visible to customer).
  // Log as OUT for CRM completeness, then return immediately.

  // Resolve admin's spreadsheet (needed by both the log block and the AI block below)
  const ownerSsId = await getOrProvisionUserSheet(ownerUserId) ?? "";

  // Load admin's custom system prompt (needed for customer AI replies below)
  const adminSystemPrompt = await getAdminPrompt(ownerSsId);

  if (msg.from.id === ownerUserId) {
    console.log(
      `[business] 🙋  Owner manual reply  conn=${connectionId}  "${msg.text?.slice(0, 60) ?? "[non-text]"}"`
    );
    // Register the manual reply → activates / resets takeover TTL for this chat
    registerOwnerReply(connectionId, msg.chat.id);
    // Determine what the owner actually sent so the log is descriptive
    let ownerMsgText: string;
    if (msg.text) {
      ownerMsgText = msg.text.trim();
    } else if (msg.voice) {
      ownerMsgText = `[语音消息 ${msg.voice.duration}秒]`;
    } else if (msg.audio) {
      ownerMsgText = `[音频: ${msg.audio.file_name ?? "audio"} ${msg.audio.duration}秒]`;
    } else if (msg.photo) {
      ownerMsgText = "[图片消息]";
    } else if (msg.video) {
      ownerMsgText = `[视频 ${msg.video.duration}秒]`;
    } else if (msg.video_note) {
      ownerMsgText = `[视频留言 ${msg.video_note.duration}秒]`;
    } else if (msg.document) {
      ownerMsgText = `[文件: ${msg.document.file_name ?? "unknown"}]`;
    } else if (msg.sticker) {
      ownerMsgText = `[贴纸: ${msg.sticker.emoji ?? "sticker"}]`;
    } else {
      ownerMsgText = "[非文字消息]";
    }
    // Log owner's outgoing message for CRM completeness — no auto-reply
    void logMessage({
      direction: "发消息",
      customerId: msg.chat.id,
      customerName: buildCustomerName(msg.chat),
      connectionId,
      text: ownerMsgText,
      replyType: "人工回复",
    }, ownerSsId);
    return; // ← bot never auto-replies to owner's own messages
  }

  // ── Build customer display name & conversation key ─────────────────────────
  const customerName = buildCustomerName(msg.chat);
  // key is needed by all AI-calling branches below
  const key = businessKey(connectionId, msg.chat.id);

  // ── Multimodal media dispatch ─────────────────────────────────────────────

  // ── Voice / Audio ──────────────────────────────────────────────────────────
  if (msg.voice || msg.audio) {
    const mediaFile = msg.voice ?? msg.audio!;
    const mediaType = msg.voice ? "语音" : "音频";
    const duration = (mediaFile as { duration?: number }).duration ?? 0;
    void logMessage({
      direction: "来消息", customerId: msg.chat.id, customerName, connectionId,
      text: `[${mediaType}消息 ${duration}秒]`, replyType: "",
    }, ownerSsId);
    try {
      await ctx.api.sendChatAction(msg.chat.id, "typing", { business_connection_id: connectionId });
      const transcription = await transcribeVoice(mediaFile.file_id, BOT_TOKEN);
      console.log(`[media] 🎤 chat=${msg.chat.id}: "${transcription.slice(0, 80)}"`);
      if (!transcription.trim()) {
        const noAudio = "抱歉，无法识别语音内容，请重新发送或用文字说明。\nSorry, could not transcribe audio. Please resend or type your message.";
        await ctx.api.sendMessage(msg.chat.id, noAudio, { business_connection_id: connectionId });
        return;
      }
      const kwMatch = await findKeywordReply(transcription, ownerSsId);
      if (kwMatch !== null) {
        await sleep(BOT_REPLY_DELAY_MS);
        if (isHumanTakeover(connectionId, msg.chat.id)) { clearAutoTakeover(connectionId, msg.chat.id); return; }
        if (kwMatch.audioUrl) {
          await ctx.api.sendVoice(msg.chat.id, kwMatch.audioUrl, { business_connection_id: connectionId });
          void logMessage({ direction: "发消息", customerId: msg.chat.id, customerName, connectionId, text: `[语音回复] ${kwMatch.reply}`, replyType: "预设回复" }, ownerSsId);
        } else {
          await ctx.api.sendMessage(msg.chat.id, kwMatch.reply, { business_connection_id: connectionId });
          void logMessage({ direction: "发消息", customerId: msg.chat.id, customerName, connectionId, text: kwMatch.reply, replyType: "预设回复" }, ownerSsId);
        }
        return;
      }
      const gender = await detectGender(msg.chat);
      const aiReply = await chat(key, `[语音转文字] ${transcription}`, withGenderCtx(adminSystemPrompt, gender));
      await sleep(BOT_REPLY_DELAY_MS);
      if (isHumanTakeover(connectionId, msg.chat.id)) { clearAutoTakeover(connectionId, msg.chat.id); return; }
      await ctx.api.sendMessage(msg.chat.id, aiReply, { business_connection_id: connectionId });
      void logMessage({ direction: "发消息", customerId: msg.chat.id, customerName, connectionId, text: aiReply, replyType: "AI回复" }, ownerSsId);
    } catch (err) {
      handleBusinessApiError(err, connectionId);
      try { await ctx.api.sendMessage(msg.chat.id, "⚠️ 语音处理失败，请重试。\nVoice processing failed, please try again.", { business_connection_id: connectionId }); } catch { /* ignore */ }
    }
    return;
  }

  // ── Photo ──────────────────────────────────────────────────────────────────
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    void logMessage({ direction: "来消息", customerId: msg.chat.id, customerName, connectionId, text: "[图片消息]", replyType: "" }, ownerSsId);
    try {
      await ctx.api.sendChatAction(msg.chat.id, "typing", { business_connection_id: connectionId });
      const visionPrompt = adminSystemPrompt +
        "\n\n客户发送了这张图片。请分析图片内容，判断它是否与商业和你的服务范围相关。" +
        "如果关联请给出回应；如果看不出客户意图，请礼貌询问。请简洁自然。";
      const imageDesc = await analyzePhoto(largest.file_id, BOT_TOKEN, visionPrompt);
      const aiReply = await chat(key, `[图片内容] ${imageDesc}`, withGenderCtx(adminSystemPrompt, await detectGender(msg.chat)));
      await sleep(BOT_REPLY_DELAY_MS);
      if (isHumanTakeover(connectionId, msg.chat.id)) { clearAutoTakeover(connectionId, msg.chat.id); return; }
      await ctx.api.sendMessage(msg.chat.id, aiReply, { business_connection_id: connectionId });
      void logMessage({ direction: "发消息", customerId: msg.chat.id, customerName, connectionId, text: aiReply, replyType: "AI回复" }, ownerSsId);
    } catch (err) {
      handleBusinessApiError(err, connectionId);
      try { await ctx.api.sendMessage(msg.chat.id, "⚠️ 图片分析失败，请重试。\nImage analysis failed, please try again.", { business_connection_id: connectionId }); } catch { /* ignore */ }
    }
    return;
  }

  // ── Video / Video Note ─────────────────────────────────────────────────────
  if (msg.video || msg.video_note) {
    const thumbFileId =
      msg.video?.thumbnail?.file_id ?? msg.video_note?.thumbnail?.file_id;
    void logMessage({ direction: "来消息", customerId: msg.chat.id, customerName, connectionId, text: "[视频消息]", replyType: "" }, ownerSsId);
    try {
      await ctx.api.sendChatAction(msg.chat.id, "typing", { business_connection_id: connectionId });
      const visionPrompt = adminSystemPrompt +
        "\n\n客户发送了一段视频。" +
        "请判断视频内容是否与商业和你的服务范围相关。如果相关请给出回应；如果无法判断客户意图请礼貌询问。请简洁自然。";
      const videoDesc = await analyzeVideo(thumbFileId, BOT_TOKEN, visionPrompt);
      const aiReply = await chat(key, `[视频内容] ${videoDesc}`, withGenderCtx(adminSystemPrompt, await detectGender(msg.chat)));
      await sleep(BOT_REPLY_DELAY_MS);
      if (isHumanTakeover(connectionId, msg.chat.id)) { clearAutoTakeover(connectionId, msg.chat.id); return; }
      await ctx.api.sendMessage(msg.chat.id, aiReply, { business_connection_id: connectionId });
      void logMessage({ direction: "发消息", customerId: msg.chat.id, customerName, connectionId, text: aiReply, replyType: "AI回复" }, ownerSsId);
    } catch (err) {
      handleBusinessApiError(err, connectionId);
      try { await ctx.api.sendMessage(msg.chat.id, "⚠️ 视频处理失败，请重试。\nVideo processing failed, please try again.", { business_connection_id: connectionId }); } catch { /* ignore */ }
    }
    return;
  }

  // ── Document / File (metadata only — never downloaded) ────────────────────
  if (msg.document) {
    const doc = msg.document;
    void logMessage({ direction: "来消息", customerId: msg.chat.id, customerName, connectionId, text: `[文件: ${doc.file_name ?? "unknown"}]`, replyType: "" }, ownerSsId);
    const assessment = assessFileRisk({
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      file_size: doc.file_size,
    });
    try {
      await sleep(BOT_REPLY_DELAY_MS);
      if (isHumanTakeover(connectionId, msg.chat.id)) { clearAutoTakeover(connectionId, msg.chat.id); return; }
      await ctx.api.sendMessage(msg.chat.id, assessment, { business_connection_id: connectionId });
      void logMessage({ direction: "发消息", customerId: msg.chat.id, customerName, connectionId, text: assessment, replyType: "AI回复" }, ownerSsId);
    } catch (err) {
      handleBusinessApiError(err, connectionId);
    }
    return;
  }

  // ── Text (falls through multimodal dispatch) ───────────────────────────────
  const text = msg.text?.trim();

  if (!text) {
    // Unsupported media type (sticker, contact, location, etc.)
    void logMessage({ direction: "来消息", customerId: msg.chat.id, customerName, connectionId, text: "[其他类型消息]", replyType: "" }, ownerSsId);
    const unsupportedReply =
      "抱歉，我暂时无法处理这种类型的消息，请用文字描述您的需求。😊\n" +
      "Sorry, I can't process this message type. Please describe your needs in text. 😊";
    try {
      await ctx.api.sendMessage(msg.chat.id, unsupportedReply, { business_connection_id: connectionId });
    } catch (err) {
      handleBusinessApiError(err, connectionId);
    }
    return;
  }

  // key already declared above (hoisted before multimodal dispatch)
  console.log(
    `[business] 📨  conn=${connectionId}  customer=${msg.chat.id}  "${text.slice(0, 60)}"`
  );

  // ── Log the incoming customer message (fire-and-forget) ────────────────────
  void logMessage({
    direction: "来消息",
    customerId: msg.chat.id,
    customerName,
    connectionId,
    text,
    replyType: "",
  }, ownerSsId);

  // ── Human takeover check (explicit /pause lock only) ────────────────────────
  // AUTO takeover is checked AFTER the grace period below.
  // This early check only blocks chats explicitly locked via /pause.
  if (isChatPaused(msg.chat.id)) {
    console.log(
      `[takeover] 🔒  Chat locked (/pause)  conn=${connectionId}  chat=${msg.chat.id} — skipping auto-reply`
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
    const kwMatch = await findKeywordReply(text, ownerSsId);

    if (kwMatch !== null) {
      // Keyword matched — apply grace-period delay then re-check takeover
      await sleep(BOT_REPLY_DELAY_MS);
      if (isHumanTakeover(connectionId, msg.chat.id)) {
        console.log(`[takeover] 🤫  Aborted keyword reply  conn=${connectionId}  chat=${msg.chat.id}`);
        clearAutoTakeover(connectionId, msg.chat.id);
        return;
      }
      // Send the preset reply — text or pre-recorded voice
      if (kwMatch.audioUrl) {
        await ctx.api.sendVoice(msg.chat.id, kwMatch.audioUrl, {
          business_connection_id: connectionId,
        });
        void logMessage({
          direction: "发消息", customerId: msg.chat.id, customerName, connectionId,
          text: `[语音回复] ${kwMatch.reply}`, replyType: "预设回复",
        }, ownerSsId);
      } else {
        await ctx.api.sendMessage(msg.chat.id, kwMatch.reply, {
          business_connection_id: connectionId,
        });
        void logMessage({
          direction: "发消息", customerId: msg.chat.id, customerName, connectionId,
          text: kwMatch.reply, replyType: "预设回复",
        }, ownerSsId);
      }
      return;
    }

    // ── Step 2: No keyword match — let AI handle the message ─────────────────
    const gender = await detectGender(msg.chat);
    const aiReply = await chat(key, text, withGenderCtx(adminSystemPrompt, gender));
    // Apply grace-period delay then re-check takeover before sending
    await sleep(BOT_REPLY_DELAY_MS);
    if (isHumanTakeover(connectionId, msg.chat.id)) {
      console.log(`[takeover] \ud83e\udd2b  Aborted AI reply  conn=${connectionId}  chat=${msg.chat.id}`);      clearAutoTakeover(connectionId, msg.chat.id);      return;
    }
    await ctx.api.sendMessage(msg.chat.id, aiReply, {
      business_connection_id: connectionId,
    });
    void logMessage({
      direction: "发消息",
      customerId: msg.chat.id,
      customerName,
      connectionId,
      text: aiReply,
      replyType: "AI回复",
    }, ownerSsId);
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
  if (!(await requireAdmin(ctx))) return;
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
  if (!(await requireAdmin(ctx))) return;
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
  if (!(await requireAdmin(ctx))) return;
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
  if (!(await requireAdmin(ctx))) return;
  const paused    = listPausedChats();
  const autoActive = listActiveTakeovers().filter((t) => !t.locked);

  const lines: string[] = ["*🤖 Bot Takeover Status*\n"];

  if (paused.length === 0 && autoActive.length === 0) {
    lines.push("✅ 所有对话均处于自动回复模式（无接管）");
  } else {
    if (paused.length > 0) {
      lines.push(`🔒 *永久暂停* (${paused.length})`);
      for (const id of paused) {
        lines.push(`  • chatId \`${id}\` — /resume ${id}`);
      }
    }
    if (autoActive.length > 0) {
      lines.push(`\n🙋 *临时接管中* (下一条消息自动恢复) (${autoActive.length})`);
      for (const t of autoActive) {
        lines.push(`  • chatId \`${t.chatId}\` conn \`${t.connectionId.slice(0, 8)}\``);
      }
    }
  }

  lines.push(`\n⏱ 回复延迟: ${BOT_REPLY_DELAY_MS / 1000}s | 接管模式: 每条消息独立`);
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "🤖 *zznet 客服机器人 / Support Bot*\n\n" +
      "• 直接发送消息提问 / Just send a message to ask\n" +
      "• /reset — 清除对话历史 / Clear conversation history\n" +
      "• /login — 获取关键词管理登录链接 / Get keyword manager login link\n" +
      "• /help — 显示此帮助 / Show this help\n\n" +
      "💼 *Telegram Business 连接方式：*\n" +
      "设置 → Telegram Business → 聊天机器人\n" +
      "Settings → Telegram Business → Chatbots",
    { parse_mode: "Markdown" }
  );
});

bot.command("login", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const miniAppUrl = process.env.MINI_APP_URL?.trim();
  if (!miniAppUrl) {
    await ctx.reply(
      "⚠️ 管理面板尚未配置，请联系管理员设置 MINI_APP_URL。\n" +
      "Admin panel is not configured. Please set MINI_APP_URL."
    );
    return;
  }
  await ctx.reply(
    "🛠 点击下方按钮打开关键词管理面板\nClick the button below to open the admin panel:",
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🛠 打开管理面板", web_app: { url: miniAppUrl } },
        ]],
      },
    }
  );
});

bot.on("message:text", async (ctx) => {
  // Private-only: reject group and channel messages
  if (ctx.chat.type !== "private") return;

  // Only registered admins can DM the bot directly
  if (!(await requireAdmin(ctx))) return;

  if (isStaleMessageDate(ctx.message.date)) {
    console.log(
      `[startup-guard] ⏭ Skipped stale direct message  chat=${ctx.chat.id}  msgDate=${ctx.message.date}`
    );
    return;
  }

  const text = ctx.message.text.trim();
  if (!text) return;

  const key = directKey(ctx.chat.id);
  await ctx.replyWithChatAction("typing");

  try {
    // ── Step 1: Check Google Sheets for a preset keyword reply ───────────────
    const kwMatch = await findKeywordReply(text, ""); // no owner context in direct messages
    if (kwMatch !== null) {
      if (kwMatch.audioUrl) {
        await ctx.replyWithVoice(kwMatch.audioUrl);
      } else {
        await ctx.reply(kwMatch.reply);
      }
      return;
    }

    // ── Step 2: No keyword match — AI handles the message ────────────────────
    const aiReply = await chat(key, text, DEFAULT_SYSTEM_PROMPT);
    await ctx.reply(aiReply);
  } catch (err) {
    console.error(`[direct] Error  chat=${ctx.chat.id}:`, err);
    await ctx.reply(
      "⚠️ 抱歉，处理您的请求时出现了错误，请稍后重试。\n" +
        "Sorry, something went wrong. Please try again shortly."
    );
  }
});

bot.on("message", async (ctx) => {  // Only respond in private chats; silently ignore groups/channels
  if (ctx.chat.type !== "private") return;  await ctx.reply(
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

// Graceful shutdown: when Railway stops the old container (SIGTERM) we must
// stop polling immediately so the NEW container can take over without 409.
process.once("SIGTERM", () => {
  console.log("[bot] 🛑  SIGTERM received — stopping gracefully…");
  bot.stop().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  console.log("[bot] 🛑  SIGINT received — stopping gracefully…");
  bot.stop().finally(() => process.exit(0));
});

/**
 * Railway rolling deployments briefly run two containers simultaneously.
 * The new container gets a 409 from Telegram (old one still polling).
 * We retry with backoff until the old instance is killed (~30 s max wait).
 */
async function startWithRetry(
  maxAttempts = 8,
  backoffMs = 5000
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.start({
        drop_pending_updates: DROP_PENDING_UPDATES,
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
          console.log(`    Sheets : ${isSheetsEnabled() ? "✅ PostgreSQL keyword lookup enabled" : "⚠️  Disabled (set DATABASE_URL)"}`);
          console.log(`    Takeover: per-message (active paused sessions: ${activeTakeoverCount()})`);
          console.log(
            `    Startup guard: ${IGNORE_OLD_UPDATES_ON_START ? "ON" : "OFF"} | ` +
            `grace=${OLD_UPDATE_GRACE_SECONDS}s | drop_pending_updates=${DROP_PENDING_UPDATES}`
          );
          console.log("    Modes  : Direct bot + Telegram Business chatbot\n");

          // Auto-set the bot's default menu button to open the Mini App
          const miniAppUrl = process.env.MINI_APP_URL?.trim();
          if (miniAppUrl) {
            bot.api.setChatMenuButton({
              menu_button: { type: "web_app", text: "🛠 管理面板", web_app: { url: miniAppUrl } },
            }).then(() => {
              console.log(`[bot] ✅ Menu button → Mini App (${miniAppUrl})`);
            }).catch((err: Error) => {
              console.warn("[bot] ⚠️ Could not set menu button:", err.message);
            });
          }
        },
      });
      return; // clean exit after bot.stop() is called
    } catch (err) {
      const is409 =
        err instanceof GrammyError && err.error_code === 409;
      if (is409 && attempt < maxAttempts) {
        console.warn(
          `[bot] ⚠️  409 Conflict — another instance is still running. ` +
          `Retrying in ${backoffMs / 1000}s… (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        // Increase backoff slightly on each retry
        backoffMs = Math.min(backoffMs * 1.5, 30_000);
      } else {
        // Not a 409, or we've exhausted retries — crash loudly so Railway restarts us
        console.error("[bot] ❌  Fatal error during bot.start():", err);
        process.exit(1);
      }
    }
  }
  console.error("[bot] ❌  Could not connect after max retries — exiting.");
  process.exit(1);
}

import { startServer } from "./server.js";

// Initialize PostgreSQL schema then start server and bot
void initDb().then(() => {
  startServer();
  void startWithRetry();
}).catch(err => {
  console.error("[db] ❌ Failed to initialize database:", err);
  process.exit(1);
});


