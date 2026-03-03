/**
 * Multimodal Media Handlers
 *
 * Provides voice transcription, image/video visual analysis, and file
 * risk assessment. All heavy work is done via Groq APIs (Whisper + Vision).
 *
 * ─── Voice Messages ──────────────────────────────────────────────────────────
 * 1. Download OGG/MP3 audio file from Telegram CDN
 * 2. Send to Groq Whisper for transcription
 * 3. Caller can then run keyword lookup on the transcribed text
 *
 * ─── Images ──────────────────────────────────────────────────────────────────
 * Download + base64-encode → Groq Vision model (llama-4-scout) → text reply
 *
 * ─── Videos ──────────────────────────────────────────────────────────────────
 * Telegram provides a thumbnail PhotoSize on most video messages.
 * We download that thumbnail and analyse it via vision.
 * If no thumbnail is available we explain the limitation.
 *
 * ─── Documents / Files ───────────────────────────────────────────────────────
 * We NEVER download documents. Instead we inspect only the metadata fields
 * (file_name, mime_type, file_size) that Telegram gives us for free and
 * return a risk assessment string.
 */

import Groq from "groq-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ??
  "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_WHISPER_MODEL =
  process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3";

// ─── Groq client (lazy) ───────────────────────────────────────────────────────

let _groq: Groq | null = null;
function groq(): Groq {
  if (!_groq) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set.");
    _groq = new Groq({ apiKey });
  }
  return _groq;
}

// ─── Telegram file download ───────────────────────────────────────────────────

interface TelegramFileResult {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

const MIME_MAP: Record<string, string> = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
};

async function downloadTelegramFile(
  fileId: string,
  botToken: string
): Promise<TelegramFileResult> {
  // Step 1: Resolve file_path from Telegram
  const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const infoRes = await fetch(infoUrl);
  if (!infoRes.ok)
    throw new Error(`getFile HTTP ${infoRes.status} for fileId=${fileId}`);

  const info = (await infoRes.json()) as {
    ok: boolean;
    result?: { file_path: string };
  };
  if (!info.ok || !info.result?.file_path)
    throw new Error(`getFile API error for fileId=${fileId}`);

  const filePath = info.result.file_path;
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  // Step 2: Download the actual bytes
  const dlUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const dlRes = await fetch(dlUrl);
  if (!dlRes.ok)
    throw new Error(`Download HTTP ${dlRes.status} for path=${filePath}`);

  const arrayBuf = await dlRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  return {
    buffer,
    mimeType: MIME_MAP[ext] ?? "application/octet-stream",
    fileName: filePath.split("/").pop() ?? `file.${ext}`,
  };
}

// ─── Voice Transcription ──────────────────────────────────────────────────────

/**
 * Download a voice/audio message from Telegram and transcribe it with
 * Groq Whisper (whisper-large-v3). Returns the transcribed text.
 *
 * @throws if Telegram download or Whisper call fails
 */
export async function transcribeVoice(
  fileId: string,
  botToken: string
): Promise<string> {
  const { buffer, mimeType, fileName } = await downloadTelegramFile(
    fileId,
    botToken
  );

  const blob = new Blob([buffer], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType });

  // whisper-large-v3 supports OGG, MP3, WAV, M4A natively.
  // Set language to "auto" detection (omitting language param = auto).
  const result = await groq().audio.transcriptions.create({
    file,
    model: GROQ_WHISPER_MODEL,
    response_format: "json",
  });

  const text =
    typeof result === "string"
      ? result
      : ((result as unknown as { text: string }).text ?? "");

  return text.trim();
}

// ─── Image Analysis ───────────────────────────────────────────────────────────

/**
 * Download the largest available photo from a Telegram photo array and
 * analyse it with the Groq Vision model.
 *
 * @param fileId  - Telegram file_id of the photo to analyse (pick the largest)
 * @param botToken - Bot token for Telegram CDN download
 * @param contextPrompt - Instruction passed to the vision model (e.g. conversation context)
 */
export async function analyzePhoto(
  fileId: string,
  botToken: string,
  contextPrompt: string
): Promise<string> {
  const { buffer, mimeType } = await downloadTelegramFile(fileId, botToken);
  const base64 = buffer.toString("base64");
  return analyzeBase64Image(base64, mimeType, contextPrompt);
}

/**
 * Analyse a pre-downloaded image already encoded as base64.
 */
export async function analyzeBase64Image(
  base64: string,
  mimeType: string,
  userPrompt: string
): Promise<string> {
  // Groq vision models currently support JPEG, PNG, WebP, GIF
  const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!supportedTypes.includes(mimeType)) {
    mimeType = "image/jpeg"; // fallback — most common
  }

  const completion = await groq().chat.completions.create({
    model: GROQ_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
          {
            type: "text",
            text: userPrompt,
          },
        ] as unknown as string,
      },
    ],
    max_tokens: 1024,
    temperature: 0.4,
  });

  return (
    completion.choices[0]?.message?.content?.trim() ??
    "Unable to analyse image."
  );
}

// ─── Video Analysis ────────────────────────────────────────────────────────────

/**
 * Analyse a video message by examining its Telegram-generated thumbnail.
 * If no thumbnail is available fall back to a polite text explanation.
 *
 * @param thumbFileId  - file_id of the Telegram video thumbnail (optional)
 * @param botToken     - Bot token for Telegram CDN
 * @param contextPrompt - Vision model instruction
 */
export async function analyzeVideo(
  thumbFileId: string | undefined,
  botToken: string,
  contextPrompt: string
): Promise<string> {
  if (!thumbFileId) {
    return (
      "❓ 我目前无法直接播放视频，但我看到您发了一段视频。请问这个视频和我们的对话有关吗？您想表达什么？\n" +
      "❓ I can't play videos directly, but I see you sent a video clip. Is it related to our conversation? What would you like to express?"
    );
  }

  const { buffer, mimeType } = await downloadTelegramFile(thumbFileId, botToken);
  const base64 = buffer.toString("base64");
  return analyzeBase64Image(base64, mimeType, contextPrompt);
}

// ─── File / Document Risk Assessment ─────────────────────────────────────────

export interface TelegramDocument {
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Extension categories for risk scoring */
const DANGEROUS_EXTS = new Set([
  "exe", "bat", "cmd", "sh", "ps1", "psm1", "psd1",
  "vbs", "vbe", "js", "jse", "jar", "msi", "deb",
  "rpm", "run", "apk", "app", "dmg", "pkg", "ipa",
  "com", "scr", "hta", "cpl", "reg", "pif",
]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "img"]);
const OFFICE_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp",
]);
const SAFE_EXTS = new Set(["pdf", "txt", "csv", "json", "xml", "md", "log"]);
const MEDIA_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "mp3", "wav"]);

function bytesToHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Returns a risk-assessment message based ONLY on file metadata.
 * We never download or open the file.
 */
export function assessFileRisk(doc: TelegramDocument): string {
  const rawName = doc.file_name ?? "unknown";
  const sizeStr = doc.file_size ? bytesToHuman(doc.file_size) : "未知大小";
  const ext = rawName.split(".").pop()?.toLowerCase() ?? "";

  if (DANGEROUS_EXTS.has(ext)) {
    return (
      `⚠️ 【高风险文件警告】\n` +
      `对方发送了一个 .${ext} 可执行文件 (${rawName}, ${sizeStr})。\n` +
      `此类文件可能含有病毒或恶意代码，请勿下载或运行。\n\n` +
      `您好，请问您发送这个文件是想表达什么呢？\n\n` +
      `⚠️ [High-Risk File Warning]\n` +
      `A .${ext} executable file was sent (${rawName}, ${sizeStr}). ` +
      `This file type may contain malware. We will not open it.\n` +
      `May I ask what you intended to share?`
    );
  }

  if (ARCHIVE_EXTS.has(ext)) {
    return (
      `⚠️ 收到一个压缩包文件 (${rawName}, ${sizeStr})。\n` +
      `压缩包内容在未解压前无法验证安全性。\n` +
      `请问您想分享什么内容？可以直接发送文件或图片吗？\n\n` +
      `⚠️ Received an archive (${rawName}, ${sizeStr}). ` +
      `We cannot verify the contents of archives. ` +
      `Could you describe what you'd like to share?`
    );
  }

  if (OFFICE_EXTS.has(ext)) {
    return (
      `📄 收到 ${ext.toUpperCase()} 文档 (${rawName}, ${sizeStr})。\n` +
      `我暂时无法打开附件内容，请问文件里有什么具体问题或需求我可以帮您解答吗？\n\n` +
      `📄 Received a ${ext.toUpperCase()} document (${rawName}, ${sizeStr}). ` +
      `I can't open attachments directly — could you describe what you need help with?`
    );
  }

  if (SAFE_EXTS.has(ext)) {
    return (
      `📄 收到文件 ${rawName} (${sizeStr})。\n` +
      `请问这个文件想表达什么？有什么我可以帮到您的吗？\n\n` +
      `📄 Received ${rawName} (${sizeStr}). What would you like me to help with?`
    );
  }

  if (MEDIA_EXTS.has(ext)) {
    return (
      `🖼 收到媒体文件 (${rawName}, ${sizeStr})。\n` +
      `请问有什么我可以帮到您的吗？\n\n` +
      `🖼 Received media file (${rawName}, ${sizeStr}). How can I help you?`
    );
  }

  return (
    `❓ 收到未知类型文件 (${rawName}, ${sizeStr})。\n` +
    `基于安全考量，我们不会打开未知类型的文件。\n` +
    `请问您想表达什么？\n\n` +
    `❓ Received unknown file type (${rawName}, ${sizeStr}). ` +
    `For security reasons we do not open unknown file types. ` +
    `What would you like to express?`
  );
}
