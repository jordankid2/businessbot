/**
 * Keyword lookup -- PostgreSQL-backed
 * ownerKey = String(userId)
 */
import pool from "./db.js";

export interface KeywordMatch {
  reply: string;
  audioUrl?: string;
}

export async function findKeywordReply(
  text: string, ownerKey: string
): Promise<KeywordMatch | null> {
  if (!ownerKey || !process.env.DATABASE_URL) return null;
  const userId = parseInt(ownerKey, 10);
  if (isNaN(userId)) return null;
  try {
    const res = await pool.query(
      "SELECT keyword, reply, audio_url FROM keywords WHERE user_id = $1",
      [userId]
    );
    const lower = text.toLowerCase();
    for (const row of res.rows) {
      const kws: string[] = (row.keyword as string)
        .split(",").map((k: string) => k.trim().toLowerCase()).filter(Boolean);
      if (kws.some(kw => lower.includes(kw))) {
        return { reply: row.reply as string, audioUrl: (row.audio_url as string) || undefined };
      }
    }
  } catch (err) {
    console.warn("[sheets] findKeywordReply error:", (err as Error).message);
  }
  return null;
}

export function isSheetsEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function invalidateCache(_ownerKey: string): void {}
