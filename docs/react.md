# React

```bash
npm install @better-claw/sdk react
```

React `>= 18` is an optional peer dependency. `useChat` reads through
`useSyncExternalStore`, so 18 is the floor.

## Setup

Create the client once, outside your component tree, and wrap the app:

```tsx
import { BetterClawClient, SessionTokenAuth } from '@better-claw/sdk';
import { BetterClawProvider } from '@better-claw/sdk/react';

const client = new BetterClawClient({
  baseUrl: import.meta.env.VITE_BC_API_URL,
  workspaceId,
  auth: new SessionTokenAuth(async () => (await fetch('/api/bc-token', { method: 'POST' })).json()),
});

createRoot(el).render(
  <BetterClawProvider client={client}>
    <Chat />
  </BetterClawProvider>,
);
```

The provider calls `client.connect()` in an effect keyed on `client`.

> **It does not disconnect on unmount.** The provider usually lives for the app's
> lifetime, and tearing the socket down on a StrictMode double-mount would drop an
> in-flight turn. Call `client.disconnect()` yourself if you genuinely need to.

## `useChat`

```ts
function useChat(chatId: string | null | undefined): UseChatResult;
```

Binds one chat to a component. Passing `null`/`undefined` is supported and returns an
inert result — useful before a chat exists.

| Field      | Type                                                 | Notes                                                          |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `messages` | `ChatMessage[]`                                      | Full history plus the in-flight turn, mirrored onto its row    |
| `status`   | `ConversationStatus`                                 | `idle \| sending \| waking \| streaming \| complete \| error`  |
| `live`     | `LiveTurn \| undefined`                              | Transient per-turn state; `undefined` between turns            |
| `thinking` | `string \| undefined`                                | Shorthand for `live?.thinking`                                 |
| `todos`    | `TodoChecklistItem[] \| undefined`                   | Shorthand for `live?.todos`                                    |
| `loading`  | `boolean`                                            | `!!chatId && !hydrated` — false when `chatId` is null          |
| `error`    | `Error \| null`                                      | Hydrate/resume/send failures; **not** an agent-side error turn |
| `send`     | `(content: string, files?: File[]) => Promise<void>` | Resolves when the turn finishes; never rejects                 |
| `stop`     | `() => Promise<void>`                                | Cancels the in-flight turn; no-op when idle                    |

On mount it **hydrates and then resumes**: a turn already in flight — from a reload, or
another tab — reattaches on its own, because resumption is driven off the persisted
`status: 'streaming'` row rather than a live promise.

```tsx
function Chat({ chatId }: { chatId: string }) {
  const { messages, status, thinking, todos, error, send, stop } = useChat(chatId);
  const busy = status === 'sending' || status === 'waking' || status === 'streaming';

  return (
    <>
      {error && <div className="banner">{error.message}</div>}

      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          {m.content || (m.status === 'streaming' ? '…' : '')}
        </div>
      ))}

      {thinking && <div className="thinking">{thinking}</div>}

      {status === 'waking' && <p>Waking the agent — a cold start can take a few minutes.</p>}

      {busy ? <button onClick={stop}>Stop</button> : <button onClick={() => send(draft)}>Send</button>}
    </>
  );
}
```

### `send` never rejects

It catches and surfaces through `error` instead. Rethrowing would leave every caller
writing the same `try`/`catch`.

```tsx
await send(text); // resolves either way — read `error` afterwards
```

Note the distinction: a failure to _dispatch_ the turn (402, 403, network) lands in
`error`. A turn the agent failed to complete is not an exception at all — it is a message
in `messages` with `status: 'error'` and an `errorMessage`. Render both:

```tsx
{
  messages.map((m) => (
    <div key={m.id} className={`msg ${m.role} ${m.status === 'error' ? 'error' : ''}`}>
      {m.content}
      {m.status === 'error' && m.errorMessage ? `\n${m.errorMessage}` : ''}
    </div>
  ));
}
```

### Sending the very first message

When there is no chat yet, `useChat(null)`'s `send` is a no-op — and even after you set
the id, the `send` from the current render is still bound to `null`. Start the
conversation and send on it directly; the hook picks the turn up from the shared store on
the next render:

```tsx
async function submit(text: string) {
  if (!chatId) {
    const { chat, conversation } = await client.startConversation({ agentId: agent.id, agentName: agent.name });
    setChatId(chat.id);
    // Send on the conversation just created, NOT the hook's `send`: that one is
    // bound to the chatId from this render, which is still null.
    await conversation.send(text);
    return;
  }
  await send(text);
}
```

This is the pattern in [`demo/react/src/Chat.tsx`](../demo/react/src/Chat.tsx).

### Switching chats

Changing `chatId` rebinds cleanly. `status` is seeded synchronously from the new
conversation's current status rather than waiting for an event — status events only fire
on a _change_, so a fresh conversation sitting at `idle` would otherwise leave the hook
stuck on the previous chat's status with no event coming to correct it.

Navigation is cheap: one socket serves every chat in the workspace, so switching does not
reconnect and a turn running in the chat you left is not dropped.

## `useChats`

```ts
function useChats(workspaceId: string): { chats: ChatSession[]; loading: boolean; error: Error | null };
```

Fetches `GET /chats?workspaceId=` on mount and whenever `workspaceId` changes.

> This is a one-shot fetch, not a live list. The socket does carry `chat_upserted` and
> `chat_deleted` frames into `client.store`, but this hook does not re-read them — refetch
> by changing the key, or read `client.store.getSnapshot()` directly if you need a list
> that updates itself.

## `useAgents`

```ts
function useAgents(workspaceId: string): { agents: Agent[]; loading: boolean; error: Error | null };
```

Render `error`. A swallowed failure here shows an empty agent list with no explanation,
which is indistinguishable from a workspace that genuinely has none:

```tsx
const { agents, error } = useAgents(workspaceId);
if (error) return <div className="banner">Could not load agents: {error.message}</div>;
```

## `useWorkspaces`

```ts
function useWorkspaces(): { workspaces: Workspace[]; loading: boolean };
```

No `error` field — unlike the other list hooks. Catch failures via
`client.workspaces.list()` directly if you need to distinguish "failed" from "none".

For an API key this returns only the workspace the key is bound to.

## `useBetterClaw`

```ts
function useBetterClaw(): BetterClawClient;
```

The client from context. Throws `useBetterClaw must be used inside <BetterClawProvider>`
when there is no provider above. Use it for anything the hooks do not cover —
`client.startConversation()`, `client.chats.getDeliverable()`, `client.connected`.

## Rendering deliverables

`client.chats.getDeliverable(message, index)` returns the selected generated
file using the client's authentication. The index is zero-based and defaults
to `0`. This component reads the first CSV deliverable as text; render it inside
your existing `BetterClawProvider` and pass an assistant message from `useChat`:

```tsx
import { useState } from 'react';
import type { ChatMessage } from '@better-claw/sdk';
import { useBetterClaw } from '@better-claw/sdk/react';

function CsvContents({ message }: { message: ChatMessage }) {
  const client = useBetterClaw();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function readFile() {
    setError(null);
    try {
      const file = await client.chats.getDeliverable(message, 0);
      setText(await file.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the file.');
    }
  }

  const deliverable = message.deliverable?.[0];
  if (!deliverable) return null;
  return (
    <>
      <button type="button" onClick={readFile}>
        Read {deliverable.filename}
      </button>
      {error && <p role="alert">{error}</p>}
      <pre>{text}</pre>
    </>
  );
}
```

The returned `File` provides `name`, `type`, and `size`. Use `.text()` for text
files, `.arrayBuffer()` for binary content, or `URL.createObjectURL(file)` for
previewing or downloading. Revoke object URLs when finished using them.
The SDK handles token refresh and typed API errors, and the hub's inline route
supports files up to 50 MB.

For a complete download button with loading and error states, see
[`demo/react/src/Deliverables.tsx`](../demo/react/src/Deliverables.tsx). It uses
the same SDK method, then saves the returned file with the demo's small
[`saveFile`](../demo/files.ts) DOM helper. No auth prop or manual fetch is needed.

## See also

- [Streaming and state](streaming-and-state.md) — what `status` and `live` actually mean
- [Errors](errors.md)
- [API reference: React](api-reference.md#better-clawsdkreact)
- [`demo/react`](../demo/react) — a complete working app
