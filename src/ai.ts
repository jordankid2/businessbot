import Groq from "groq-sdk";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// In-memory conversation history.
// Key format:
//   Regular bot mode:    "direct:<chatId>"
//   Business bot mode:   "<businessConnectionId>:<chatId>"
const histories = new Map<string, ChatMessage[]>();

const MAX_HISTORY_TURNS = parseInt(process.env.MAX_HISTORY_TURNS ?? "10", 10);
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const GROQ_MAX_TOKENS = parseInt(process.env.GROQ_MAX_TOKENS ?? "1024", 10);

let groqClient: Groq | null = null;

function getGroq(): Groq {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY is not set in environment variables.");
    }
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

export function getHistory(key: string): ChatMessage[] {
  if (!histories.has(key)) {
    histories.set(key, []);
  }
  return histories.get(key)!;
}

export function clearHistory(key: string): void {
  histories.delete(key);
}

/** Build the history key for direct (non-business) mode. */
export function directKey(chatId: number): string {
  return `direct:${chatId}`;
}

/** Build the history key for Telegram Business mode. */
export function businessKey(connectionId: string, chatId: number): string {
  return `${connectionId}:${chatId}`;
}

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  // Keep only the last N turns (each turn = 1 user + 1 assistant message)
  const maxMessages = MAX_HISTORY_TURNS * 2;
  if (history.length > maxMessages) {
    return history.slice(history.length - maxMessages);
  }
  return history;
}

export async function chat(
  key: string,
  userMessage: string,
  systemPrompt: string
): Promise<string> {
  const history = getHistory(key);

  history.push({ role: "user", content: userMessage });

  const trimmed = trimHistory(history);

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...trimmed.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  try {
    const completion = await getGroq().chat.completions.create({
      model: GROQ_MODEL,
      messages,
      max_tokens: GROQ_MAX_TOKENS,
      temperature: 0.5,
    });

    const reply =
      completion.choices[0]?.message?.content?.trim() ??
      "Sorry, I could not generate a response. Please try again.";

    history.push({ role: "assistant", content: reply });

    // Keep history size in check
    const capped = trimHistory(history);
    histories.set(key, capped);

    return reply;
  } catch (err: unknown) {
    console.error("[ai] Groq API error:", err);
    throw err;
  }
}
