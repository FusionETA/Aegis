# Argus

FusionETA's unattended browser smoke-test bot. Each check is a headed Playwright
script that logs into an app, walks a journey and reports. Root's cron runs them on
weekdays on the `agents-s-2vcpu-4gb-sgp1` droplet. When a check fails, it alerts the
destinations in its `<APP>_NOTIFY`: Bitrix24, WhatsApp, email, Telegram, Slack, Teams,
Google Chat or any webhook, in any mix. Without that setting it uses the default Bitrix
chat. Successful runs only log, unless the app has run reports switched on (every
run's report to a separate list). Most of this is set in the console at
https://argus.fusioneta.com.my.

**To add or change a check, ask Claude in a session on this repo.** The
`argus-new-test` skill (`.claude/skills/argus-new-test/SKILL.md`) handles the
whole flow: intake, read-only investigation, plan, script, test, deploy.

## Layout

| Path | What |
| --- | --- |
| `run.sh` | Cron wrapper: `run.sh <app>/<action>` runs `plugins/<app>/<action>.js` under `xvfb-run` and logs to `logs/<app>-<action>.log`. A bare `run.sh <action>` means AltomateHR (`logs/<action>.log`). A failed run is retried once after 5 minutes (`ARGUS_RETRY_DELAY`) and alerts only if it fails again; scripts containing `argus:no-retry` (checks that change data) are never retried. Only one run per check at a time: if the previous run is still going, the new one is skipped. Scripts containing `argus:no-browser` run without the virtual display. |
| `core/browser.js` | Launches headed Chromium with a geolocation-granted context. `closeBrowser(browser, result)` saves a full-page screenshot of a failed run to `logs/screenshots/` (kept 30 days) before closing. |
| `core/guard.js` | `blockWrites(page)` aborts every POST/PUT/PATCH/DELETE after login, so read-only checks can't save anything. |
| `core/report.js` | `sendReportOnFailure(result, text, { app })`: always logs, and on failure alerts every destination in `<APP>_NOTIFY`. With no app or no `<APP>_NOTIFY`, it uses the default Bitrix chat. Channel setup: `.claude/skills/argus-new-test/notifications.md`. A failed run's screenshot is attached in Bitrix (needs the webhook's `disk` scope), email and Telegram, and named in every other channel. Each check's last result is kept in `logs/state/<app>-<action>.json`: a check that keeps failing alerts at most once a day (MYT) and says "failing since", and the first pass after a failure sends "✅ … is passing again" (Argus can't tell what fixed it). Optional run reports: with `<APP>_REPORTS_ENABLED=1`, every finished run's report (passed or failed, after any retry) also goes to `<APP>_REPORTS`, with no daily limit. `ARGUS_NO_NOTIFY=1` suppresses all sends and leaves that state alone, for test runs. |
| `tools/notify.js` | `--app <app> --check` lists a check's alert destinations and missing credentials; `--test` sends a test alert to all of them. Add `--reports` for the run-report list instead. |
| `core/time.js` | `nowMYT()` for report timestamps. |
| `core/check.js` | The running check's name (`<app>-<action>`) and the logs folder, for screenshots and state files. |
| `plugins/<app>/` | One folder per app: checks as `<action>.js`, helpers (incl. `login.js`) in `lib/`. |
| `tools/recon.js` | Read-only page inventory and screenshots, for planning a new check. |
| `tools/argus.logrotate` | Weekly log tidy-up: `logs/*.log` rotated weekly, 8 weeks kept, compressed. Installed as `/etc/logrotate.d/argus` (`install -m 0644 tools/argus.logrotate /etc/logrotate.d/argus`); Ubuntu's nightly logrotate does the rest. |
| `tools/deploy.sh` | Fast-forwards `/root/argus` to `main` (running `npm ci` if dependencies changed), checks alert destinations, and appends one cron line. Runs under a lock and backs up the crontab. |
| `.claude/skills/argus-new-test/` | The workflow skill and a script template. It loads in any Claude Code session on this repo. |
| `org-plugin/argus/` | Small org-wide plugin (published on claude.ai). It points people from any session to a "FusionAI" + FusionETA/argus session. |

Work on Argus in a Claude Code session on the self-hosted **FusionAI** environment
with this repo. Sessions on the Anthropic-cloud environment can't reach the live box.

## The console

`https://argus.fusioneta.com.my` — sign-in for colleagues. Views: **Checks** (grouped by
app; each check has its own page), **Apps** (per app: checks on/off, notifications, app
login), **Channels**, **Activity**, **People** (admins), and your account. It has live check status and
history (reports, failure screenshots), alert state (failing since, last alert), Run now
(read-only checks only), pause/resume, alert destinations with a test alert, run reports
(switch + own destinations, with a messages-per-day estimate), the alert channels and
who they send as, app logins (password never shown), People (admins) and an Activity
log of every change.

- `console/server.js` — the web app, as the unprivileged user `argus-web` on
  127.0.0.1:3200 behind Caddy. It owns accounts and sessions (`console/store.js`, data
  in `/var/lib/argus-console`) and can't read `/root`.
- `console/agent.js` — a small root service that does everything that touches Argus,
  from a fixed list of validated operations on a Unix socket only `argus-web` can
  open. Its own record of changes: `logs/console-changes.log`.
- Accounts: an admin invites people from the People page; each gets a one-time link
  (24 h) to choose a password, sent by Bitrix DM when their Bitrix user ID is known.
  Sessions end after 12 h, or 4 h idle; 5 wrong passwords lock an account for 15 min.
- Logo and app icons (home screen, browser tab, `manifest.webmanifest`) are built from one
  source by `console/brand/build-icons.mjs`; rerun it after changing the logo.
- Install or update: `console/install.sh`. First admin, or when everyone is locked out:
  `node console/admin.js add-admin <email> "<Name>"` (also `reset`, `remove`, `list`).
- Pausing writes `config/paused/<app>-<action>`, which `run.sh` honours. Display names
  and steps come from `checks.json`; a check missing there shows with its bare action
  and gets no Apps page.
- Admins can also change a check's schedule (presets or cron, at least 5 minutes apart;
  the agent edits only that check's crontab line and keeps the last 30 crontabs in
  `config/crontab-backups/`), retire a check (its line is removed and remembered in
  `config/retired/`, so "Bring back" restores it), and set up channels on the Channels
  page: Bitrix webhook and default chat, SMTP, Telegram, Slack, Teams, Google Chat and
  the generic webhook. Secrets are write-only. Members can reschedule read-only checks.
- The Apps page writes these `.env` keys through the agent, the same ones you'd set by hand:
  `<APP>_NOTIFY`, `<APP>_REPORTS`, `<APP>_REPORTS_ENABLED` and the app login
  (`<APP>_URL`, `_LOGIN_URL`, `_EMAIL`, `_USERNAME`, `_PASSWORD`). Channel credentials
  (webhooks, SMTP, bot tokens) are still added on the server.

## The live box

- **Live checkout:** `/root/argus`, on `main`. Cron runs it, so don't edit it by hand;
  deploy with `tools/deploy.sh`.
- **Config:** `/root/argus/.env` (chmod 600, never committed). Keys are prefixed per app,
  see `.env.example`.
- **Node:** 24 at `/opt/node24/bin/node`, selected through the `ARGUS_NODE=` line at the top of
  root's crontab. The system `/usr/bin/node` is v18 and belongs to another service.
- **Timezone:** the server runs on `Asia/Kuala_Lumpur`, so cron times are MYT.
- **Pushes:** `/root/.ssh/argus_deploy_ed25519` is a deploy key with write access to this
  repo, used through each checkout's `core.sshCommand`.

## Current checks

| When (MYT, Mon–Fri) | Command | What |
| --- | --- | --- |
| 09:00 | `run.sh clockin` | AltomateHR: clock in the smoke account, then the read-only claims check |
| 18:00 | `run.sh clockout` | AltomateHR: clock out the smoke account |
| every 5 min, all days | `run.sh artemis/nginx` | Is AltomateHR's web server up? No login, no browser: public site, app heartbeat, nginx directly on artemis (private network), artemis SSH port (connect only), certificate expiry. Re-checks after 30 s, then alerts with the likely cause. |

`clockin` and `clockout` really change attendance on PROD, so never run them by hand.
`run.sh claims-check` is read-only and safe to run any time.

## Rules for every check

- **Read-only by default.** Stop before anything is saved, and use `blockWrites`.
  A check that changes data needs the app owner's approval, recorded in the commit
  message.
- **Test accounts only.**
- **Secrets stay out of chat**, commits, command lines and logs.
