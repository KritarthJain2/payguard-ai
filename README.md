# PayGuard AI — Check Before You Pay (Vercel version)

Live demo: https://payguard-ai-kritarthjain1968-gmailcoms-projects.vercel.app

PayGuard AI helps you check before you pay. Paste any invoice or payment
message, and it extracts the sender, merchant, amount, currency and due date,
then runs a server-side AI analysis (Groq) alongside a deterministic rule
layer that flags urgency pressure, threats, secrecy, account changes,
merchant mismatches, amount and currency mismatches, shortened or look-alike
URLs, and missing details — each flag with evidence, not just a verdict.

A server-side payment gate then recalculates everything in integer cents:
checkout is blocked on any amount or currency mismatch, any unresolved
critical finding, or any missing required data, and no client-supplied score,
verified flag or amount is ever trusted. Only when the gate passes does the
server create a PayPal Sandbox order for exactly the original agreed amount,
and a payment is shown as successful only after the server re-fetches and
captures that order from PayPal. A passing check never claims a seller is
legitimate — it means only that the required checks passed.

Built for the PayPal AI Hackathon: it meaningfully uses PayPal Sandbox
(Orders API v2) together with an AI tool, in a mobile-first, dark-navy
dashboard for freelancers and online buyers. No build step, no frontend
dependencies, plain Node.js serverless functions on Vercel.

**This is not a production payment app. All PayPal transactions are Sandbox
tests. No production credentials and no real money are used.**

## What is included

- Frontend: `public/index.html` — dashboard, invoice form, review-and-correct
  step, risk report, amount comparison, sender/merchant comparison,
  missing/not-verified panel, tailored checklist, and PayPal Sandbox screen.
  Desktop sidebar, mobile bottom navigation. No build step, no frontend
  dependencies.
- Backend (Vercel serverless, plain Node.js, no extra dependencies):
  - `GET /api/health` and `GET /api/status` — configuration booleans only.
    No secret is ever exposed.
  - `POST /api/analyze` — server-side Groq analysis + deterministic rule layer.
  - `POST /api/paypal/create` — re-runs the payment gate, then creates a
    PayPal Sandbox Orders API v2 order for the server-validated quote only.
  - `POST /api/paypal/capture` — re-fetches the PayPal order, verifies ID,
    amount in cents, currency, status and quote association, then captures
    with a deterministic idempotency key.
- Shared server logic: `api/_lib.js` (integer-cents money, rule layer,
  scoring, payment gate, in-memory order store).

## How the score works

The score is a heuristic, not a statistically validated fraud probability.
It is capped at 100. Thresholds: 0–24 low detected risk, 25–49 medium risk,
50–100 high risk. Flags are deduplicated between AI and rule sources.
Green is used only for individual checks that actually passed. A low score
is not a "safe" badge, and a passing gate means only that the required
checks passed — it does not prove the seller is legitimate.

Critical mismatches (amount, currency) block checkout on the server and
cannot be dismissed in the frontend. Client-supplied risk scores, verified
flags, payable amounts and approval statuses are never trusted; the server
recalculates on every attempt.

Invoice URLs are inspected as text only and are never opened. Instructions
embedded in an invoice are flagged, not followed.

## Environment variables (server only, Vercel Production)

Copy `.env.example` names only — never put real values in the repo, in
frontend code, or in chat.

| Variable | Required | Default / notes |
|---|---|---|
| `PAYGUARD_AI_API_KEY` | Yes, for live AI analysis | Without it, `/api/analyze` returns a clear configuration error and fabricates no analysis. |
| `PAYGUARD_AI_BASE_URL` | No | Default Groq (`https://api.groq.com`) |
| `PAYGUARD_AI_MODEL` | No | Default `openai/gpt-oss-120b` (Groq; the former default `llama-3.3-70b-versatile` was shut down for free/developer tiers on 16 Aug 2026) |
| `PAYPAL_SANDBOX_CLIENT_ID` | Yes, for live Sandbox checkout | Sandbox only. Never use a production client ID. |
| `PAYPAL_SANDBOX_CLIENT_SECRET` | Yes, for live Sandbox checkout | Sandbox only. |
| `PAYPAL_SANDBOX_BASE_URL` | No | Default `https://api-m.sandbox.paypal.com`. Any non-Sandbox host is refused. |

### Deploy steps (do not deploy until you are ready to set the variables)

1. Push this folder to a Git repo, or import it in the Vercel dashboard.
2. In Vercel, open the project → Settings → Environment Variables.
3. Add the variables above for Production (and Preview if you want preview
   deployments to work the same way).
4. Redeploy.
5. Open the site, check `/api/health` — it should report `aiConfigured`
   and `paypalConfigured` as booleans, without showing any secret.
6. Test a clean invoice, then a mismatched invoice, then a Sandbox approval
   and capture with a Sandbox buyer test account.

## Local verification (no deploy, no credentials needed)

```bash
node --check api/_lib.js api/analyze.js api/health.js api/status.js api/paypal/create.js api/paypal/capture.js
node test/run-tests.js
```

The test script covers: exact matches, 19.99 vs 19.99, 0.30 vs 0.3,
80 vs 50, 50 USD vs 50 EUR, missing quote, manipulated client claims
(verified / low-risk / approved claims ignored in both directions),
repeated attempts (blocked stays blocked, verified stays verified, fixing
the amount passes next attempt), and missing-env configuration behaviour.

## Known limitations — read before judging or deploying

1. **Live Sandbox approval/capture still needs credentials.** Without
   `PAYPAL_SANDBOX_CLIENT_ID` / `PAYPAL_SANDBOX_CLIENT_SECRET` set in
   Vercel and a redeploy, order creation returns a configuration error
   with setup instructions and creates no order. That is intentional.
2. **Live Groq analysis still needs its key.** Without
   `PAYGUARD_AI_API_KEY`, `/api/analyze` returns a configuration error
   and fabricates no analysis.
3. **Order storage is in-memory in this Vercel version.** Vercel
   serverless instances may be recycled, so a stored order record may
   not survive to a later capture call. Capture mitigates this by also
   verifying the PayPal order's `custom_id` (`PAYGUARD:<CURRENCY>:<CENTS>`)
   against the expected quote. For a durable product, replace the
   in-memory store with a database.
4. **Function timeout:** AI calls use a 50-second timeout. If your Vercel
   plan caps function duration below that, raise the plan limit or lower
   the timeout in `api/analyze.js` — see `vercel.json`.
5. **No user accounts in this version.** History is stored in the browser
   only. Raw invoice text is not stored server-side.
