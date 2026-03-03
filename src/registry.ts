/**
 * Customer Registry — Multi-tenant Spreadsheet Lookup
 *
 * Maps each business owner's Telegram User ID to their personal Google
 * Spreadsheet. The mapping lives in the master spreadsheet
 * (GOOGLE_SPREADSHEET_ID → "Customers" sheet), which is the same sheet
 * that the GAS admin UI manages.
 *
 * On first encounter the registry automatically creates a new spreadsheet
 * for the owner with pre-configured Keywords / Logs / Users sheets.
 *
 * ─── Customers sheet columns (master spreadsheet) ────────────────────────────
 *  A  Telegram User ID
 *  B  Username
 *  C  First Name
 *  D  Email (may be empty)
 *  E  Spreadsheet ID   ← read/written here
 *  F  Spreadsheet URL
 *  G  Created At
 */

import { google } from "googleapis";
import { getGoogleAuth, isGoogleConfigured } from "./gauth.js";

// ─── Config ────────────────────────────────────────────────────────────────────

const MASTER_SS_ID    = process.env.GOOGLE_SPREADSHEET_ID ?? "";
const CUSTOMERS_SHEET = "Customers";
const CACHE_TTL_MS    = 5 * 60 * 1000; // 5 minutes

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry { ssId: string; expiresAt: number }
const _cache = new Map<number, CacheEntry>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sheetsApi() {
  const auth = getGoogleAuth();
  if (!auth) throw new Error("[registry] Google auth not configured");
  return google.sheets({ version: "v4", auth });
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
export async function getOrProvisionUserSheet(
  userId: number,
  username = "",
  firstName = ""
): Promise<string | null> {
  const hit = _cache.get(userId);
  if (hit && Date.now() < hit.expiresAt) return hit.ssId;

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
