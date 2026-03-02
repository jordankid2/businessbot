/**
 * Chat Logger — Google Sheets
 *
 * Appends every business chat message (IN and OUT) to a "Logs" sheet.
 * The sheet is created automatically with headers if it doesn't exist yet.
 *
 * ─── Logs sheet columns ───────────────────────────────────────────────────────
 *  A  时间          Full timestamp  e.g. 2026-03-03 14:25:36  (GMT+8)
 *  B  方向          IN  = customer → us
 *                   OUT = us → customer
 *  C  客户ID        Telegram chat.id of the customer
 *  D  客户名        first_name + last_name / username (best effort)
 *  E  连接ID        business_connection_id (shortened to 8 chars for readability)
 *  F  消息内容      The actual message text
 *  G  回复类型      (OUT only) 预设关键词 | AI生成 | 系统消息
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Logging is FIRE-AND-FORGET — errors are caught and printed but never thrown,
 * so a Sheets issue never blocks or delays the bot's reply to the customer.
 */

import { google, sheets_v4 } from "googleapis";
import { getGoogleAuth, isGoogleConfigured } from "./gauth.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const LOGS_SHEET_NAME = "Logs";
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID ?? "";
const TIMEZONE = "Asia/Kuala_Lumpur"; // GMT+8

// ─── Types ────────────────────────────────────────────────────────────────────

export type Direction = "IN" | "OUT";
export type ReplyType = "预设关键词" | "AI生成" | "系统消息" | "人工回复" | "";

export interface LogEntry {
  direction: Direction;
  customerId: number;
  customerName: string;
  connectionId: string;
  text: string;
  replyType?: ReplyType; // only meaningful for OUT
}

// ─── Module state ─────────────────────────────────────────────────────────────

let sheetsClient: sheets_v4.Sheets | null = null;
let logsSheetEnsured = false; // true once we've verified/created the sheet

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getClient(): sheets_v4.Sheets | null {
  if (sheetsClient) return sheetsClient;
  const auth = getGoogleAuth();
  if (!auth) return null;
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/** Format a Date as "YYYY-MM-DD HH:mm:ss" in GMT+8. */
function formatTimestamp(date: Date): string {
  return date.toLocaleString("zh-CN", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).replace(/\//g, "-");
}

/** Shorten connection ID to first 8 chars to keep cells readable. */
function shortConn(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

// ─── Sheet setup ──────────────────────────────────────────────────────────────

/**
 * Ensure the "Logs" sheet exists. If not, create it and write the header row.
 * Result is cached so this only hits the API once per bot session.
 */
async function ensureLogsSheet(client: sheets_v4.Sheets): Promise<void> {
  if (logsSheetEnsured) return;

  // Fetch all sheet metadata
  const meta = await client.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties.title",
  });

  const titles = (meta.data.sheets ?? []).map(
    (s) => s.properties?.title ?? ""
  );

  if (!titles.includes(LOGS_SHEET_NAME)) {
    // Create the Logs sheet
    await client.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: LOGS_SHEET_NAME,
                gridProperties: { frozenRowCount: 1 },
              },
            },
          },
        ],
      },
    });

    // Write header row
    await client.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LOGS_SHEET_NAME}!A1:G1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          "时间",
          "方向",
          "客户ID",
          "客户名",
          "连接ID",
          "消息内容",
          "回复类型",
        ]],
      },
    });

    console.log(`[logger] ✅ Created "${LOGS_SHEET_NAME}" sheet with headers.`);
  }

  logsSheetEnsured = true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append one row to the Logs sheet.
 * This function is FIRE-AND-FORGET — call without await to avoid blocking.
 */
export async function logMessage(entry: LogEntry): Promise<void> {
  if (!isGoogleConfigured()) return;

  const client = getClient();
  if (!client) return;

  try {
    await ensureLogsSheet(client);

    const timestamp = formatTimestamp(new Date());
    const row = [
      timestamp,
      entry.direction,
      String(entry.customerId),
      entry.customerName,
      shortConn(entry.connectionId),
      entry.text,
      entry.replyType ?? "",
    ];

    await client.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LOGS_SHEET_NAME}!A:G`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    console.log(
      `[logger] 📝 ${entry.direction}  customer=${entry.customerId}  "${entry.text.slice(0, 40)}"`
    );
  } catch (err) {
    // Never let logging errors affect the bot
    console.error("[logger] ⚠️ Failed to write log row:", err);
  }
}

/**
 * Build a display name from Telegram user/chat fields.
 * Falls back gracefully through: full name → username → chat id.
 */
export function buildCustomerName(chat: {
  first_name?: string;
  last_name?: string;
  username?: string;
  id: number;
}): string {
  const parts = [chat.first_name, chat.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (chat.username) return `@${chat.username}`;
  return `id:${chat.id}`;
}
