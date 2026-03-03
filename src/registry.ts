/**
 * Admin Registry — Multi-tenant Spreadsheet Lookup
 *
 * This platform serves multiple admins (our paying clients). Each admin is
 * pre-registered by the platform operator in the master spreadsheet:
 *
 * ─── Admins sheet (master spreadsheet — access whitelist) ────────────────────
 *  A  Telegram User ID          ← required
 *  B  Enabled                   ← TRUE / FALSE (default TRUE if absent)
 *  C  Username
 *  D  First Name
 *  E  Notes
 *
 * ─── Customers sheet (master spreadsheet — per-admin spreadsheet map) ────────
 *  A  Telegram User ID
 *  B  Username
 *  C  First Name
 *  D  Email (may be empty)
 *  E  Spreadsheet ID   ← read/written here
 *  F  Spreadsheet URL
 *  G  Created At
 *
 * Workflow:
 *   1. Platform operator adds admin's Telegram User ID to "Admins" sheet.
 *   2. Admin connects their Telegram Business account to the bot.
 *   3. Bot checks "Admins" sheet → if found, auto-provisions their spreadsheet.
 *   4. All keyword / log / user data is written to the admin's own spreadsheet,
 *      fully isolated from every other admin.
 */

import { google } from "googleapis";
import { getGoogleAuth, isGoogleConfigured } from "./gauth.js";

// ─── Config ────────────────────────────────────────────────────────────────────

const MASTER_SS_ID    = process.env.GOOGLE_SPREADSHEET_ID ?? "";
const ADMINS_SHEET    = "Admins";    // whitelist — pre-configured by platform operator
const CUSTOMERS_SHEET = "Customers"; // maps admin userId → their spreadsheet
const CACHE_TTL_MS    = 5 * 60 * 1000; // 5 minutes

// Cache for admin whitelist (TTL same as customer cache)
const _adminCache = new Map<number, { allowed: boolean; expiresAt: number }>();

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry { ssId: string; expiresAt: number }
const _cache = new Map<number, CacheEntry>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sheetsApi() {
  const auth = getGoogleAuth();
  if (!auth) throw new Error("[registry] Google auth not configured");
  return google.sheets({ version: "v4", auth });
}

/**
 * Check whether a Telegram userId is listed in the "Admins" sheet of the
 * master spreadsheet. Only admins may use the bot's business features and
 * commands. Returns false if Google Sheets is not configured.
 */
export async function isAdmin(userId: number): Promise<boolean> {
  const hit = _adminCache.get(userId);
  if (hit && Date.now() < hit.expiresAt) return hit.allowed;

  if (!isGoogleConfigured() || !MASTER_SS_ID) return false;

  try {
    const res = await sheetsApi().spreadsheets.values.get({
      spreadsheetId: MASTER_SS_ID,
      range: `${ADMINS_SHEET}!A:B`,
    });
    for (const row of (res.data.values ?? []).slice(1)) {
      if (String(row[0]).trim() === String(userId)) {
        // Column B = Enabled (omitted or "TRUE" → allowed; explicitly "FALSE" → denied)
        const enabled =
          row[1] === undefined ||
          String(row[1]).trim().toUpperCase() !== "FALSE";
        _adminCache.set(userId, { allowed: enabled, expiresAt: Date.now() + CACHE_TTL_MS });
        return enabled;
      }
    }
  } catch (err) {
    console.warn("[registry] isAdmin lookup error:", (err as Error).message);
  }

  _adminCache.set(userId, { allowed: false, expiresAt: Date.now() + CACHE_TTL_MS });
  return false;
}

/** Force-clear the cached admin status for a userId (e.g. after sheet edit). */
export function invalidateAdminCache(userId: number): void {
  _adminCache.delete(userId);
}

/** Find the user's spreadsheetId in the master Customers sheet. Returns null if absent. */
async function lookupRegistry(userId: number): Promise<string | null> {
  if (!isGoogleConfigured() || !MASTER_SS_ID) return null;
  try {
    const res = await sheetsApi().spreadsheets.values.get({
      spreadsheetId: MASTER_SS_ID,
      range: `${CUSTOMERS_SHEET}!A:F`,
    });
    for (const row of (res.data.values ?? []).slice(1)) {
      if (String(row[0]) === String(userId)) {
        const ssId = String(row[4] ?? "").trim();
        return ssId || null;
      }
    }
  } catch (err) {
    console.warn("[registry] lookup error:", (err as Error).message);
  }
  return null;
}

/** Create a brand-new spreadsheet for the user and register it in the master sheet. */
async function provisionSpreadsheet(
  userId: number,
  username: string,
  firstName: string
): Promise<string> {
  const auth = getGoogleAuth()!;
  const api   = google.sheets({ version: "v4", auth });
  const title = `zznet Keywords — ${firstName || username || String(userId)}`;

  // 1. Create spreadsheet with 3 sheets
  const created = await api.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        { properties: { title: "Keywords", index: 0 } },
        { properties: { title: "Logs",     index: 1 } },
        { properties: { title: "Users",    index: 2 } },
      ],
    },
  });

  const ssId  = created.data.spreadsheetId!;
  const ssUrl = `https://docs.google.com/spreadsheets/d/${ssId}`;

  // 2. Write headers
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        {
          range: "Keywords!A1:D1",
          values: [["Keywords (comma-separated)", "Reply Text", "Audio URL (optional)", "Notes"]],
        },
        {
          range: "Logs!A1:G1",
          values: [["Timestamp", "Direction", "Customer ID", "Customer Name",
                    "Connection ID", "Message", "Reply Type"]],
        },
        {
          range: "Users!A1:F1",
          values: [["Customer ID", "Name", "Gender", "First Seen", "Last Seen", "Messages"]],
        },
      ],
    },
  });

  // 3. Bold the header rows
  const meta   = await api.spreadsheets.get({ spreadsheetId: ssId });
  const sheetIds = (meta.data.sheets ?? []).map(s => s.properties?.sheetId ?? 0);
  await api.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      requests: sheetIds.map(sid => ({
        repeatCell: {
          range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      })),
    },
  });

  // 4. Ensure "Customers" sheet exists in master, then append row
  const masterMeta = await sheetsApi().spreadsheets.get({ spreadsheetId: MASTER_SS_ID });
  const hasCutomers = (masterMeta.data.sheets ?? []).some(
    s => s.properties?.title === CUSTOMERS_SHEET
  );
  if (!hasCutomers) {
    await sheetsApi().spreadsheets.batchUpdate({
      spreadsheetId: MASTER_SS_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: CUSTOMERS_SHEET } } }],
      },
    });
    await sheetsApi().spreadsheets.values.update({
      spreadsheetId: MASTER_SS_ID,
      range: `${CUSTOMERS_SHEET}!A1:G1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["Telegram User ID", "Username", "First Name", "Email",
                  "Spreadsheet ID", "Spreadsheet URL", "Created At"]],
      },
    });
  }

  await sheetsApi().spreadsheets.values.append({
    spreadsheetId: MASTER_SS_ID,
    range: `${CUSTOMERS_SHEET}!A:G`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        String(userId), username, firstName, "", ssId, ssUrl,
        new Date().toISOString(),
      ]],
    },
  });

  console.log(`[registry] ✅ Provisioned "${title}" → ${ssUrl}`);
  return ssId;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up (or create) the per-user spreadsheet for a business owner.
 * Returns null if Google Sheets is not configured.
 */
/**
 * Look up (or create) the per-admin spreadsheet.
 * Returns null if:
 *   - Google Sheets is not configured, OR
 *   - the userId is NOT listed in the "Admins" whitelist sheet.
 */
export async function getOrProvisionUserSheet(
  userId: number,
  username = "",
  firstName = ""
): Promise<string | null> {
  const hit = _cache.get(userId);
  if (hit && Date.now() < hit.expiresAt) return hit.ssId;

  // ── Whitelist check ────────────────────────────────────────────────────────
  const allowed = await isAdmin(userId);
  if (!allowed) {
    console.warn(`[registry] ⛔  userId=${userId} is not in the Admins whitelist — ignoring.`);
    return null;
  }

  let ssId = await lookupRegistry(userId);

  if (!ssId) {
    try {
      ssId = await provisionSpreadsheet(userId, username, firstName);
    } catch (err) {
      console.error("[registry] ❌ provisionSpreadsheet failed:", (err as Error).message);
      return null;
    }
  }

  _cache.set(userId, { ssId, expiresAt: Date.now() + CACHE_TTL_MS });
  return ssId;
}

/**
 * Look up only — does NOT auto-provision.
 * Returns null if the user has no spreadsheet yet.
 */
export async function findUserSpreadsheetId(userId: number): Promise<string | null> {
  const hit = _cache.get(userId);
  if (hit && Date.now() < hit.expiresAt) return hit.ssId;

  const ssId = await lookupRegistry(userId);
  if (ssId) _cache.set(userId, { ssId, expiresAt: Date.now() + CACHE_TTL_MS });
  return ssId;
}

/** Force-expire the cache entry for a user (call after keyword save). */
export function invalidateUserCache(userId: number): void {
  _cache.delete(userId);
}
