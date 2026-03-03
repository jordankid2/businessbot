# BusinessBot — zznet Telegram Customer Support AI

A production-ready Telegram customer support bot powered by **Grammy** (Node.js) and **Groq** (LLM), customizable via plain Markdown config files.

---

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<YOUR_TEMPLATE_CODE>?utm_medium=integration&utm_source=button&utm_campaign=openclaw)

OpenClaw Railway template authoring assets are in `templates/openclaw/`:

- `templates/openclaw/overview.md`
- `templates/openclaw/variables.md`
- `templates/openclaw/publish-checklist.md`
- `templates/openclaw/README.md`

Replace `<YOUR_TEMPLATE_CODE>` after publishing your template in Railway.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) on Telegram |
| `GROQ_API_KEY` | From [console.groq.com](https://console.groq.com) (free) |
| `GROQ_MODEL` | Default: `llama-3.3-70b-versatile` |
| `GROQ_MAX_TOKENS` | Max reply tokens (default: `1024`) |
| `MAX_HISTORY_TURNS` | Conversation turns to remember per user (default: `10`) |

### 3. Customize business content

Edit the files in `config/`:

| File | Purpose |
|---|---|
| `config/business.md` | Company name, description, contact |
| `config/services.md` | List of services offered |
| `config/pricing.md` | Pricing rules and payment methods |
| `config/faq.md` | Frequently asked questions |
| `config/persona.md` | Bot tone, style, and behavior |

### 4. Run in development

```bash
npm run dev
```

### 5. Build & run in production

```bash
npm run build
npm start
```

---

## Project Structure

```
businessbot/
├── src/
│   ├── bot.ts        # Grammy bot entry point + command handlers
│   ├── ai.ts         # Groq API client + per-user conversation history
│   ├── prompt.ts     # System prompt builder
│   └── config.ts     # Markdown config file loader
├── config/
│   ├── business.md   # Business info
│   ├── services.md   # Services
│   ├── pricing.md    # Pricing rules
│   ├── faq.md        # FAQ
│   └── persona.md    # Persona/style
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/reset` | Clear conversation history for user |
| `/help` | Show help |

---

## Language Support

The bot automatically detects and replies in the user's language:
- 中文 (Chinese Simplified)
- English
- Bahasa Melayu

---

## Deployment (PM2)

```bash
npm run build
npm install -g pm2
pm2 start dist/bot.js --name businessbot
pm2 save
pm2 startup
```
# businessbot
