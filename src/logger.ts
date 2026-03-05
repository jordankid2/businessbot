/**
 * Message logger -- PostgreSQL-backed
 */
import pool from "./db.js";

export type Direction = "\u6765\u6d88\u606f" | "\u53d1\u6d88\u606f";
export type ReplyType = "\u9884\u8bbe\u56de\u590d" | "AI\u56de\u590d" | "\u4eba\u5de5\u56de\u590d" | "";

export interface LogEntry {
  direction: Direction;
  customerId: number;
  customerName: string;
  connectionId: string;
  text: string;
  replyType: ReplyType;
}

export function buildCustomerName(
  chatOrFirstName?: string | { first_name?: string; last_name?: string; username?: string },
  lastName?: string,
  username?: string
): string {
  if (chatOrFirstName && typeof chatOrFirstName === "object") {
    const c = chatOrFirstName;
    const full = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    return full || (c.username ? "@" + c.username : "Unknown");
  }
  const full = [chatOrFirstName, lastName].filter(Boolean).join(" ").trim();
  return full || (username ? "@" + username : "Unknown");
}

export function logMessage(entry: LogEntry, ownerKey: string): void {
  if (!process.env.DATABASE_URL || !ownerKey) return;
  const userId = parseInt(ownerKey, 10);
  if (isNaN(userId)) return;
  pool.query(
    `INSERT INTO logs(user_id, direction, customer_id, customer_name, connection_id, message, reply_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, entry.direction, entry.customerId, entry.customerName,
     entry.connectionId, entry.text, entry.replyType]
  ).catch(err => console.warn("[logger] insert failed:", (err as Error).message));
}
