/**
 * Google Sheets Keyword-Reply Lookup
 *
 * Reads a Google Spreadsheet to find preset keyword→reply pairs.
 * If a user's message contains any of the keywords, the preset reply is
 * returned immediately instead of calling the AI.
 *
 * ─── Spreadsheet format ──────────────────────────────────────────────────────
 * Sheet name  : configured via GOOGLE_SHEET_NAME (default "Keywords")
 * Row 1       : header row — skipped automatically
 * Column A    : Keywords (comma-separated; one or more triggers per row)
 * Column B    : Reply text (may be multi-line; use \n in the cell for newlines)
 * Column C    : (optional) Note/label for your reference — ignored by the bot
 *
 * Example rows:
 *   Row 2 | 价格,报价,price,quote | 您好！报价需要了解需求，请描述您的项目。
 *   Row 3 | 联系,contact,联络    | 请通过 Telegram @zznet_support 联系我们。
 *   Row 4 | 时间,deadline,交付   | 小项目3-7天，中型2-4周，大型按里程碑排期。
 *
 * ─── Matching logic ───────────────────────────────────────────────────────────
 * - Case-insensitive
 * - Checks whether any keyword appears as a substring of the user's message
 * - First matching row wins
 *
 * ─── Caching ──────────────────────────────────────────────────────────────────
 * - Rows are cached in memory for SHEETS_CACHE_TTL_MS (default 5 minutes)
 * - On cache miss or expiry, the sheet is re-fetched from Google API
 * - This avoids hitting Google API quota on every incoming message
 *
 * ─── Authentication ───────────────────────────────────────────────────────────
 * Uses a Google Service Account. Two options (checked in order):
 *   1. GOOGLE_SERVICE_ACCOUNT_JSON env var — paste the full JSON content
 *   2. GOOGLE_SERVICE_ACCOUNT_PATH env var — path to the JSON key file
 *
 * The service account must have "Viewer" (or higher) access to the spreadsheet.
 */

import { google, sheets_v4 } from "googleapis";
import { getGoogleAuth, isGoogleConfigured } from "./gauth.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KeywordRow {
  /** Lower-cased keyword strings for matching */
  keywords: string[];
  /** The reply to send when any keyword matches */
  reply: string;
}

// ─── Configuration from env ───────────────────────────────────────────────────

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID ?? "";
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME ?? "Keywords";
const CACHE_TTL_MS = parseInt(
  process.env.SHEETS_CACHE_TTL_MS ?? String(5 * 60 * 1000),
  10
);

// ─── Module-level state ───────────────────────────────────────────────────────

let sheetsClient: sheets_v4.Sheets | null = null;
let cache: KeywordRow[] | null = null;
let cacheExpiresAt = 0;
let configWarned = false;

// ─── Client ───────────────────────────────────────────────────────────────────

function getSheetsClient(): sheets_v4.Sheets | null {
  if (sheetsClient) return sheetsClient;

  if (!isGoogleConfigured()) {
    if (!configWarned) {
      console.warn(
        "[sheets] ⚠️  Google Sheets not configured — keyword lookup disabled.\n" +
          "  Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_PATH\n" +
          "  and GOOGLE_SPREADSHEET_ID to enable it."
      );
      configWarned = true;
    }
    return null;
  }

  const auth = getGoogleAuth();
  if (!auth) return null;

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// ─── Fetch & parse ────────────────────────────────────────────────────────────

async function fetchRows(): Promise<KeywordRow[]> {
  const client = getSheetsClient();
  if (!client) return [];

  // range = SheetName!A2:B  (skip header row 1, read all rows with data)
  const range = `${SHEET_NAME}!A2:B`;

  const response = await client.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const rows = response.data.values ?? [];
  const parsed: KeywordRow[] = [];

  for (const row of rows) {
    const keywordCell = (row[0] as string | undefined)?.trim() ?? "";
    const replyCell = (row[1] as string | undefined)?.trim() ?? "";

    if (!keywordCell || !replyCell) continue; // skip empty rows

    const keywords = keywordCell
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0);

    if (keywords.length === 0) continue;

    parsed.push({ keywords, reply: replyCell });
  }

  console.log(`[sheets] 🔄 Loaded ${parsed.length} keyword row(s) from "${SHEET_NAME}"`);
  return parsed;
}

// ─── Cache management ─────────────────────────────────────────────────────────

async function getRows(): Promise<KeywordRow[]> {
  if (cache !== null && Date.now() < cacheExpiresAt) {
    return cache;
  }

  try {
    cache = await fetchRows();
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  } catch (err) {
    console.error("[sheets] ❌ Failed to fetch keyword rows:", err);
    // Return stale cache if available, empty array otherwise
    cache = cache ?? [];
  }

  return cache;
}

/** Force-invalidate the cache so the next lookup re-fetches from Sheets. */
export function invalidateCache(): void {
  cacheExpiresAt = 0;
  console.log("[sheets] 🗑  Cache invalidated — will re-fetch on next message.");
}

// ─── Public lookup API ────────────────────────────────────────────────────────

/**
 * Check whether `userMessage` contains any preset keyword.
 *
 * @returns The preset reply string if a keyword matched, or `null` if none matched
 *          (meaning the AI should handle the message).
 */
export async function findKeywordReply(userMessage: string): Promise<string | null> {
  const rows = await getRows();
  if (rows.length === 0) return null;

  const lowerMsg = userMessage.toLowerCase();

  for (const row of rows) {
    for (const kw of row.keywords) {
      if (lowerMsg.includes(kw)) {
        console.log(`[sheets] ✅ Keyword match: "${kw}" → preset reply`);
        return row.reply;
      }
    }
  }

  return null;
}

/**
 * Returns true if Sheets keyword lookup is configured and enabled.
 * Use this to log startup status.
 */
export function isSheetsEnabled(): boolean {
  return isGoogleConfigured();
}
