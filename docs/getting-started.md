# Getting started

## Install

```bash
npm install @better-claw/sdk
```

Requirements:

- **Node >= 20.** In a browser, anything with `fetch` and `WebSocket`.
- **No runtime dependencies.** React (`>= 18`) and Vue (`>= 3.4`) are optional peers —
  install neither if you use the SDK directly.
- The `ws` package is needed only for streaming from Node, and you pass it in yourself
  (see [Vanilla and Node](vanilla-and-node.md)).

## What you need before writing code

| Thing          | Where it comes from                                                        |
| -------------- | -------------------------------------------------------------------------- |
| An API key     | Your BetterClaw dashboard. Looks like `bc_sk_…`. **A server-side secret.** |
| A hub origin   | `https://api.betterclaw.io`                                                |
| A workspace id | The key is bound to one; `mintSessionToken` returns it in `workspaceId`    |
| An agent id    | `client.agents.list(workspaceId)`                                          |

`workspaceId` is required on every client. The socket is workspace-scoped, and the hub
refuses a key-backed subscription that names no workspace — otherwise it would receive
events from the actor's other workspaces.

## In a browser

The API key must not reach the browser. Your backend exchanges it for a short-lived
session token, and only that token is sent to the page. [Authentication](authentication.md)
covers this in full; the minimum is two pieces.

**1. One route on your server**

```ts
// app/api/bc-token/route.ts  (Next.js; any framework works)
import { mintSessionToken } from '@better-claw/sdk/server';

export async function POST() {
  return Response.json(await mintSessionToken(process.env.BC_API_KEY!, { baseUrl: process.env.BC_API_URL! }));
}
```

**2. The client**

```ts
import { BetterClawClient, SessionTokenAuth } from '@better-claw/sdk';

const fetchToken = async () => (await fetch('/api/bc-token', { method: 'POST' })).json();

// The token carries the workspace the key is bound to, so one call up front
// tells you which workspace this client belongs to.
const session = await fetchToken();

const client = new BetterClawClient({
  baseUrl: 'https://api.betterclaw.io',
  workspaceId: session.workspaceId,
  auth: new SessionTokenAuth(fetchToken),
});
```

`SessionTokenAuth` caches the token and refreshes it a minute before expiry, so the
fetcher is called far less often than once per request.

## In Node

No browser, so the key can be used directly:

```ts
import { WebSocket } from 'ws';
import { createServerClient } from '@better-claw/sdk/server';

const client = createServerClient({
  apiKey: process.env.BC_API_KEY!,
  baseUrl: process.env.BC_API_URL!,
  workspaceId,
  webSocket: WebSocket, // only needed if you stream; see below
});
```

## Your first message

```ts
const [agent] = await client.agents.list(workspaceId);

const { chat, conversation } = await client.startConversation({
  agentId: agent.id,
  agentName: agent.name,
});

conversation.on('status', (s) => console.log('status:', s));
conversation.on('delta', ({ content }) => process.stdout.write(content));

const reply = await conversation.send('Summarise the latest sales numbers');
console.log(reply.content);
```

Three things about that `send` are worth knowing up front:

- **It can take minutes.** An idle agent is a stopped machine; waking it takes up to six
  minutes, or eleven if the wake lands during a shutdown. The status goes to `waking`
  after 10s of silence so you can say so in your UI.
- **It resolves rather than rejects on an agent-side failure.** The returned message has
  `status: 'error'` and an `errorMessage`. Only `TurnTimeoutError` rejects. See
  [Errors](errors.md).
- **`delta` gives you the whole text so far, not a chunk.** Frames are cumulative —
  assign, never append. See [Streaming and state](streaming-and-state.md).

## With a framework

```tsx
// React
import { BetterClawProvider, useChat } from '@better-claw/sdk/react';

<BetterClawProvider client={client}>
  <Chat />
</BetterClawProvider>;

const { messages, status, thinking, todos, send, stop, error } = useChat(chatId);
```

```ts
// Vue
app.use(createBetterClaw(client));

const { messages, status, thinking, todos, send, stop, error } = useChat(chatId);
```

Full details in [React](react.md) and [Vue](vue.md).

## Running the demos

[`demo/react`](../demo/react) and [`demo/vue`](../demo/vue) are the same chat app built
twice, each with the server-side token route wired up as Vite middleware.

```bash
pnpm install && pnpm build
BC_API_KEY=bc_sk_… BC_API_URL=https://api.betterclaw.io pnpm --filter @better-claw/demo-react dev
```

They are the fastest way to see the two behaviours you can only observe in a browser: the
cold-start `waking` state, and resuming a turn after a mid-stream reload.

## Where to go next

- [Authentication](authentication.md) — the credential rules in full
- [Streaming and state](streaming-and-state.md) — what the SDK is actually doing for you
- [API reference](api-reference.md) — every symbol
