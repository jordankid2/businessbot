# OpenClaw Template Variables

Use this matrix when configuring required and optional variables in Railway Template Composer.

## Required

| Variable | Required | Description | Example |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from BotFather; must support Business mode usage | `123456:ABCDEF...` |
| `GROQ_API_KEY` | Yes | API key for Groq LLM calls | `gsk_...` |

## Recommended Defaults

| Variable | Required | Description | Suggested Default |
|---|---|---|---|
| `GROQ_MODEL` | No | Groq model name used for responses | `llama-3.3-70b-versatile` |
| `GROQ_MAX_TOKENS` | No | Max tokens per model response | `1024` |
| `MAX_HISTORY_TURNS` | No | Number of conversation turns retained per user | `10` |
| `BOT_REPLY_DELAY_MS` | No | Delay before auto-reply to allow human takeover | `3000` |
| `TAKEOVER_TTL_MS` | No | Sliding takeover window after owner manual reply | `600000` |

## Optional Google Sheets Integration

| Variable | Required | Description | Notes |
|---|---|---|---|
| `GOOGLE_SPREADSHEET_ID` | Conditional | Spreadsheet ID used for keyword replies/logging | Required only if Sheets integration enabled |
| `GOOGLE_SHEET_NAME` | No | Sheet tab name for keyword mapping | Defaults to `Keywords` |
| `SHEETS_CACHE_TTL_MS` | No | Keyword cache refresh interval in ms | Defaults to `300000` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Conditional | JSON credentials string for service account | Use this OR `GOOGLE_SERVICE_ACCOUNT_PATH` |
| `GOOGLE_SERVICE_ACCOUNT_PATH` | Conditional | Path to service account JSON file in container | Use this OR `GOOGLE_SERVICE_ACCOUNT_JSON` |

## Maintainer Notes

- Mark `TELEGRAM_BOT_TOKEN` and `GROQ_API_KEY` as required template variables.
- Add descriptions for all optional variables so users understand behavior.
- Do not hardcode sensitive defaults in template configuration.
