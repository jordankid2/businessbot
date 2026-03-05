/**
 * User Registry -- PostgreSQL-backed
 * ownerKey (was ssId) is now String(userId).
 */
import pool from "./db.js";

export async function isAdmin(userId: number): Promise<boolean> {
  const envList = (process.env.ADMIN_USER_IDS ?? "")
    .split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (envList.includes(userId)) return true;
  try {
    const res = await pool.query("SELECT is_admin FROM users WHERE id = $1", [userId]);
    return (res.rows[0]?.is_admin as boolean) ?? false;
  } catch { return false; }
}

export function invalidateAdminCache(_userId: number): void {}

export async function getOrProvisionUserSheet(
  userId: number, username = "", firstName = ""
): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    await pool.query(
      `INSERT INTO users(id, username, first_name)
       VALUES ($1, $2, $3)
       ON CONFLICT(id) DO UPDATE
         SET username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
      [userId, username, firstName]
    );
    return String(userId);
  } catch (err) {
    console.error("[registry] provisionFailed:", (err as Error).message);
    return null;
  }
}

export async function findUserSpreadsheetId(userId: number): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const res = await pool.query("SELECT id FROM users WHERE id = $1", [userId]);
    return res.rows.length ? String(userId) : null;
  } catch { return null; }
}

export function invalidateUserCache(_userId: number): void {}

export async function reprovisionUserSheet(
  userId: number, username = "", firstName = ""
): Promise<string | null> {
  return getOrProvisionUserSheet(userId, username, firstName);
}
