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

// ─── Types ──────────────────────────────────────────────────────────────────────────────

export type Gender = "男" | "女" | "未知";

export interface TelegramChat {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
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

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TelegramChat {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Detect the likely gender of a Telegram chat user from their display name.
 *
 * Returns a cached result on subsequent calls for the same chat.id.
 * Result is used for AI conversational context ONLY — never written to any sheet.
 */
export async function detectGender(chat: TelegramChat): Promise<Gender> {
  return inferGender(
    chat.id,
    chat.first_name ?? chat.username ?? "",
    chat.last_name
  );
}
