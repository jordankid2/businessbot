/**
 * Login Token Generator — One-time secure links for GAS keyword manager
 *
 * Flow:
 *   1. Customer sends /login to the bot in a private chat
 *   2. Bot calls generateLoginToken() → writes token to "LoginTokens" sheet
 *   3. Bot replies with GAS_WEB_APP_URL?token=<token>
 *   4. Customer clicks the link → GAS verifies and consumes the token
 *
 * Tokens expire after TOKEN_TTL_MS (default 10 minutes) and are single-use.
 *
 * ─── LoginTokens sheet layout ────────────────────────────────────────────────
 * Column A : Token (48-char hex)
 * Column B : Telegram User ID
 * Column C : First Name
 * Column D : Username
 * Column E : ExpiresAt (ISO 8601)
 * Column F : Used (TRUE / FALSE)
 */

import crypto from "crypto";
import { google } from "googleapis";
import { getGoogleAuth, isGoogleConfigured } from "./gauth.js";

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID ?? "";
const TOKEN_TTL_MS   = 10 * 60 * 1000; // 10 minutes
const TOKEN_SHEET    = "LoginTokens";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randToken(): string {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars
}

function getSheetsClient() {
  const auth = getGoogleAuth();
  if (!auth) throw new Error("Google auth not configured.");
  return google.sheets({ version: "v4", auth });
}

async function ensureTokenSheet(
  api: ReturnType<typeof getSheetsClient>
): Promise<void> {
  const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets?.some(
    (s) => s.properties?.title === TOKEN_SHEET
  );
  if (exists) return;

  await api.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TOKEN_SHEET } } }],
    },
  });

  await api.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TOKEN_SHEET}!A1:F1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["Token", "TelegramID", "FirstName", "Username", "ExpiresAt", "Used"]],
    },
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a one-time login token and write it to the LoginTokens sheet.
 * Returns the raw token string (48-char hex).
 */
export async function generateLoginToken(
  telegramId: number,
  firstName: string,
  username: string
): Promise<string> {
  if (!isGoogleConfigured() || !SPREADSHEET_ID) {
    throw new Error(
      "Google Sheets is not configured (missing credentials or GOOGLE_SPREADSHEET_ID)."
    );
  }

  const api     = getSheetsClient();
  await ensureTokenSheet(api);

  const token   = randToken();
  const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TOKEN_SHEET}!A:F`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[token, String(telegramId), firstName, username, expires, "FALSE"]],
    },
  });

  return token;
}
