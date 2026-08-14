# BetterClaw SDK — React demo

A minimal but complete chat app: streaming replies, thinking text, todo
checklist, stop button, and an error banner that tells billing failures apart
from auth failures.

The [Vue](../vue) and [React](../react) demos are deliberately the same app, so
the two adapters can be read side by side.

## Run

Start the hub API first, then an agent, then this:

```bash
export BC_API_KEY=bc_sk_...          # created in the dashboard
export BC_API_URL=http://localhost:3001
pnpm --filter @better-claw/demo-react dev
```

Open http://localhost:5173.

## Where the API key lives

Not in the browser. `BC_API_KEY` is read only by [`demo/token-route.ts`](../token-route.ts),
which exchanges it for a short-lived session token; the page fetches that token
from `/api/bc-token`. In a real app that route is one handler in your own
backend. You can confirm the separation:

```bash
pnpm --filter @better-claw/demo-react build
grep -c ApiKeyAuth demo/react/dist/assets/*.js   # 0
```

## Two behaviours worth seeing

Neither is visible in a screenshot, and neither is reproducible in CI:

1. **Cold start.** Leave the agent idle past its 90s TTL, then send a message.
   The status turns to _waking_ and stays there — a Fly machine start can take
   minutes. The point is that this is a distinct state, not a hang.

2. **Resume after reload.** Send something that takes a while, then hard-reload
   mid-answer. The reply picks straight back up, because resumption is driven
   off the persisted `streaming` row rather than an in-memory promise. Try
   toggling offline mid-stream too: the text completes without duplicating,
   which is the cumulative-vs-delta trap the SDK handles for you.
