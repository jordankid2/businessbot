/**
 * PostgreSQL connection pool + schema initialization
 *
 * Schema:
 *   users    — registered bot admins (Telegram Business account owners)
 *   keywords — per-user auto-reply keyword rules
 *   prompts  — per-user AI system prompt
 *   logs     — per-user chat message log
 */

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

export default pool;

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          BIGINT PRIMARY KEY,
      username    TEXT    NOT NULL DEFAULT '',
      first_name  TEXT    NOT NULL DEFAULT '',
      is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS keywords (
      id         SERIAL  PRIMARY KEY,
      user_id    BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      keyword    TEXT    NOT NULL,
      reply      TEXT    NOT NULL DEFAULT '',
      audio_url  TEXT    NOT NULL DEFAULT '',
      notes      TEXT    NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS keywords_user_id_idx ON keywords(user_id);

    CREATE TABLE IF NOT EXISTS prompts (
      user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      system_prompt TEXT   NOT NULL DEFAULT '',
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS logs (
      id            SERIAL  PRIMARY KEY,
      user_id       BIGINT  NOT NULL,
      direction     TEXT    NOT NULL DEFAULT '',
      customer_id   BIGINT,
      customer_name TEXT    NOT NULL DEFAULT '',
      connection_id TEXT    NOT NULL DEFAULT '',
      message       TEXT    NOT NULL DEFAULT '',
      reply_type    TEXT    NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS logs_user_id_idx ON logs(user_id);
  `);

  // Seed ADMIN_USER_IDS env var into users.is_admin
  const adminIds = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

  for (const id of adminIds) {
    await pool.query(`
      INSERT INTO users(id, is_admin) VALUES($1, TRUE)
      ON CONFLICT(id) DO UPDATE SET is_admin = TRUE
    `, [id]);
  }

  console.log("[db] ✅ Schema ready" + (adminIds.length ? `  admins=${adminIds.join(",")}` : ""));
}
