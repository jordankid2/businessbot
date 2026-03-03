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
 * Column C    : (optional) Audio URL — external CDN/Cloud Storage URL to a voice
 *               file (.ogg/.mp3). When set and the keyword matches, the bot sends
 *               this audio clip as a voice reply instead of plain text.
 * Column D    : (optional) Note/label for your reference — ignored by the bot
 *
 * Example rows:
 *   Row 2 | 价格,报价,price,quote | 您好！报价需要了解需求，请描述您的项目。 | https://cdn.example.com/voice/price.ogg
 *   Row 3 | 联系,contact,联络    | 请通过 Telegram @zznet_support 联系我们。 |
 *   Row 4 | 时间,deadline,交付   | 小项目3-7天，中型2-4周，大型按里程碑排期。 |
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
  /** Optional external audio URL — send as voice instead of text when set */
  audioUrl?: string;
}

/** Return type of findKeywordReply */
export interface KeywordMatch {
  reply: string;
  /** External audio URL to send as voice, if configured */
  audioUrl?: string;
}

// ─── Configuration from env ───────────────────────────────────────────────────

const SHEET_NAME = process.env.GOOGLE_SHEET_NAME ?? "Keywords";
const CACHE_TTL_MS = parseInt(
  process.env.SHEETS_CACHE_TTL_MS ?? String(5 * 60 * 1000),
  10
);

// ─── Per-user cache ───────────────────────────────────────────────────────────

interface UserSheetState {
  rows: KeywordRow[] | null;
  expiresAt: number;
  disabledUntil: number;
  disabledReason: "permission" | "transient" | null;
}

let sheetsClient: sheets_v4.Sheets | null = null;
let configWarned = false;

// Keyed by spreadsheetId
const _stateMap = new Map<string, UserSheetState>();

function getState(ssId: string): UserSheetState {
  let s = _stateMap.get(ssId);
  if (!s) {
    s = { rows: null, expiresAt: 0, disabledUntil: 0, disabledReason: null };
    _stateMap.set(ssId, s);
  }
  return s;
}
const PERMISSION_BACKOFF_MS = 15 * 60 * 1000;
const TRANSIENT_BACKOFF_MS = 60 * 1000;

function extractGoogleError(err: unknown): {
  status?: number;
  code?: number;
  message: string;
} {
  const maybe = err as {
    status?: number;
    code?: number;
    message?: string;
    response?: { status?: number; data?: { error?: { message?: string } } };
    cause?: { message?: string; code?: number; status?: string };
  };

  const status = maybe?.status ?? maybe?.response?.status;
  const code = maybe?.code ?? maybe?.cause?.code;
  const message =
    maybe?.cause?.message ??
    maybe?.response?.data?.error?.message ??
    maybe?.message ??
    "Unknown Google Sheets error";

  return { status, code, message };
}

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

async function fetchRows(ssId: string): Promise<KeywordRow[]> {
  const client = getSheetsClient();
  if (!client) return [];

  const range = `${SHEET_NAME}!A2:C`;

  const response = await client.spreadsheets.values.get({
    spreadsheetId: ssId,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const rows = response.data.values ?? [];
  const parsed: KeywordRow[] = [];

  for (const row of rows) {
    const keywordCell = (row[0] as string | undefined)?.trim() ?? "";
    const replyCell   = (row[1] as string | undefined)?.trim() ?? "";
    const audioUrlCell = (row[2] as string | undefined)?.trim() ?? "";
    if (!keywordCell || !replyCell) continue;
    const keywords = keywordCell
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0);
    if (keywords.length === 0) continue;
    parsed.push({
      keywords,
      reply: replyCell,
      ...(audioUrlCell ? { audioUrl: audioUrlCell } : {}),
    });
  }

  console.log(`[sheets] 🔄 Loaded ${parsed.length} keyword row(s) from ss=${ssId.slice(-6)}`);
  return parsed;
}

// ─── Cache management ─────────────────────────────────────────────────────────

async function getRows(ssId: string): Promise<KeywordRow[]> {
  const s = getState(ssId);

  if (Date.now() < s.disabledUntil) return s.rows ?? [];
  if (s.rows !== null && Date.now() < s.expiresAt) return s.rows;

  try {
    s.rows = await fetchRows(ssId);
    s.expiresAt = Date.now() + CACHE_TTL_MS;
    s.disabledReason = null;
  } catch (err) {
    const details = extractGoogleError(err);
    if (details.status === 403 || details.code === 403) {
      s.disabledUntil = Date.now() + PERMISSION_BACKOFF_MS;
      if (s.disabledReason !== "permission") {
        s.disabledReason = "permission";
        console.warn(
          `[sheets] ⚠️ Permission denied (403) for ss=${ssId.slice(-6)}. ` +
          `Keyword lookup paused ${Math.floor(PERMISSION_BACKOFF_MS / 60000)} min.`
        );
      }
    } else {
      s.disabledUntil = Date.now() + TRANSIENT_BACKOFF_MS;
      if (s.disabledReason !== "transient") {
        s.disabledReason = "transient";
        console.warn(`[sheets] ⚠️ Keyword lookup temporarily unavailable (ss=${ssId.slice(-6)}): ${details.message}`);
      }
    }
    s.rows = s.rows ?? [];
  }

  return s.rows;
}

/** Force-invalidate cache for one (or all) user spreadsheets. */
export function invalidateCache(ssId?: string): void {
  if (ssId) {
    const s = _stateMap.get(ssId);
    if (s) s.expiresAt = 0;
    console.log(`[sheets] 🗑  Cache invalidated for ss=${ssId.slice(-6)}`);
  } else {
    _stateMap.forEach(s => { s.expiresAt = 0; });
    console.log("[sheets] 🗑  All keyword caches invalidated");
  }
}

// ─── Public lookup API ────────────────────────────────────────────────────────

/**
 * Check whether `userMessage` contains any preset keyword for this owner's spreadsheet.
 *
 * @param userMessage  The customer's raw message text
 * @param ssId         The owner's spreadsheet ID (from registry)
 * @returns A KeywordMatch if found, or null (→ use AI)
 */
export async function findKeywordReply(
  userMessage: string,
  ssId: string
): Promise<KeywordMatch | null> {
  if (!ssId) return null;
  const rows = await getRows(ssId);
  if (rows.length === 0) return null;

  const lowerMsg = userMessage.toLowerCase();

  for (const row of rows) {
    for (const kw of row.keywords) {
      if (lowerMsg.includes(kw)) {
        console.log(
          `[sheets] ✅ Keyword match: "${kw}" → preset reply${row.audioUrl ? " + audio" : ""}`
        );
        return { reply: row.reply, audioUrl: row.audioUrl };
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
