# Streaming and state

This is what the SDK is actually doing for you. Each section below is a real trap in the
hub's protocol — the kind that works in development and breaks the first time a socket
drops or a page reloads mid-turn.

## Send and receive are different transports

`POST /chats/:id/messages` returns in milliseconds. It does **not** return the answer:

```ts
const { userMessage, assistantMessage } = await client.chats.sendMessage(chatId, 'hello');
assistantMessage.content; // '' — a placeholder row, not the reply
```

The hub dispatches the turn in the background and the reply arrives over `/ws/chats`. The
placeholder exists so the caller has an id to correlate against.

`conversation.send()` does that correlation for you: it takes the id from the placeholder
and settles when a frame for _that id_ reaches a terminal state.

```ts
const reply = await conversation.send('hello'); // resolves with the finished message
```

Correlating on "the newest message" instead would attach to the wrong turn whenever two
turns overlap — a second tab, or a background chat.

## Streamed content is cumulative, not incremental

Every `message_streaming` frame carries **the whole text so far**. `content` and
`thinking` are assigned, never appended:

```ts
// The reducer, correctly:
live[event.messageId] = { messageId: event.messageId, content: event.content /* ASSIGN */ };
```

This matters because the gateway replays the last frame on every reconnect. A reducer that
appends silently doubles the reply the first time a socket drops — which, in development,
is never, and in production is constantly.

If you consume `delta` events or read the store yourself, assign:

```ts
conversation.on('delta', (turn) => {
  output.textContent = turn.content; // assign, not `+=`
});
```

`thinking`, `todos`, and `subagents` are **transient**: the hub never persists them. Only
a live frame (or the gateway's replay on reconnect) can produce them — a REST refetch
cannot. So after a reload you get the message text back but not the thinking that produced
it.

## Cold starts take minutes, not seconds

An idle agent is a stopped machine. Waking it can take six minutes, or eleven if the wake
lands during a shutdown. The HTTP call still returns instantly, so the delay is _silence_ —
a waking agent looks exactly like a stalled one.

The SDK reports a distinct `waking` status after 10s of quiet so your UI can say so:

```tsx
{
  status === 'waking' && <p>Waking the agent — a cold start can take a few minutes.</p>;
}
```

Crucially, **a placeholder row is not progress**. The hub creates the assistant row as
`streaming` the instant the POST lands, long before the agent has said anything. The SDK
only reports `streaming` once there is real content:

```ts
if (message.content || live?.content || live?.thinking || live?.todos?.length) {
  // genuinely producing
}
```

## The status machine

```
idle → sending → waking → streaming → complete | error
```

| Status      | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `idle`      | Nothing in flight                                                              |
| `sending`   | Turn dispatched; nothing produced yet. Also what a silent resumed turn reports |
| `waking`    | Still silent past `wakingAfterMs`. The agent is probably cold-starting         |
| `streaming` | Real content, thinking, or todos are arriving                                  |
| `complete`  | Terminal. The message is final                                                 |
| `error`     | Terminal. The turn failed, or the deadline passed                              |

Details that matter in practice:

- **`waking` only fires from `sending`.** If the turn already reached `streaming`, the
  timer does nothing — a long pause mid-reply is not a cold start.
- **Status events only fire on a change.** Nothing repeats. This is why the React and Vue
  adapters seed from `conversation.status` synchronously instead of waiting for an event:
  a fresh conversation starts at `idle` and there would be no event to correct a stale
  value.
- **`error` does not mean an exception.** `send()` _resolves_ with a message whose
  `status` is `'error'`. See [Errors](errors.md).
- Configure the thresholds per client:

  ```ts
  new BetterClawClient({ ..., conversation: { wakingAfterMs: 10_000, turnTimeoutMs: 11 * 60_000 } });
  ```

  `turnTimeoutMs` defaults to 11 minutes to cover the hub's worst-case wake. It is
  deliberately **not** an HTTP timeout — the request already returned.

## Resuming survives a reload

After a refresh there is no promise left to await. `resume()` works off the persisted
`status: 'streaming'` row instead:

```ts
const reply = await conversation.resume(); // ChatMessage, or null if nothing was running
```

It hydrates first if needed, then finds the in-flight assistant row and waits for it, just
as `send()` would. If the turn finished while the page was away it resolves immediately —
there is no live snapshot left to replay and the fetched row is already final. If nothing
was running it resolves `null` and emits `idle`.

The React and Vue hooks call `resume()` on mount, so a chat reattaches to a running turn
on its own. Nothing to wire up.

## Ordering on a cold load

Both naive orders lose data:

- **Fetch, then connect** — loses any frame emitted during the request.
- **Connect, then fetch** — lets the older REST snapshot overwrite newer streamed text.

So `hydrate()` does neither. It buffers first:

```
beginHydration()  →  connect  →  GET /chats/:id  →  seed  →  drain the buffer on top
```

A frame arriving for a chat whose fetch is still in flight is held, not dropped, and
replayed once the snapshot lands.

## One socket, not one per chat

The socket is workspace-scoped and already carries frames for **every** chat. So:

- `client.conversation(id)` is a cheap view over shared state, not a new connection.
- Navigating between conversations is free.
- A turn running in a chat you navigated away from is not dropped — it keeps updating the
  store, and the messages are there when you come back.

A socket per conversation would drop an in-flight turn the moment the user navigated away.

## Reconnection

Handled automatically, with backoff:

```
attempt = min(attempt + 1, 6)
delay   = min(1000 * 2 ** attempt, 30_000)
```

so 2s, 4s, 8s, 16s, 30s, 30s… The counter resets to 0 on a successful open.

In a browser the stream also reconnects **immediately** — skipping the remaining backoff —
on `visibilitychange` (when visible), `online`, and `focus`. A backgrounded tab has its
timers throttled, so without this a mid-turn stream can stay blank for many seconds after
the user comes back.

Reconnection stops permanently on a terminal close code:

| Code   | Constant         | Terminal |
| ------ | ---------------- | -------- |
| `4001` | `MISSING_TOKEN`  | yes      |
| `4002` | `USER_NOT_FOUND` | no       |
| `4003` | `AUTH_FAILED`    | no       |
| `4004` | `FORBIDDEN`      | yes      |
| `4005` | `KEY_REVOKED`    | yes      |

`AUTH_FAILED` is absent from `TERMINAL_CLOSE_CODES` on purpose: an expired session token is
worth one more try after a refresh. Retrying a genuinely dead credential is a hot loop
against the auth endpoint that can never succeed, so those codes stop and set
`client.lastAuthError` instead.

```ts
if (client.lastAuthError) {
  // the credential is dead; re-authenticate the user
}
```

Frames that fail to parse are swallowed — not worth tearing the socket down for.

## The store

`ChatStore` is the single source of truth; both framework adapters are thin readers over
it. Per chat:

```ts
interface ChatState {
  chat: ChatSession | null;
  messages: ChatMessage[];
  live: Record<string, LiveTurn>; // keyed by messageId, usually 0 or 1 entries
  hydrated: boolean;
}
```

`live` holds the transient per-turn state (`content`, `thinking`, `todos`, `subagents`).
Streaming text is also **mirrored onto the message row** so a renderer can read one list
rather than merging two:

```tsx
{
  messages.map((m) => <div key={m.id}>{m.content || (m.status === 'streaming' ? '…' : '')}</div>);
}
```

Once a turn ends, the persisted row is the truth and the `live` entry is dropped, so
transient text cannot outlive it.

Subscribing:

```ts
const unsubscribe = client.store.subscribe(() => {
  const { messages, live, hydrated } = client.store.get(chatId);
});
```

Every publish creates a fresh `Map` identity, so React and Vue detect the change by
identity without a deep compare. `getSnapshot` and `subscribe` are bound arrow properties —
pass them straight to `useSyncExternalStore`.

## See also

- [Errors](errors.md) — which failures throw and which arrive as messages
- [Testing](testing.md) — driving the store and a fake socket directly
- [API reference: `ChatStore`](api-reference.md#chatstore) and
  [`ChatEventStream`](api-reference.md#chateventstream)
