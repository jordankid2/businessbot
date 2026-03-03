# OpenClaw Railway Template Pack

This folder contains ready-to-use content for publishing this project as a Railway template under the open source maintainer workflow.

Railway template creation and publishing is done in the Railway UI:
- Create: https://docs.railway.com/templates/create
- Publish: https://docs.railway.com/templates/publish-and-share
- Maintainer overview: https://docs.railway.com/templates#for-open-source-maintainers

## What is included

- `overview.md` — Ready-to-paste template Overview (marketplace page copy)
- `variables.md` — Environment variable matrix for template setup
- `publish-checklist.md` — Maintainer checklist before publishing

## Service setup in Railway Template Composer

Use one service sourced from this repository (or Docker image) with:

- Builder: `Dockerfile` (already configured in `railway.toml`)
- Start command: leave default (`CMD ["node", "dist/bot.js"]` from Dockerfile)
- Networking: no public HTTP port required for Telegram webhookless polling mode
- Health check: optional for Telegram bot workloads

## Post-publish

After publishing, Railway generates your template code URL (e.g. `https://railway.com/new/template/<CODE>`).
Replace `<YOUR_TEMPLATE_CODE>` in the root README Deploy button with your real code.
