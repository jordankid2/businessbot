/**
 * Mini App Web Server
 *
 * Serves the Telegram Mini App UI and provides API endpoints for:
 *  - POST /api/auth        — verify Telegram initData, return user + spreadsheet info
 *  - GET  /api/keywords    — fetch keyword rows from admin's spreadsheet
 *  - POST /api/keywords    — overwrite keyword rows in admin's spreadsheet
 *  - GET  /api/prompt      — fetch admin's custom system prompt
 *  - POST /api/prompt      — save admin's custom system prompt
 */

import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";
import { getGoogleAuth } from "./gauth.js";
import { getOrProvisionUserSheet } from "./registry.js";
import { invalidateCache } from "./sheets.js";
import { invalidatePromptCache } from "./adminPrompt.js";

const KEYWORDS_SHEET = "Keywords";
const PROMPTS_SHEET  = "Prompts";

// ─── initData verification ────────────────────────────────────────────────────

function verifyTelegramInitData(
  initData: string,
  botToken: string
): Record<string, string> | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");

  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  if (expected !== hash) return null;

  const parsed: Record<string, string> = {};
  for (const [k, v] of params.entries()) parsed[k] = v;
  return parsed;
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function startServer(): void {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const PORT      = parseInt(process.env.PORT ?? "3000", 10);

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve Mini App static files from ../public/
  app.use(express.static(path.resolve(__dirname, "../public")));

  // ── POST /api/auth ──────────────────────────────────────────────────────────
  app.post("/api/auth", async (req, res) => {
    const { initData } = (req.body ?? {}) as { initData?: string };

    if (!initData) {
      res.status(400).json({ error: "Missing initData" });
      return;
    }

    const parsed = verifyTelegramInitData(initData, BOT_TOKEN);
    if (!parsed) {
      res.status(401).json({ error: "Invalid initData — HMAC mismatch" });
      return;
    }

    let userId: number | null = null;
    let firstName = "";
    let username  = "";
    try {
      const user  = JSON.parse(parsed.user ?? "{}") as Record<string, unknown>;
      userId    = user.id    as number ?? null;
      firstName = (user.first_name as string) ?? "";
      username  = (user.username  as string) ?? "";
    } catch {
      res.status(400).json({ error: "Malformed user field in initData" });
      return;
    }

    if (!userId) {
      res.status(400).json({ error: "Missing user id" });
      return;
    }

    const ssId  = await getOrProvisionUserSheet(userId, username, firstName).catch(() => null);
    const ssUrl = ssId ? `https://docs.google.com/spreadsheets/d/${ssId}` : null;

    res.json({ userId, firstName, username, ssId, ssUrl });
  });

  // ── GET /api/keywords?ssId=xxx ──────────────────────────────────────────────
  app.get("/api/keywords", async (req, res) => {
    const ssId = String(req.query["ssId"] ?? "");

    if (!ssId) {
      res.status(400).json({ error: "Missing ssId query parameter" });
      return;
    }

    const auth = getGoogleAuth();
    if (!auth) {
      res.status(503).json({ error: "Google Sheets is not configured" });
      return;
    }

    try {
      const sheets = google.sheets({ version: "v4", auth });
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: ssId,
        range: `${KEYWORDS_SHEET}!A2:D`,
      });

      const rows = (result.data.values ?? []).map(
        ([kw, reply, audio, notes]: (string | undefined)[]) => ({
          keyword:  kw    ?? "",
          reply:    reply ?? "",
          audioUrl: audio ?? "",
          notes:    notes ?? "",
        })
      );

      res.json({ rows });
    } catch (err) {
      console.error("[server] GET /api/keywords error:", err);
      res.status(500).json({ error: "Failed to fetch keywords from Sheets" });
    }
  });

  // ── POST /api/keywords ──────────────────────────────────────────────────────
  app.post("/api/keywords", async (req, res) => {
    const { ssId, rows } = (req.body ?? {}) as {
      ssId?: string;
      rows?: Record<string, string>[];
    };

    if (!ssId || !Array.isArray(rows)) {
      res.status(400).json({ error: "Missing ssId or rows in request body" });
      return;
    }

    const auth = getGoogleAuth();
    if (!auth) {
      res.status(503).json({ error: "Google Sheets is not configured" });
      return;
    }

    try {
      const sheets = google.sheets({ version: "v4", auth });

      // Clear existing data rows (row 1 = header, keep it)
      await sheets.spreadsheets.values.clear({
        spreadsheetId: ssId,
        range: `${KEYWORDS_SHEET}!A2:D`,
      });

      if (rows.length > 0) {
        const values = rows.map((r) => [
          r["keyword"]  ?? "",
          r["reply"]    ?? "",
          r["audioUrl"] ?? "",
          r["notes"]    ?? "",
        ]);

        await sheets.spreadsheets.values.update({
          spreadsheetId: ssId,
          range: `${KEYWORDS_SHEET}!A2`,
          valueInputOption: "RAW",
          requestBody: { values },
        });
      }

      // Invalidate in-memory cache so next message picks up new keywords
      invalidateCache(ssId);

      res.json({ ok: true, saved: rows.length });
    } catch (err) {
      console.error("[server] POST /api/keywords error:", err);
      res.status(500).json({ error: "Failed to save keywords to Sheets" });
    }
  });

  // ── GET /api/prompt?ssId=xxx ──────────────────────────────────────────────────────
  app.get("/api/prompt", async (req, res) => {
    const ssId = String(req.query["ssId"] ?? "");
    if (!ssId) { res.status(400).json({ error: "Missing ssId" }); return; }

    const auth = getGoogleAuth();
    if (!auth) { res.status(503).json({ error: "Google Sheets not configured" }); return; }

    try {
      const sheets = google.sheets({ version: "v4", auth });
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: ssId,
        range: `${PROMPTS_SHEET}!A2:B`,
      });

      let prompt = "";
      for (const row of (result.data.values ?? [])) {
        if (String(row[0] ?? "").trim().toLowerCase() === "system_prompt") {
          prompt = String(row[1] ?? "").trim();
          break;
        }
      }

      res.json({ prompt });
    } catch (err) {
      console.error("[server] GET /api/prompt error:", err);
      res.status(500).json({ error: "Failed to fetch prompt" });
    }
  });

  // ── POST /api/prompt ───────────────────────────────────────────────────────────
  app.post("/api/prompt", async (req, res) => {
    const { ssId, prompt } = (req.body ?? {}) as { ssId?: string; prompt?: string };

    if (!ssId || prompt === undefined) {
      res.status(400).json({ error: "Missing ssId or prompt in request body" });
      return;
    }

    const auth = getGoogleAuth();
    if (!auth) { res.status(503).json({ error: "Google Sheets not configured" }); return; }

    try {
      const sheets = google.sheets({ version: "v4", auth });

      // Upsert the system_prompt row (always row 2)
      await sheets.spreadsheets.values.update({
        spreadsheetId: ssId,
        range: `${PROMPTS_SHEET}!A2:B2`,
        valueInputOption: "RAW",
        requestBody: { values: [["system_prompt", prompt]] },
      });

      // Invalidate cached prompt so next AI call uses the new value
      invalidatePromptCache(ssId);

      res.json({ ok: true });
    } catch (err) {
      console.error("[server] POST /api/prompt error:", err);
      res.status(500).json({ error: "Failed to save prompt" });
    }
  });

  app.listen(PORT, () => {
    console.log(`[server] 🌐  Mini App server listening on port ${PORT}`);
  });
}
