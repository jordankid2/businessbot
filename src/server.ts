/**
 * Mini App Web Server -- PostgreSQL-backed
 *
 *  POST /api/auth        -- verify Telegram initData, provision user, return session token
 *  GET  /api/keywords    -- fetch keyword rows for the authenticated user
 *  POST /api/keywords    -- overwrite keyword rows for the authenticated user
 *  GET  /api/prompt      -- fetch user's custom system prompt
 *  POST /api/prompt      -- save user's custom system prompt
 *  GET  /api/logs        -- fetch recent chat logs (newest first)
 *  GET  /api/debug       -- diagnostics
 */

import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import pool from "./db.js";
import { getOrProvisionUserSheet } from "./registry.js";
import { invalidateCache } from "./sheets.js";
import { invalidatePromptCache } from "./adminPrompt.js";

// -- Session store (24-hour Bearer tokens) ------------------------------------

interface Session { userId: number; expiresAt: number }
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function getSession(req: express.Request): Session | null {
  const auth  = req.headers["authorization"] ?? "";
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || Date.now() > session.expiresAt) { sessions.delete(token); return null; }
  return session;
}

// -- initData verification ----------------------------------------------------

function verifyTelegramInitData(
  initData: string, botToken: string
): Record<string, string> | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const checkString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected  = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  if (expected !== hash) return null;
  const parsed: Record<string, string> = {};
  for (const [k, v] of params.entries()) parsed[k] = v;
  return parsed;
}

// -- Server -------------------------------------------------------------------

export function startServer(): void {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const PORT      = parseInt(process.env.PORT ?? "3000", 10);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, "../public")));

  // POST /api/auth
  app.post("/api/auth", async (req, res) => {
    const { initData } = (req.body ?? {}) as { initData?: string };
    if (!initData) { res.status(400).json({ error: "Missing initData" }); return; }

    const parsed = verifyTelegramInitData(initData, BOT_TOKEN);
    if (!parsed) { res.status(401).json({ error: "Invalid initData" }); return; }

    let userId: number | null = null;
    let firstName = "", username = "";
    try {
      const user = JSON.parse(parsed.user ?? "{}") as Record<string, unknown>;
      userId    = user.id as number ?? null;
      firstName = (user.first_name as string) ?? "";
      username  = (user.username  as string) ?? "";
    } catch { res.status(400).json({ error: "Malformed user field" }); return; }

    if (!userId) { res.status(400).json({ error: "Missing user id" }); return; }

    const ownerKey = await getOrProvisionUserSheet(userId, username, firstName).catch(() => null);
    if (!ownerKey) {
      res.status(503).json({ error: "Database not configured" });
      return;
    }

    const sessionToken = crypto.randomBytes(24).toString("hex");
    sessions.set(sessionToken, { userId, expiresAt: Date.now() + SESSION_TTL_MS });

    res.json({ userId, firstName, username, sessionToken });
  });

  // GET /api/keywords
  app.get("/api/keywords", async (req, res) => {
    const session = getSession(req);
    if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      const result = await pool.query(
        "SELECT id, keyword, reply, audio_url, notes FROM keywords WHERE user_id = $1 ORDER BY id",
        [session.userId]
      );
      const rows = result.rows.map(r => ({
        id:       r.id as number,
        keyword:  r.keyword  as string,
        reply:    r.reply    as string,
        audioUrl: r.audio_url as string,
        notes:    r.notes    as string,
      }));
      res.json({ rows });
    } catch (err) {
      console.error("[server] GET /api/keywords error:", err);
      res.status(500).json({ error: "Failed to fetch keywords", detail: (err as Error).message });
    }
  });

  // POST /api/keywords  (full replace)
  app.post("/api/keywords", async (req, res) => {
    const session = getSession(req);
    if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { rows } = (req.body ?? {}) as { rows?: Record<string, string>[] };
    if (!Array.isArray(rows)) { res.status(400).json({ error: "Missing rows" }); return; }

    try {
      await pool.query("BEGIN");
      await pool.query("DELETE FROM keywords WHERE user_id = $1", [session.userId]);
      for (const r of rows) {
        if (!(r["keyword"] ?? "").trim() && !(r["reply"] ?? "").trim()) continue;
        await pool.query(
          "INSERT INTO keywords(user_id, keyword, reply, audio_url, notes) VALUES($1,$2,$3,$4,$5)",
          [session.userId, r["keyword"] ?? "", r["reply"] ?? "",
           r["audioUrl"] ?? "", r["notes"] ?? ""]
        );
      }
      await pool.query("COMMIT");
      invalidateCache(String(session.userId));
      res.json({ ok: true, saved: rows.length });
    } catch (err) {
      await pool.query("ROLLBACK").catch(() => {});
      console.error("[server] POST /api/keywords error:", err);
      res.status(500).json({ error: "Failed to save keywords", detail: (err as Error).message });
    }
  });

  // GET /api/prompt
  app.get("/api/prompt", async (req, res) => {
    const session = getSession(req);
    if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      const result = await pool.query(
        "SELECT system_prompt FROM prompts WHERE user_id = $1", [session.userId]
      );
      res.json({ prompt: (result.rows[0]?.system_prompt as string) ?? "" });
    } catch (err) {
      console.error("[server] GET /api/prompt error:", err);
      res.status(500).json({ error: "Failed to fetch prompt", detail: (err as Error).message });
    }
  });

  // POST /api/prompt
  app.post("/api/prompt", async (req, res) => {
    const session = getSession(req);
    if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { prompt } = (req.body ?? {}) as { prompt?: string };
    if (prompt === undefined) { res.status(400).json({ error: "Missing prompt" }); return; }
    try {
      await pool.query(
        `INSERT INTO prompts(user_id, system_prompt, updated_at)
         VALUES($1, $2, NOW())
         ON CONFLICT(user_id) DO UPDATE
           SET system_prompt = EXCLUDED.system_prompt, updated_at = NOW()`,
        [session.userId, prompt]
      );
      invalidatePromptCache(String(session.userId));
      res.json({ ok: true });
    } catch (err) {
      console.error("[server] POST /api/prompt error:", err);
      res.status(500).json({ error: "Failed to save prompt", detail: (err as Error).message });
    }
  });

  // GET /api/logs?limit=50&offset=0
  app.get("/api/logs", async (req, res) => {
    const session = getSession(req);
    if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
    const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "50"),  10), 200);
    const offset = Math.max(parseInt(String(req.query["offset"] ?? "0"),   10), 0);
    try {
      const result = await pool.query(
        `SELECT direction, customer_id, customer_name, connection_id,
                message, reply_type, created_at
         FROM logs WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [session.userId, limit, offset]
      );
      res.json({ logs: result.rows });
    } catch (err) {
      console.error("[server] GET /api/logs error:", err);
      res.status(500).json({ error: "Failed to fetch logs", detail: (err as Error).message });
    }
  });

  // GET /api/debug
  app.get("/api/debug", async (_req, res) => {
    let dbOk = false, dbErr = "";
    try { await pool.query("SELECT 1"); dbOk = true; }
    catch (e) { dbErr = (e as Error).message; }
    res.json({
      dbConfigured: Boolean(process.env.DATABASE_URL),
      dbAccessible: dbOk,
      dbError:      dbErr || undefined,
      activeSessions: sessions.size,
    });
  });

  app.listen(PORT, () => {
    console.log(`[server] Mini App server listening on port ${PORT}`);
  });
}
