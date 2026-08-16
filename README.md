# @better-claw/sdk

JavaScript SDK for chatting with BetterClaw agents. The hub owns the
conversation state; this keeps your UI thin.

```bash
npm install @better-claw/sdk
```

## Documentation

[`docs/`](docs/) has the full guides and API reference — [getting started](docs/getting-started.md),
[authentication](docs/authentication.md), [React](docs/react.md), [Vue](docs/vue.md),
[streaming and state](docs/streaming-and-state.md), [errors](docs/errors.md),
[testing](docs/testing.md), and the [API reference](docs/api-reference.md).

## The idea

Chat state lives on the hub, not in your app. The SDK subscribes to the hub's
WebSocket, reduces the frames into a reactive store, and hands you a message
list. Reconnects, stream replay, and resuming a half-finished turn are handled
for you — see [What the SDK handles for you](#what-the-sdk-handles-for-you),
which is the part that is easy to get wrong by hand.

```tsx
const { messages, status, send, stop } = useChat(chatId);
```

## Auth: the API key stays on your server

An API key (`bc_sk_…`) is a server-side secret. It must not reach a browser —
the hub refuses any raw key whose request carries an `Origin` header, and the
SDK throws if you construct `ApiKeyAuth` where `window` exists.

Browsers use a **session token** instead: short-lived, scoped, minted from your
key by your own backend.

**1. One route in your backend**

```ts
// app/api/bc-token/route.ts  (Next.js; any framework works)
import { mintSessionToken } from '@better-claw/sdk/server';

export async function POST() {
  return Response.json(await mintSessionToken(process.env.BC_API_KEY!, { baseUrl: process.env.BC_API_URL! }));
}
```

**2. The browser client**

```ts
import { BetterClawClient, SessionTokenAuth } from '@better-claw/sdk';

const client = new BetterClawClient({
  baseUrl: 'https://api.betterclaw.io',
  workspaceId,
  auth: new SessionTokenAuth(async () => (await fetch('/api/bc-token', { method: 'POST' })).json()),
});
```

The SDK caches the token and refreshes it a minute before expiry. Revoking the
key kills its outstanding session tokens within one request — the hub re-reads
the key on every call rather than trusting the token's lifetime.

### Node / headless

No browser, so the key can be used directly:

```ts
import { WebSocket } from 'ws';
import { createServerClient } from '@better-claw/sdk/server';

const client = createServerClient({ apiKey: process.env.BC_API_KEY!, baseUrl, workspaceId, webSocket: WebSocket });
```

`webSocket` is only needed if you subscribe to the stream — the key travels as
an upgrade header, which Node's built-in WebSocket cannot send. REST-only
consumers need no `ws` dependency.

## React

```tsx
import { BetterClawProvider, useChat } from '@better-claw/sdk/react';

<BetterClawProvider client={client}>
  <Chat />
</BetterClawProvider>;

function Chat() {
  const { messages, status, thinking, todos, send, stop, error } = useChat(chatId);
  // …
}
```

## Vue

```ts
app.use(createBetterClaw(client));
```

```vue
<script setup lang="ts">
import { useChat } from '@better-claw/sdk/vue';
const { messages, status, thinking, todos, send, stop, error } = useChat(chatId);
</script>
```

## Vanilla

```ts
const { chat, conversation } = await client.startConversation({ agentId, agentName });

conversation.on('status', (s) => console.log(s));
conversation.on('delta', ({ content, thinking }) => render(content, thinking));

const reply = await conversation.send('Summarise the latest sales numbers');
```

## What the SDK handles for you

Each of these is a real trap in the hub's protocol.

**Send and receive are different transports.** `POST /chats/:id/messages`
returns a placeholder in milliseconds; the answer only arrives on the socket.
`conversation.send()` correlates the placeholder id against socket frames and
resolves with the finished message.

**Streamed content is cumulative, not incremental.** Every frame carries the
whole text so far, and the hub replays the last frame on reconnect. A reducer
that appends doubles the reply the first time a socket drops. The SDK assigns.

**Cold starts take minutes, not seconds.** An idle agent is a stopped Fly
machine; waking it can take six minutes, or eleven if the wake lands during a
shutdown. The HTTP call still returns instantly, so the delay is _silence_. The
SDK reports a distinct `waking` status rather than hanging on `sending` — and a
placeholder row is not treated as progress, only real content is.

**Resuming survives a reload.** After a refresh there is no promise left to
await, so `resume()` works off the persisted `streaming` row. The React and Vue
hooks call it on mount, so a chat reattaches to a running turn on its own. If
the turn finished while you were away, it resolves immediately.

**One socket, not one per chat.** The socket is workspace-scoped and already
carries every chat's frames, so navigating between conversations is free and a
background turn is never dropped.

**Ordering on a cold load.** Fetching before connecting loses frames emitted
during the request; connecting first lets the stale REST snapshot overwrite
newer streamed text. The SDK connects, buffers, fetches, then drains the buffer
on top.

## Status values

`idle` → `sending` → `waking` → `streaming` → `complete` | `error`

`waking` appears only when the agent is silent past the threshold (10s by
default). Configure with `conversation: { wakingAfterMs, turnTimeoutMs }`;
`turnTimeoutMs` defaults to 11 minutes to cover the hub's worst-case wake.

## Errors

| Class                   | Status | Meaning                                                         |
| ----------------------- | ------ | --------------------------------------------------------------- |
| `AuthError`             | 401    | Credential missing, expired, or revoked                         |
| `PaymentRequiredError`  | 402    | Out of credits, or the agent is locked on the Free plan         |
| `ForbiddenError`        | 403    | Key lacks a scope, or is bound elsewhere (see `.missingScopes`) |
| `NotFoundError`         | 404    | No such chat, or outside this key's workspace                   |
| `RateLimitError`        | 429    | Throttled (see `.retryAfter`)                                   |
| `AgentUnreachableError` | 5xx    | The agent failed to wake or dropped mid-turn                    |
| `TurnTimeoutError`      | —      | The turn exceeded `turnTimeoutMs`                               |

`PaymentRequiredError` fires _before_ the turn is created, so nothing is pending
when you see it.

## API surface

`client.chats` — `create`, `list`, `get`, `update`, `delete`, `sendMessage`,
`stopMessage`, `deliverableUrl`
`client.agents` — `list`, `get` · `client.workspaces` — `list`, `get`
`client.conversation(id)` — `send`, `stop`, `resume`, `hydrate`, `on`, `messages`, `live`

An API key is bound to one workspace and optionally pinned to one agent; reads
are filtered to that scope, so `workspaces.list()` returns only the bound
workspace.

## Demos

[`demo/react`](demo/react) and [`demo/vue`](demo/vue) are the same chat app
built twice. Both include the server-side token route. Their READMEs cover the
two behaviours you have to see in a browser: the cold-start `waking` state, and
resuming after a mid-turn reload.

## Development

```bash
pnpm install && pnpm build && pnpm test
```

The hub's protocol types are mirrored by hand in `src/protocol/` because
`@openclaw/shared` is private. Before releasing, run the drift guard against a
hub checkout:

```bash
BETTERCLAW_REPO=/path/to/betterclaw pnpm test
```

## License

MIT
