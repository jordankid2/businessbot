/**
 * Human Takeover Manager
 *
 * Tracks which business chats are being handled manually by the owner.
 * While a chat is in "takeover" mode the bot will NOT auto-reply.
 *
 * ─── Two takeover modes ────────────────────────────────────────────────────────
 *
 * 1. AUTO (TTL-based, sliding window)
 *    Triggered automatically when the owner sends a manual reply.
 *    Expires after TAKEOVER_TTL_MS of owner inactivity (default 10 min).
 *    Every additional manual message resets the timer.
 *
 * 2. LOCKED (explicit, indefinite)
 *    Triggered by /pause <chatId> command sent directly to the bot.
 *    Never expires on its own — must be cleared with /resume <chatId>.
 *    Use this when you want to have a full manual conversation without
 *    the bot occasionally jumping back in.
 *
 * ─── Reply-Delay grace period ─────────────────────────────────────────────────
 *
 * BOT_REPLY_DELAY_MS (default 3000 ms) is applied in bot.ts BEFORE the
 * computed reply is sent. During this window the owner can start typing and
 * actually send a message — which sets the takeover flag — so the bot's
 * scheduled reply is aborted.  This directly closes the race condition where:
 *   customer msg → bot starts AI (1-3 s) → owner starts typing simultaneously.
 *
 * ─── Typing detection ─────────────────────────────────────────────────────────
 *
 * The standard Telegram Bot API does NOT forward "typing…" indicators from
 * other users/owners to bots.  Bots can only SEND sendChatAction; they cannot
 * RECEIVE chatAction events.  The reply-delay + TTL combination is therefore
 * the best achievable approximation without a full MTProto userbot.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

/** How long after the owner's last manual reply before the bot resumes. */
export const TAKEOVER_TTL_MS = parseInt(
  process.env.TAKEOVER_TTL_MS ?? String(10 * 60 * 1000),
  10
);

// ─── State ────────────────────────────────────────────────────────────────────

interface TakeoverEntry {
  /** Unix timestamp of last manual owner message. */
  lastOwnerReplyAt: number;
  /**
   * When true the takeover is explicitly locked via /pause command.
   * TTL is ignored — the chat stays in takeover until /resume is sent.
   */
  locked: boolean;
}

// Key: "<connectionId>:<chatId>"
const takeoverMap = new Map<string, TakeoverEntry>();

// Global explicit pauses by chatId (set via /pause command, no connectionId needed)
const pausedChats = new Set<number>();

function makeKey(connectionId: string, chatId: number): string {
  return `${connectionId}:${chatId}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a manual owner reply (AUTO mode).
 * Call this whenever a business_message arrives from the owner.
 * Resets the TTL timer. Preserves locked state if already locked.
 */
export function registerOwnerReply(connectionId: string, chatId: number): void {
  const key = makeKey(connectionId, chatId);
  const existing = takeoverMap.get(key);
  takeoverMap.set(key, {
    lastOwnerReplyAt: Date.now(),
    locked: existing?.locked ?? false,   // preserve explicit lock
  });
  const mode = existing?.locked ? "LOCKED" : "AUTO TTL";
  console.log(
    `[takeover] 🙋 Human takeover active [${mode}]  conn=${connectionId}  chat=${chatId}  ` +
    `(TTL resets to ${TAKEOVER_TTL_MS / 60000} min)`
  );
}

/**
 * Explicitly lock a chat in takeover mode (LOCKED mode).
 * Call this via /pause <chatId> command.
 * The chat stays locked until releaseTakeover() is called.
 */
export function lockTakeover(connectionId: string, chatId: number): void {
  const key = makeKey(connectionId, chatId);
  takeoverMap.set(key, {
    lastOwnerReplyAt: Date.now(),
    locked: true,
  });
  console.log(
    `[takeover] 🔒 Takeover LOCKED  conn=${connectionId}  chat=${chatId}  (use /resume to unlock)`
  );
}

/**
 * Returns true if the bot should defer to the human for this chat.
 *
 * A chat is in takeover when:
 *   - LOCKED mode: locked=true (indefinite, ignores TTL)
 *   - AUTO mode: owner replied within TAKEOVER_TTL_MS
 */
export function isHumanTakeover(connectionId: string, chatId: number): boolean {
  // Global pause always wins (no TTL)
  if (pausedChats.has(chatId)) return true;

  const key = makeKey(connectionId, chatId);
  const entry = takeoverMap.get(key);
  if (!entry) return false;

  // LOCKED mode — never expires automatically
  if (entry.locked) return true;

  // AUTO mode — check TTL
  const elapsed = Date.now() - entry.lastOwnerReplyAt;
  if (elapsed > TAKEOVER_TTL_MS) {
    takeoverMap.delete(key);
    console.log(
      `[takeover] ⏱  Auto-TTL expired  conn=${connectionId}  chat=${chatId}  → bot resumes`
    );
    return false;
  }

  return true;
}

/**
 * Release takeover for a chat (both AUTO and LOCKED modes).
 * Call this via /resume <chatId> command, or to force-resume programmatically.
 */
export function releaseTakeover(connectionId: string, chatId: number): void {
  const key = makeKey(connectionId, chatId);
  const existed = takeoverMap.has(key);
  takeoverMap.delete(key);
  if (existed) {
    console.log(`[takeover] ✅ Takeover released  conn=${connectionId}  chat=${chatId}  → bot resumes`);
  }
}

/** List all currently active takeovers (for /status command). */
export function listActiveTakeovers(): Array<{
  connectionId: string;
  chatId: number;
  locked: boolean;
  lastOwnerReplyAt: number;
  expiresInMs: number | null;   // null = locked (no expiry)
}> {
  const now = Date.now();
  const result = [];
  for (const [key, entry] of takeoverMap) {
    const [connectionId, chatIdStr] = key.split(":");
    const chatId = parseInt(chatIdStr, 10);
    // Purge expired AUTO entries on the fly
    if (!entry.locked && now - entry.lastOwnerReplyAt > TAKEOVER_TTL_MS) {
      takeoverMap.delete(key);
      continue;
    }
    result.push({
      connectionId,
      chatId,
      locked: entry.locked,
      lastOwnerReplyAt: entry.lastOwnerReplyAt,
      expiresInMs: entry.locked
        ? null
        : TAKEOVER_TTL_MS - (now - entry.lastOwnerReplyAt),
    });
  }
  return result;
}

/** How many chats are currently under human takeover (for startup log). */
export function activeTakeoverCount(): number {
  return takeoverMap.size + pausedChats.size;
}

// ─── Global Pause (no connectionId required) ──────────────────────────────────
// Used by /pause and /resume commands the owner sends directly to the bot.
// Works independently of the TTL mechanism.

/**
 * Permanently pause bot auto-replies for a customer chat.
 * Use /pause <chatId> to trigger this.
 */
export function pauseChat(chatId: number): void {
  pausedChats.add(chatId);
  console.log(`[takeover] 🔒 Chat ${chatId} PAUSED (indefinite, use /resume to restore)`);
}

/**
 * Resume bot auto-replies for a customer chat.
 * Use /resume <chatId> to trigger this.
 */
export function resumeChat(chatId: number): void {
  const was = pausedChats.delete(chatId);
  console.log(was
    ? `[takeover] ✅ Chat ${chatId} RESUMED → bot will auto-reply again`
    : `[takeover] ℹ️  Chat ${chatId} was not paused`
  );
}

/** Returns true if the chat has been explicitly paused via /pause command. */
export function isChatPaused(chatId: number): boolean {
  return pausedChats.has(chatId);
}

/** Returns chatIds of all explicitly paused chats. */
export function listPausedChats(): number[] {
  return [...pausedChats];
}
