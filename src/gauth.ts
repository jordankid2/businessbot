/**
 * Shared Google Auth
 *
 * Provides a single authenticated Google API client used by both:
 *   - sheets.ts  (read keywords)
 *   - logger.ts  (write chat logs)
 *
 * Credentials are loaded from env:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  – full JSON string
 *   GOOGLE_SERVICE_ACCOUNT_PATH  – path to JSON key file
 */

import * as fs from "fs";
import * as path from "path";
import { google, Auth } from "googleapis";

let authClient: Auth.GoogleAuth | null = null;

function loadCredentials(): object | null {
  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    try {
      return JSON.parse(jsonEnv) as object;
    } catch {
      console.error("[gauth] ❌ GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
      return null;
    }
  }

  const pathEnv = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (pathEnv) {
    try {
      const resolvedPath = path.resolve(process.cwd(), pathEnv);
      return JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as object;
    } catch {
      console.error(`[gauth] ❌ Could not read service account file: ${pathEnv}`);
      return null;
    }
  }

  return null;
}

/**
 * Returns a GoogleAuth instance with Sheets read+write scope.
 * Returns null if credentials are not configured.
 */
export function getGoogleAuth(): Auth.GoogleAuth | null {
  if (authClient) return authClient;

  const credentials = loadCredentials();
  if (!credentials) return null;

  authClient = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return authClient;
}

export function isGoogleConfigured(): boolean {
  return Boolean(
    (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_SERVICE_ACCOUNT_PATH) &&
      process.env.GOOGLE_SPREADSHEET_ID
  );
}
