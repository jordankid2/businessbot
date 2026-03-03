/**
 * Gender Detection & User Profile Logger
 *
 * When the AI is invoked for a customer, this module:
 *   1. Infers the customer's likely gender from their Telegram display name
 *      using a lightweight Groq LLM call (cached per customer ID).
 *   2. Upserts a row in the "Users" sheet of the configured spreadsheet so the
 *      business owner can see who they're chatting with.
 *
 * ─── Users Sheet format ───────────────────────────────────────────────────────
 * Sheet name: "Users"
 * Row 1: Header  →  Customer ID | Name | Gender | First Seen | Last Seen | Messages
 *
 * ─── Caching ──────────────────────────────────────────────────────────────────
 * Gender inference results are cached in-memory (Map keyed by customer ID).
 * This avoids repeated Groq calls for the same contact.
 */

import Groq from "groq-sdk";
import { google, sheets_v4 } from "googleapis";
import { getGoogleAuth, isGoogleConfigured } from "./gauth.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Gender = "男" | "女" | "未知";

export interface CustomerProfile {
  customerId: number;
  customerName: string;
  gender: Gender;
}

// ─── Groq Client (lazy) ───────────────────────────────────────────────────────

let _groq: Groq | null = null;
function groq(): Groq {
  if (!_groq) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set.");
    _groq = new Groq({ apiKey });
  }
  return _groq;
}

// ─── Gender inference cache ───────────────────────────────────────────────────

const genderCache = new Map<number, Gender>();

/**
 * Infer customer gender from their Telegram display name (first + last name).
 * Uses Groq with a compact prompt; result is cached per customer ID.
 */
async function inferGender(
  customerId: number,
  firstName: string,
  lastName?: string
): Promise<Gender> {
  const cached = genderCache.get(customerId);
  if (cached) return cached;

  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  if (!fullName.trim()) {
    genderCache.set(customerId, "未知");
    return "未知";
  }

  try {
    const result = await groq().chat.completions.create({
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "你是一个人名性别分析助手。根据给出的名字判断最可能的性别。" +
            "只能回答以下三个词之一：男、女、未知。不要解释，不要加任何标点或额外字。",
        },
        {
          role: "user",
          content: `名字：${fullName}`,
        },
      ],
      max_tokens: 5,
      temperature: 0,
    });

    const raw = result.choices[0]?.message?.content?.trim() ?? "未知";
    const gender: Gender =
      raw === "男" ? "男" : raw === "女" ? "女" : "未知";

    genderCache.set(customerId, gender);
    return gender;
  } catch {
    genderCache.set(customerId, "未知");
    return "未知";
  }
}

// ─── Google Sheets — Users sheet ─────────────────────────────────────────────

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID ?? "";
const USERS_SHEET_NAME = "Users";

let sheetsClient: sheets_v4.Sheets | null = null;
let sheetsDisabledUntil = 0;

function getSheetsClient(): sheets_v4.Sheets | null {
  if (sheetsClient) return sheetsClient;
  if (!isGoogleConfigured()) return null;
  const auth = getGoogleAuth();
  if (!auth) return null;
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

function nowStr(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Ensure "Users" sheet exists; create it with a header row if needed.
 */
async function ensureUsersSheet(client: sheets_v4.Sheets): Promise<void> {
  const meta = await client.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties.title",
  });
  const exists = (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === USERS_SHEET_NAME
  );
  if (exists) return;

  // Create the sheet
  await client.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: USERS_SHEET_NAME } } }],
    },
  });

  // Write header row
  await client.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${USERS_SHEET_NAME}!A1:F1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        ["Customer ID", "Name", "Gender", "First Seen", "Last Seen", "Messages"],
      ],
    },
  });

  console.log(`[gender] 📋 Created "${USERS_SHEET_NAME}" sheet.`);
}

/**
 * Upsert a row in the Users sheet for this customer.
 * If the customer already has a row, update Last Seen + increment message count.
 */
async function upsertUserRow(profile: CustomerProfile): Promise<void> {
  if (Date.now() < sheetsDisabledUntil) return;
  if (!SPREADSHEET_ID) return;

  const client = getSheetsClient();
  if (!client) return;

  try {
    await ensureUsersSheet(client);

    // Read existing rows (A2:F) to find this customer
    const resp = await client.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${USERS_SHEET_NAME}!A2:F`,
    });

    const rows: string[][] = (resp.data.values ?? []) as string[][];
    const rowIndex = rows.findIndex(
      (r) => String(r[0]) === String(profile.customerId)
    );

    const now = nowStr();

    if (rowIndex === -1) {
      // New customer — append row
      await client.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${USERS_SHEET_NAME}!A:F`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [
            [
              String(profile.customerId),
              profile.customerName,
              profile.gender,
              now, // First Seen
              now, // Last Seen
              "1", // Messages
            ],
          ],
        },
      });
      console.log(
        `[gender] 👤 New user logged  id=${profile.customerId}  gender=${profile.gender}`
      );
    } else {
      // Existing — update Last Seen and message count (rowIndex is 0-based in array → sheet row = rowIndex+2)
      const sheetRow = rowIndex + 2;
      const prevCount = parseInt(rows[rowIndex][5] ?? "0", 10);
      await client.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${USERS_SHEET_NAME}!B${sheetRow}:F${sheetRow}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [
            [
              profile.customerName,
              profile.gender,
              rows[rowIndex][3] ?? now, // keep original First Seen
              now,                       // update Last Seen
              String(prevCount + 1),     // increment message count
            ],
          ],
        },
      });
    }
  } catch (err: unknown) {
    const status = (err as { status?: number; code?: number })?.status ??
      (err as { status?: number; code?: number })?.code;
    if (status === 403) {
      sheetsDisabledUntil = Date.now() + 15 * 60 * 1000;
      console.warn("[gender] ⚠️ 403 writing to Users sheet — paused 15 min.");
    } else {
      sheetsDisabledUntil = Date.now() + 60 * 1000;
      console.warn("[gender] ⚠️ Error writing Users sheet:", (err as Error)?.message);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TelegramChat {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Detect the customer's gender and log / update their row in the Users sheet.
 *
 * This is fire-and-forget — callers should `void detectAndLogGender(...)`.
 */
export async function detectAndLogGender(
  chat: TelegramChat,
  customerName: string
): Promise<void> {
  const firstName = chat.first_name ?? chat.username ?? "";
  const lastName = chat.last_name;

  const gender = await inferGender(chat.id, firstName, lastName);

  const profile: CustomerProfile = {
    customerId: chat.id,
    customerName,
    gender,
  };

  await upsertUserRow(profile);
}
