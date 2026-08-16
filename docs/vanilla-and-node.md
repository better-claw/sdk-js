# Vanilla and Node

No framework required. `BetterClawClient` and `Conversation` are the whole API; the React
and Vue adapters are thin readers over the same objects.

## A conversation without a framework

```ts
const { chat, conversation } = await client.startConversation({ agentId, agentName });

const offStatus = conversation.on('status', (s) => setBanner(s));
const offDelta = conversation.on('delta', ({ content, thinking, todos }) => render(content, thinking, todos));

const reply = await conversation.send('Summarise the latest sales numbers');
console.log(reply.content);

offStatus();
offDelta();
```

`client.startConversation()` creates the chat, opens the socket, and hands back a
conversation already attached to it. For an existing chat use `client.conversation(id)`
and call `hydrate()` yourself:

```ts
const conversation = client.conversation(chatId);
await conversation.hydrate(); // connect, fetch history, start receiving
await conversation.resume(); // reattach to a turn already running, if any
```

`conversation(id)` returns the **same object** for the same id, every time. It holds no
socket of its own — it is a view over the client-wide store — so constructing one is
cheap and you do not need to cache them yourself.

## Events

`on(event, fn)` returns an unsubscribe function.

| Event     | Signature                              | Fires when                                                              |
| --------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `status`  | `(status: ConversationStatus) => void` | The status **changes** — repeats are suppressed                         |
| `delta`   | `(turn: LiveTurn) => void`             | The live turn snapshot changes: new content, thinking, todos, subagents |
| `message` | `(message: ChatMessage) => void`       | The message count changes; receives the latest message                  |

```ts
conversation.on('delta', (turn) => {
  // `turn.content` is the WHOLE reply so far, not a chunk. Assign, never append.
  output.textContent = turn.content;
  if (turn.thinking) thinkingEl.textContent = turn.thinking;
});
```

The same state is readable synchronously at any time:

```ts
conversation.status; // ConversationStatus
conversation.messages; // ChatMessage[]
conversation.live; // LiveTurn | undefined
```

Call `conversation.dispose()` to drop listeners. It does not touch the socket, which is
client-wide.

## Reading the store directly

If you are wiring your own reactive layer, subscribe to the store rather than to each
conversation. It is shaped for `useSyncExternalStore` and Vue alike, and publishes a fresh
`Map` identity on every change so identity comparison detects it without a deep compare.

```ts
const unsubscribe = client.store.subscribe(() => {
  const state = client.store.get(chatId); // { chat, messages, live, hydrated }
  render(state.messages);
});
```

See [Streaming and state](streaming-and-state.md) for the reducer's contract.

## Node and headless clients

```ts
import { WebSocket } from 'ws';
import { createServerClient } from '@better-claw/sdk/server';

const client = createServerClient({
  apiKey: process.env.BC_API_KEY!,
  baseUrl: process.env.BC_API_URL!,
  workspaceId,
  webSocket: WebSocket,
});
```

`createServerClient` is `new BetterClawClient(...)` with `ApiKeyAuth` and a socket factory
wired in. Everything else — `client.chats`, `client.conversation()`, `client.store` — is
identical.

### Why you pass `webSocket` in

`webSocket` is required **only if you subscribe to the stream**. It is passed in rather
than imported so REST-only consumers need no `ws` dependency at all.

Node's built-in global `WebSocket` is not usable here: it cannot set upgrade headers, and
the header is the only way a raw key may travel — a query string would put the key in
access logs. `ws` can set them, so the transport itself is what enforces "the durable key
stays server-side".

Omit it and any socket connection throws:

> Streaming from Node needs the `ws` package: `import { WebSocket } from "ws"` and pass it
> as `webSocket` to createServerClient. Node's global WebSocket cannot send the
> Authorization header an API key requires.

### REST-only usage

Every resource works without a socket:

```ts
const client = createServerClient({ apiKey, baseUrl, workspaceId }); // no `webSocket`

const chats = await client.chats.list(workspaceId);
const chat = await client.chats.get(chats[0].id);
await client.chats.update(chat.id, { title: 'Q3 review', archived: false });
```

But note that `chats.sendMessage()` returns as soon as the rows are created, **not** when
the agent has answered — the `assistantMessage` it returns is a placeholder. Anything that
waits for a reply needs the socket, and therefore `webSocket`:

```ts
const { assistantMessage } = await client.chats.sendMessage(chatId, 'hello');
assistantMessage.content; // '' — the answer arrives on the socket
```

Use `conversation.send()` for a promise that resolves with the finished reply.

### Node < 18

Pass a `fetch` implementation:

```ts
createServerClient({ apiKey, baseUrl, workspaceId, fetch: nodeFetch });
```

Without one, the client throws `No fetch implementation available — pass one via 'fetch'
(Node < 18).` The package's `engines` field requires Node `>= 20`, so this is mostly
relevant for unusual runtimes.

## A complete headless script

```ts
import { WebSocket } from 'ws';
import { createServerClient } from '@better-claw/sdk/server';
import { TurnTimeoutError } from '@better-claw/sdk';

const client = createServerClient({
  apiKey: process.env.BC_API_KEY!,
  baseUrl: process.env.BC_API_URL!,
  workspaceId: process.env.BC_WORKSPACE_ID!,
  webSocket: WebSocket,
  conversation: { turnTimeoutMs: 15 * 60_000 },
});

const [agent] = await client.agents.list(process.env.BC_WORKSPACE_ID!);
const { conversation } = await client.startConversation({ agentId: agent.id, agentName: agent.name });

conversation.on('status', (s) => console.error(`[${s}]`));

try {
  const reply = await conversation.send(process.argv[2]!);
  if (reply.status === 'error') {
    console.error('agent failed:', reply.errorMessage);
    process.exitCode = 1;
  } else {
    console.log(reply.content);
  }
} catch (err) {
  if (err instanceof TurnTimeoutError) console.error('gave up waiting');
  else throw err;
} finally {
  client.disconnect();
}
```

`client.disconnect()` closes the socket and disposes every cached conversation. A Node
process will not exit while the socket is open, so call it.

## See also

- [Streaming and state](streaming-and-state.md)
- [Errors](errors.md)
- [API reference: `/server`](api-reference.md#better-clawsdkserver)
