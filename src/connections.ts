/**
 * Business Connection Cache
 *
 * Stores the BusinessConnection object received from `business_connection`
 * updates so that message handlers can check rights without extra API calls.
 *
 * Actual Bot API / Grammy `BusinessConnection` shape (Bot API 9.x):
 *   .id             – unique connection identifier (string)
 *   .user           – User object of the business account owner
 *   .user_chat_id   – private chat id with the owner
 *   .date           – unix timestamp of connection creation
 *   .rights?        – BusinessBotRights (optional)
 *     .can_reply?          – bot may send messages on behalf of user
 *     .can_read_messages?  – bot may mark messages as read
 *     .can_delete_outgoing_messages? – bot may delete its own messages
 *     .can_delete_all_messages?      – bot may delete any messages
 *   .is_enabled     – false → paused or removed by the business owner
 *
 * Reference: https://core.telegram.org/api/bots/connected-business-bots
 */

import type { BusinessConnection } from "grammy/types";

// Map connection_id → BusinessConnection
const cache = new Map<string, BusinessConnection>();

/** Upsert (or remove) a connection in the cache. */
export function upsertConnection(conn: BusinessConnection): void {
  if (conn.is_enabled) {
    cache.set(conn.id, conn);
    console.log(
      `[conn] ✅ Cached  id=${conn.id}  owner=${conn.user.id}  can_reply=${conn.rights?.can_reply ?? false}`
    );
  } else {
    // is_enabled=false means the business account paused or removed the bot
    cache.delete(conn.id);
    console.log(`[conn] ❌ Removed  id=${conn.id} (is_enabled=false)`);
  }
}

/** Return true if the bot is allowed to reply over this connection. */
export function canReply(connectionId: string): boolean {
  const conn = cache.get(connectionId);
  if (!conn) {
    // Connection not yet seen (e.g. bot restarted while users were connected).
    // Per the spec, the bot should call getBotBusinessConnection to re-fetch,
    // but we conservatively allow the reply and let the API reject if not allowed.
    return true;
  }
  return (conn.rights?.can_reply === true) && conn.is_enabled;
}

/** Fetch cached connection info, or undefined if not yet seen. */
export function getConnection(connectionId: string): BusinessConnection | undefined {
  return cache.get(connectionId);
}

/**
 * Return the business account owner's Telegram user ID for a given connection.
 * Used to detect when the owner types manually (so the bot doesn't auto-reply).
 * Returns undefined if the connection hasn't been cached yet.
 */
export function getOwnerUserId(connectionId: string): number | undefined {
  return cache.get(connectionId)?.user.id;
}
