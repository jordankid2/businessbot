/**
 * Per-Admin System Prompt Loader
 *
 * Each admin (our client) has a "Prompts" sheet in their own Google Spreadsheet.
 * This module loads their custom system prompt from that sheet so every admin
 * gets a fully independent AI persona.
 *
 * ─── Prompts sheet format ─────────────────────────────────────────────────────
 * Sheet name : "Prompts"
 * Row 1      : Header  →  Setting | Value
 * Row 2      : system_prompt | <full custom prompt text>
 *
 * Any row whose "Setting" column equals "system_prompt" is used as the prompt.
 * If the sheet is missing or the row is empty, the platform default prompt is
 * returned as a safe fallback.
 *
 * ─── Caching ─────────────────────────────────────────────────────────────────
 * Results are cached per spreadsheetId with a 5-minute TTL.
 * Calling invalidatePromptCache(ssId) forces the next call to re-fetch.
 */

import { google } from "googleapis";
import { getGoogleAuth } from "./gauth.js";

const PROMPTS_SHEET = "Prompts";
const CACHE_TTL_MS  = 5 * 60 * 1000;

interface CacheEntry { prompt: string; expiresAt: number }
const _cache = new Map<string, CacheEntry>();

// ─── Default platform prompt (fallback) ──────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `You are a professional Telegram Business Customer Support AI.
Your role is to assist customers on behalf of the business owner.

RULES:
- Only answer within the business scope.
- Do NOT make up pricing, policies, or unavailable services.
- If unsure, ask for clarification instead of guessing.
- Always be polite, concise, and helpful.
- Do NOT generate harmful, illegal, or sensitive content.

LANGUAGE:
- Detect user language automatically and reply in the same language.
- Supported: Chinese (Simplified), English, Malay, and others as needed.

STYLE:
- Professional but friendly tone.
- Keep replies concise — avoid long paragraphs unless detail is truly needed.

BOUNDARY:
- If the question is unrelated to the business → politely redirect.
- If the topic is sensitive → refuse safely and politely.`;

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Load the admin's custom system prompt from their "Prompts" sheet.
 *
 * Returns the DEFAULT_SYSTEM_PROMPT if:
 *   - ssId is empty / Google not configured
 *   - The "Prompts" sheet doesn't exist
 *   - The "system_prompt" row is absent or empty
 */
export async function getAdminPrompt(ssId: string): Promise<string> {
  if (!ssId) return DEFAULT_SYSTEM_PROMPT;

  const hit = _cache.get(ssId);
  if (hit && Date.now() < hit.expiresAt) return hit.prompt;

  const auth = getGoogleAuth();
  if (!auth) return DEFAULT_SYSTEM_PROMPT;

  try {
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: `${PROMPTS_SHEET}!A2:B`,
    });

    for (const row of (res.data.values ?? [])) {
      const key   = String(row[0] ?? "").trim().toLowerCase();
      const value = String(row[1] ?? "").trim();
      if (key === "system_prompt" && value) {
        _cache.set(ssId, { prompt: value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      }
    }
  } catch (err) {
    // Sheet may not exist yet — return default silently
    console.warn(`[adminPrompt] Could not read Prompts sheet for ss=${ssId.slice(-6)}:`,
      (err as Error).message?.slice(0, 80));
  }

  // Cache the fallback too, to avoid hammering Sheets on unconfigured admins
  _cache.set(ssId, { prompt: DEFAULT_SYSTEM_PROMPT, expiresAt: Date.now() + CACHE_TTL_MS });
  return DEFAULT_SYSTEM_PROMPT;
}

/** Force-expire the cached prompt for an admin (call after /api/prompt save). */
export function invalidatePromptCache(ssId: string): void {
  _cache.delete(ssId);
}
