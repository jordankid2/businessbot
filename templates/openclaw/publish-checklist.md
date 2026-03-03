# OpenClaw Template Publish Checklist (Railway)

## Before creating template

- Confirm project builds with `npm run build`.
- Ensure Docker deploy works (`Dockerfile` + `railway.toml` already present).
- Ensure branding assets are ready (template icon and service icon, 1:1 transparent PNG/SVG).
- Verify README clearly explains setup and required secrets.

## In Railway Template Composer

- Create template from this project or from scratch.
- Add one service sourced from this repository.
- Configure template variables using `variables.md`.
- Add clear descriptions to each variable in the composer.
- Keep service naming in proper brand case: `OpenClaw`.

## Overview and publishing

- Paste content from `overview.md` into template Overview.
- Publish from Workspace Templates page.
- Optionally attach a Live Demo project.

## After publishing

- Copy generated template URL/code.
- Update root README deploy button URL with the real template code.
- Monitor Template Queue for user support requests.
- Track metrics/kickbacks in Railway dashboard.
