/**
 * Admin prompt -- PostgreSQL-backed
 */
import pool from "./db.js";

export const DEFAULT_SYSTEM_PROMPT =
  "\u4f60\u662f\u4e00\u4f4d\u4e13\u4e1a\u3001\u53cb\u5584\u7684\u5ba2\u670d\u52a9\u624b\u3002\u8bf7\u7528\u5ba2\u6237\u76f8\u540c\u7684\u8bed\u8a00\u56de\u590d\uff0c\u4fdd\u6301\u7b80\u6d01\u6709\u793c\u8c8c\u3002";

const _cache = new Map<string, { prompt: string; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

export async function getAdminPrompt(ownerKey: string): Promise<string> {
  if (!ownerKey || !process.env.DATABASE_URL) return DEFAULT_SYSTEM_PROMPT;
  const hit = _cache.get(ownerKey);
  if (hit && Date.now() < hit.expiresAt) return hit.prompt || DEFAULT_SYSTEM_PROMPT;
  const userId = parseInt(ownerKey, 10);
  if (isNaN(userId)) return DEFAULT_SYSTEM_PROMPT;
  try {
    const res = await pool.query(
      "SELECT system_prompt FROM prompts WHERE user_id = $1", [userId]
    );
    const prompt = (res.rows[0]?.system_prompt as string) ?? "";
    _cache.set(ownerKey, { prompt, expiresAt: Date.now() + TTL_MS });
    return prompt || DEFAULT_SYSTEM_PROMPT;
  } catch { return DEFAULT_SYSTEM_PROMPT; }
}

export function invalidatePromptCache(ownerKey: string): void {
  _cache.delete(ownerKey);
}
