# Orin AI — Router & Admin Panel Deployment Guide

This folder deploys **OmniRoute** as two things for the Orin AI platform:

1. **Admin panel** — locked behind a 4-factor login (email + Phone 1 + Phone 2 + password),
   all provisioned through environment variables, with 3-strike IP blocking.
2. **LLM router** — the OpenAI-compatible endpoint that orinai.org routes ALL chat/agent
   text traffic through, giving you live token usage + top-model analytics.

The main website repo (`D:\Orin_AI`) connects to this instance with two env vars
(`ROUTER_BASE_URL`, `ROUTER_API_KEY` — see the main repo's `.env.example`). Nothing else
needs to change on the website.

---

## 1. What was changed in this repo (vs upstream OmniRoute)

| File | Change |
|---|---|
| `src/lib/auth/orinGate.ts` | NEW — 4-factor gate: verifies email/phone1/phone2/password against env vars (timing-safe), tracks failures per IP, blocks after 3 strikes, honors the On/Off kill switch. State persists in OmniRoute's settings DB so blocks survive restarts. |
| `src/shared/validation/schemas/misc.ts` | `loginSchema` accepts optional `email`, `phone1`, `phone2`. |
| `src/app/api/auth/login/route.ts` | Runs the Orin gate before upstream auth. If `ADMIN_PASSWORD` is set, it IS the password factor and the persisted-hash check is skipped. If not set, the identity factors are checked first and the password still falls back to OmniRoute's own management password (`INITIAL_PASSWORD`). Failed delegated passwords also count toward the 3 strikes. |
| `src/app/login/page.tsx` | Login form renders Email / Phone 1 / Phone 2 fields when the gate is configured. |
| `src/app/api/settings/require-login/route.ts` | Reports `orinGate: true/false` so the form knows which mode to render. |

When `ADMIN_EMAIL` is NOT configured, everything passes through — stock OmniRoute behavior.

---

## 2. Environment variables (set these on your hosting instance)

### Gate credentials (all four are the admin login)

```bash
ADMIN_EMAIL=you@example.com          # factor 1 — exact match, case-insensitive
ADMIN_PHONE_1=+94771234567           # factor 2 — digits compared, any format (+94 / 077 / spaces)
ADMIN_PHONE_2=+94112345678           # factor 3
ADMIN_PASSWORD=your-strong-password  # factor 4 — when set, overrides INITIAL_PASSWORD entirely
```

### IP blocking

```bash
ADMIN_IP_BLOCK=On     # "On" → 3 wrong attempts from one IP = blocked (403)
                      # "Off" → blocking disabled AND existing blocks ignored
ADMIN_MAX_ATTEMPTS=3  # optional, default 3
```

**Locked yourself out?** Go to your hosting dashboard (e.g. Vercel/Railway/Fly env settings),
change `ADMIN_IP_BLOCK` to `Off`, redeploy/wait for restart, sign in with the correct four
credentials, then flip it back to `On`. Your IP's failed-attempt counter clears automatically
on a successful login.

> Note: while the block list itself persists across restarts, blocking is only ENFORCED
> while `ADMIN_IP_BLOCK=On`. That is exactly the recovery behavior requested.

### Required by OmniRoute itself (upstream requirements)

```bash
JWT_SECRET=<random 32+ chars>   # session cookie signing — REQUIRED
INITIAL_PASSWORD=CHANGEME       # ignored when ADMIN_PASSWORD is set; otherwise bootstraps the dashboard password
```

### Router access for orinai.org

Create an API key inside the OmniRoute dashboard (Virtual/API keys section) and put it in the
WEBSITE's environment, not here:

```bash
# In the orinai.org (main site) Vercel project:
ROUTER_BASE_URL=https://your-router-instance.example.com
ROUTER_API_KEY=<key issued by this dashboard>
```

---

## 3. Deployment options

OmniRoute is a long-running Node server (not serverless). Pick one:

**Docker (recommended)**

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

**Node directly**

```bash
corepack enable && pnpm install && pnpm build && pnpm start   # see package.json scripts
```

**Railway / Render / Fly.io**: import this repo; `fly.toml` is included for Fly. Set every
env var from §2 in the host's dashboard before first boot.

A reverse proxy in front (Caddy/Nginx/Cloudflare) handling HTTPS is strongly recommended;
OmniRoute sets its auth cookie to `secure` automatically behind HTTPS.

## 4. Where to see usage

Sign in at `https://<your-instance>/login` with the four factors → the dashboard shows:
token usage per model/provider, request logs, and top models. The website's `/api/chat`
and executor planning calls appear there as they happen (model names pass through unchanged,
so you'll see `google/gemini-2.0-flash-001`, `anthropic/claude-3.5-sonnet`, etc.).

## 5. Failover guarantee

The website never depends on this instance being up: if the router returns an error,
`api/chat.js` and `api/executor.js` automatically retry the same request against
OpenRouter direct and log the failover. You lose analytics for those requests, nothing else.
