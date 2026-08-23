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

## 3. Deployment options — $0, NO credit card

First, an important architectural fact that makes $0 easy:

> **The router is OPTIONAL for the website.** orinai.org runs perfectly with just a
> free OpenRouter key (its `:free` models) plus the free Gemini fallback built into
> `api/chat.js`. If `ROUTER_BASE_URL` is not set, the site never calls the router at
> all. Deploy the router whenever you want the admin dashboard/analytics — the chatbot
> does not depend on it.

### ⚠️ Vercel will NOT work for the router

OmniRoute looks like a Next.js site (the dashboard is), but it is **not** serverless:

1. **All state lives in SQLite on local disk** (`~/.omniroute/storage.sqlite`).
2. **One long-running Node process** (dashboard + AI proxy + background schedulers).
3. Native `better-sqlite3` module + long-lived SSE streams.

### ⚡ Option 0 — FASTEST: official upstream image + native password ($0, no card)

Skip this fork's custom gate entirely and run stock OmniRoute with its built-in single-
password login. Ten minutes, zero builds:

1. Render → New + → **Web Service** → *Deploy an existing image from a registry* →
   Image URL: `docker.io/diegosouzapw/omniroute:main`
   (official upstream image, rebuilt daily; ~486 MB compressed)
2. Environment:
   - `JWT_SECRET` = random 32+ chars (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
   - `INITIAL_PASSWORD` = your strong admin password (this IS the login — OmniRoute's
     native system bootstraps it into bcrypt automatically, even after container resets)
   - `PORT` = `10000`
3. Create → wait for **Live** → open the URL → log in with that password.
4. Dashboard → **API Keys / Virtual Keys** → create keys for each system.
5. Wire the website: Vercel env `ROUTER_BASE_URL` = your onrender.com URL,
   `ROUTER_API_KEY` = one of those keys. Done — the chatbot routes through the router,
   with automatic direct-OpenRouter failover whenever the router sleeps or fails.

**Honest trade-offs vs this fork's gated version:** single password factor (no email/
phones/IP-block), and on Free tier the container filesystem resets on wake/redeploy —
your LOGIN keeps working (env re-bootstraps), but dashboard-created API keys must be
re-created after resets. The website itself never breaks: its key lives in Vercel env.
This fork (`Januth1234/Orin-Router`) preserves the 4-factor gate code for whenever you
move to persistent hosting and want it back.

### Option A — Render Free with this fork's PREBUILT image ($0, no card, with the 4-factor gate)

> **Why prebuilt?** Render's free builder caps at 8 GB RAM and this monorepo's Next.js
> build needs more — it fails with *"Ran out of memory (used over 8GB)"*. So GitHub
> Actions builds the image instead (16 GB runners, free for public repos) and Render
> just pulls it. The workflow `.github/workflows/orin-image.yml` does this automatically
> on every push to `main`.

**One-time setup:**

1. Check the build ran: on GitHub → your repo → **Actions** → "Build Orin Router
   image" → wait for the green ✓ (~15–25 min first time; cached rebuilds are faster).
2. Make the package pullable: GitHub → your profile → **Packages** → `orin-router` →
   **Package settings** → *Danger Zone* → **Change visibility → Public**
   (one-time; GHCR packages are private by default even in public repos).
3. On [render.com](https://render.com) (GitHub sign-in, no card): New + → **Web
   Service** → *Deploy an existing image from a registry* → Image URL:
   `ghcr.io/januth1234/orin-router:latest`
4. Add env vars (`JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PHONE_1`, `ADMIN_PHONE_2`,
   `ADMIN_PASSWORD`, `ADMIN_IP_BLOCK=On`) → Create Web Service → you get a
   `https://<name>.onrender.com` URL.

Future updates = just `git push`; Actions rebuilds the image, then on Render click
**Manual Deploy → Deploy latest reference** to pick it up.

Free-tier behavior (still $0): sleeps after ~15 min idle (~50 s wake); container
filesystem resets on wake/redeploy so analytics reset — your four-factor login keeps
working because `ADMIN_PASSWORD` re-bootstraps from env.

### Option A″ — Build directly on Render (only if you upgrade builder memory)

The original path — connect the repo and let Render build the Dockerfile — works only
on paid tiers with larger builders (the Free builder's 8 GB is what produced the OOM).
Kept here for completeness.

### ✅ Option B — Hugging Face Spaces Docker ($0, no card)

1. [huggingface.co](https://huggingface.co) → sign up free (email only) → **New Space**
   → SDK: **Docker** → *Blank* → set visibility **Private**.
2. Add your GitHub repo as remote and push, or upload the repo files (Space builds the
   root Dockerfile). In `README.md` front-matter set `app_port` to the port OmniRoute
   listens on (default 3000-ish; check its docs/start command).
3. Settings → **Variables and secrets** → add the same env vars as above as Secrets.
4. URL: `https://<user>-<space>.hf.space`. No card anywhere.

Behavior: sleeps after ~48 h idle (longer warm retention than Render), rebuilds wipe
local SQLite the same way.

### Option C — Koyeb free instance

Koyeb's free tier (GitHub signup, no card) gives one small web service with
scale-to-zero. Deploy the Docker image, same env vars. Capacity is small — verify the
Next.js dashboard fits in the free RAM before relying on it.

### ❌ Avoid for $0-no-card

- **Railway**: trial credit then paid plan; new accounts are pushed through payment
  verification (card).
- **Fly.io**: new organizations require a payment method on file.
- **Oracle Cloud / GCP / Azure free VMs**: genuinely free tiers but all require a
  credit/debit card at signup for verification.
- **Vercel/Netlify**: serverless-only, incompatible per above.

### If you ever accept a few dollars/month

Railway or Fly with a persistent volume mounted at `/root/.omniroute` removes the
reset caveat entirely and keeps the dashboard always-on. Until then, Render Free +
the env-based credentials give you the full admin experience at exactly $0.

### Capacity: will free hosting handle 100–1000 requests/hour?

Yes — that load is small. 100–1000 req/hour ≈ **0.03–0.28 requests/second** on average.
Render's Free container (512 MB RAM, shared vCPU) comfortably proxies this once awake,
and at ≥100 req/h spread across the hour the service rarely idles long enough to sleep
(sleep only kicks in after ~15 min of zero traffic; a wake costs ~50 s).

Two honest limits to know about:

1. **Provider caps, not hosting**: OpenRouter's `:free` models allow ~50 requests/DAY
   per account (raised to ~1000/day after any one-time $10 top-up). At 100–1000
   requests/HOUR you will exhaust free daily quotas quickly — that's OpenRouter's rule,
   nothing to do with hosting. Plan your model mix accordingly.
2. **RAM**: the dashboard is a full Next.js app. If the Free container ever OOMs on
   start, Render's Starter ($7) is the fix — still not required for the website itself,
   since it falls back to direct OpenRouter whenever the router is asleep/unreachable.

### Issuing API keys for your other systems (up to 5)

OmniRoute's dashboard has built-in key management — no code changes needed:

1. Sign in → **API Keys / Virtual Keys** page → **Create Key**, name it per system
   (e.g. `orinai-website`, `system-b`, `mobile-app`, …).
2. Copy each key ONCE (shown only at creation).
3. Any system then calls the router exactly like OpenAI:

```
POST https://<your-router>.onrender.com/v1/chat/completions
Authorization: Bearer <key>
Content-Type: application/json
{"model": "google/gemini-2.0-flash-001", "messages": [...]}
```

4. Create up to 5 keys — one per integrated system — so you can revoke/rotate them
   independently. Per-key usage shows in the dashboard analytics (tokens + models).
5. The main website uses one of these keys as `ROUTER_API_KEY` in its Vercel env vars.

## 4. Where to see usage

Sign in at `https://<your-instance>/login` with the four factors → the dashboard shows:
token usage per model/provider, request logs, and top models. The website's `/api/chat`
and executor planning calls appear there as they happen (model names pass through unchanged,
so you'll see `google/gemini-2.0-flash-001`, `anthropic/claude-3.5-sonnet`, etc.).

## 5. Failover guarantee

The website never depends on this instance being up: if the router returns an error,
`api/chat.js` and `api/executor.js` automatically retry the same request against
OpenRouter direct and log the failover. You lose analytics for those requests, nothing else.
