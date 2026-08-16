# Testing

Everything the SDK touches the network with is injectable, so consumer code can be tested
without a hub. The SDK's own suite in [`test/`](../test/) uses exactly these seams.

## Inject `fetch` and the socket

```ts
const client = new BetterClawClient({
  baseUrl: 'http://api.test',
  workspaceId: 'ws-1',
  auth: fakeAuth,
  fetch: fakeFetch,
  createWebSocket: () => fakeSocket(),
});
```

Both are documented injection points, not internals.

## A fake socket

`WebSocketLike` is a small interface, so a fake is a few lines. `connect()` resolves on
**open**, not on construction, so your fake must actually open or the caller will (rightly)
hang:

```ts
import type { WebSocketLike } from '@better-claw/sdk';

function fakeSocket(): WebSocketLike {
  const socket: WebSocketLike = { readyState: 0, close: vi.fn() };
  setTimeout(() => {
    socket.readyState = 1;
    socket.onopen?.({});
  }, 0);
  return socket;
}
```

Push frames by calling `onmessage` with a JSON string:

```ts
socket.onmessage?.({
  data: JSON.stringify({
    type: 'message_streaming',
    chatId: 'c-1',
    messageId: 'm-1',
    content: 'partial',
    status: 'streaming',
  }),
});
```

Close it with a code to exercise reconnect or terminal-credential handling:

```ts
socket.onclose?.({ code: 4005, reason: 'key revoked' }); // terminal — stream stops
socket.onclose?.({ code: 1006 }); // abnormal — reconnects with backoff
```

Capture the URL to assert the credential travelled correctly:

```ts
let url = '';
new BetterClawClient({ ..., createWebSocket: (u) => ((url = u), fakeSocket()) });
await client.connect();
expect(url).toBe('ws://api.test/ws/chats?workspaceId=ws-1&token=bcs_abc');
```

## A fake credential

`AuthProvider` is three methods:

```ts
const fakeAuth = {
  getHeaderToken: async () => 'bcs_test',
  getQueryToken: async () => 'bcs_test',
  invalidate: () => {},
};
```

Return `null` from `getQueryToken` to model a header-only credential like `ApiKeyAuth` —
useful for asserting the token is omitted from the URL.

## Drive the store directly

`ChatStore` is standalone and needs no client. Feed it events and assert the reduction —
the fastest way to test a renderer:

```ts
import { ChatStore } from '@better-claw/sdk';

const store = new ChatStore();

store.applyFetchedChat({
  id: 'c-1',
  userId: 'u-1',
  workspaceId: 'ws-1',
  agentId: 'a-1',
  agentName: 'Ada',
  title: null,
  messages: [{ id: 'm-1', chatId: 'c-1', role: 'assistant', status: 'streaming', content: '', turnIndex: 1 }],
});

store.apply({ type: 'message_streaming', chatId: 'c-1', messageId: 'm-1', content: 'hel', status: 'streaming' });
store.apply({ type: 'message_streaming', chatId: 'c-1', messageId: 'm-1', content: 'hello', status: 'streaming' });

expect(store.get('c-1').messages[0].content).toBe('hello'); // assigned, not appended
```

Replaying the same frame twice — which is what a reconnect does — must not double the
text. That is the single most valuable assertion to keep in your own suite if you wrote a
custom renderer.

To test hydration ordering, call `beginHydration` before applying frames and
`applyFetchedChat` after:

```ts
store.beginHydration('c-1');
store.apply(frameThatArrivesDuringTheFetch); // buffered, not dropped
store.applyFetchedChat(fetchedChat); // seeds, then drains the buffer on top
```

## Construct a `Conversation` directly

`Conversation`'s constructor takes its collaborators, so you can build one without a client
and without a socket:

```ts
const store = new ChatStore();
const chats = {
  get: vi.fn(async () => chatWithMessages),
  sendMessage: vi.fn(async () => ({ userMessage, assistantMessage })),
  stopMessage: vi.fn(async () => ({ ok: true, stopped: true })),
} as any;

const conversation = new Conversation('c-1', chats, store, async () => {}, {
  wakingAfterMs: 1000,
  turnTimeoutMs: 10_000,
});
```

The fourth argument is the `ensureConnected` thunk — `async () => {}` in a test. Shorten
the timings so the `waking` and timeout paths are reachable with fake timers:

```ts
vi.useFakeTimers();

const promise = conversation.send('hello');
await vi.advanceTimersByTimeAsync(0);
expect(conversation.status).toBe('sending'); // placeholder row is not progress

await vi.advanceTimersByTimeAsync(1000);
expect(conversation.status).toBe('waking');

store.apply({
  type: 'message_upserted',
  chatId: 'c-1',
  message: { ...assistantMessage, status: 'complete', content: 'hi' },
});
await expect(promise).resolves.toMatchObject({ content: 'hi' });
```

## Testing components

The React and Vue adapters are thin readers over `ChatStore`, so most component tests only
need a client whose store you can drive:

```tsx
render(
  <BetterClawProvider client={client}>
    <Chat chatId="c-1" />
  </BetterClawProvider>,
);

client.store.apply({ type: 'message_streaming', chatId: 'c-1', messageId: 'm-1', content: 'hi', status: 'streaming' });
```

Two things to remember:

- **Status is readable synchronously** via `conversation.status`, and status events only
  fire on a change. If you assert on a status the component seeded from rather than
  received, there is no event to wait for.
- **The provider does not disconnect on unmount**, so a client shared across tests keeps
  its socket and store. Use a fresh client per test, or call `client.store.reset()`.

## Running the SDK's own tests

```bash
pnpm install && pnpm build && pnpm test
```

Vitest runs in a `node` environment over `src/**/*.spec.ts` and `test/**/*.spec.ts`. The
Playwright suite in [`e2e/`](../e2e/) is excluded and opt-in.

### The protocol drift guard

`src/protocol/` mirrors the hub's wire types by hand, because the hub's own package is
private. [`test/protocol-parity.spec.ts`](../test/protocol-parity.spec.ts) diffs the mirror
against a hub checkout and is skipped unless you point it at one:

```bash
BETTERCLAW_REPO=/path/to/betterclaw pnpm test
```

Run this before releasing. It checks the `ChatEvent` variants, close codes, the scope
vocabulary, and the presence of `thinking` / `todos` / `subagents` on the gateway's
streaming frame.

### End-to-end

```bash
BC_DEMO_URL=http://localhost:5173 BC_E2E_AGENT=<agent-id> pnpm test:e2e
```

Requires a real hub and a live agent. It streams an actual reply, asserts that `bc_sk_`
appears in neither the DOM nor `localStorage`, and reloads mid-turn to confirm the stream
resumes without duplicating text.

## See also

- [Streaming and state](streaming-and-state.md) — the behaviours worth pinning down
- [API reference](api-reference.md)
