# API reference: protocol types

The hub's wire protocol, as the SDK sees it. All of these are exported from
`@better-claw/sdk`; the types are type-only exports, the three constants are values.

These definitions are **mirrored by hand** from the hub's own source, because the hub's
shared package is private. [`test/protocol-parity.spec.ts`](../test/protocol-parity.spec.ts)
diffs them against a checkout when `BETTERCLAW_REPO` points at one — see
[Testing](testing.md#the-protocol-drift-guard).

Back to the [main reference](api-reference.md).

## Messages

### `ChatMessage`

```ts
interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatMessageRole;
  status: ChatMessageStatus;
  content: string;
  deliverable?: ChatDeliverable[] | null;
  updates?: Array<{ timestamp: string; message: string; status?: string }> | null;
  attachments?: ChatMessageAttachment[] | null;
  errorMessage?: string | null;
  turnIndex: number;
  createdAt?: string;
  updatedAt?: string;
}
```

| Field          | Notes                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `status`       | `'streaming'` while in flight. A failed turn ends at `'error'` — it is a message, not an exception      |
| `content`      | The whole reply so far. Mirrored from streaming frames by the store, then replaced by the persisted row |
| `deliverable`  | Files the turn produced; build a URL with `client.chats.deliverableUrl(chatId, messageId, index)`       |
| `errorMessage` | Present when `status === 'error'`. Partial `content` is preserved alongside it                          |
| `turnIndex`    | Ordinal of the turn within the chat                                                                     |

### `ChatMessageRole`

```ts
type ChatMessageRole = 'user' | 'assistant';
```

### `ChatMessageStatus`

```ts
type ChatMessageStatus = 'streaming' | 'complete' | 'error';
```

Distinct from [`ConversationStatus`](api-reference.md#conversationstatus), which describes
the client's view of a turn rather than the row's persisted state.

### `ChatDeliverable` and `ChatMessageAttachment`

```ts
interface ChatDeliverable {
  filename: string;
  mimeType?: string;
  bytes?: number;
}

interface ChatMessageAttachment {
  filename: string;
  mimeType?: string;
  bytes?: number;
}
```

> Neither is exported from the package root, though both are reachable through
> `ChatMessage`'s inferred type.

## Chats

### `ChatSession`

```ts
interface ChatSession {
  id: string;
  userId: string;
  workspaceId: string | null;
  agentId: string | null;
  agentName: string;
  title: string | null;
  isShared?: boolean;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
```

A chat belongs to one agent, fixed at creation.

### `ChatWithMessages`

```ts
interface ChatWithMessages extends ChatSession {
  messages: ChatMessage[];
}
```

What `GET /chats/:id` returns, and what `ChatStore.applyFetchedChat()` takes.

## Events

### `ChatEvent`

```ts
type ChatEvent =
  | { type: 'connected' }
  | { type: 'chat_upserted'; chat: ChatSession }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'message_upserted'; chatId: string; message: ChatMessage }
  | {
      type: 'message_streaming';
      chatId: string;
      messageId: string;
      content: string;
      status: ChatMessageStatus;
      thinking?: string;
      todos?: TodoChecklistItem[];
      subagents?: SubagentEvent[];
    };
```

Frames on `/ws/chats`. The socket is **receive-only** — the client never sends.

`message_streaming.content` and `.thinking` are **cumulative, not deltas**: each frame
carries the whole text so far, so a reducer must assign rather than append. The gateway
replays the last frame on reconnect, which is where an appending reducer doubles the reply.

`thinking`, `todos`, and `subagents` are transient and never persisted, so only a live
frame (or that replay) can produce them — a REST refetch cannot.

How the store reduces each variant:

| Variant             | Effect                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `connected`         | Ignored                                                                                                          |
| `chat_upserted`     | Replaces `state.chat`                                                                                            |
| `chat_deleted`      | Removes the chat's state and any buffered frames                                                                 |
| `message_upserted`  | Upserts by id, preserving order; drops the `live` entry once the status is terminal                              |
| `message_streaming` | Writes the `live` entry (or deletes it on a terminal status) and mirrors `content`/`status` onto the message row |

### `ChatStreamEvent`

```ts
type ChatStreamEvent = Extract<ChatEvent, { type: 'message_streaming' }>;
```

### `TodoChecklistItem`

```ts
interface TodoChecklistItem {
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}
```

### `SubagentEvent`

```ts
interface SubagentEvent {
  id: string;
  name?: string;
  status: string;
  summary?: string;
}
```

`status` is an open string — the hub does not constrain the vocabulary.

## Auth

### `SdkSessionToken`

```ts
interface SdkSessionToken {
  token: string;
  expiresIn: number;
  expiresAt: string;
  workspaceId: string;
  userId: string;
  agentId: string | null;
  scopes: SdkScope[];
}
```

The response of `POST /auth/sdk-token`, returned by
[`mintSessionToken`](api-reference.md#mintsessiontoken) and exposed by
`SessionTokenAuth.session`. `agentId` is set when the key is pinned to a single agent.
`expiresAt` is an ISO timestamp; `SessionTokenAuth` refreshes 60s before it.

### `SdkScope` and `SDK_SCOPES`

```ts
const SDK_SCOPES = ['chats:read', 'chats:write', 'agents:read', 'workspaces:read'] as const;
type SdkScope = (typeof SDK_SCOPES)[number];
```

### `CLOSE_CODES`

```ts
const CLOSE_CODES = {
  MISSING_TOKEN: 4001,
  USER_NOT_FOUND: 4002,
  AUTH_FAILED: 4003,
  FORBIDDEN: 4004,
  KEY_REVOKED: 4005,
} as const;
```

`/ws/chats` close codes. 4001–4004 predate SDK auth; 4005 is the SDK's own.

### `TERMINAL_CLOSE_CODES`

```ts
const TERMINAL_CLOSE_CODES: ReadonlySet<number>; // {4001, 4004, 4005}
```

Codes after which reconnecting can only fail again. `AUTH_FAILED` (4003) is absent on
purpose: an expired session token is worth one more try after a refresh.

## Workspaces and agents

### `Agent`

```ts
interface Agent {
  id: string;
  name: string;
  workspaceId?: string;
  [key: string]: unknown;
}
```

### `Workspace`

```ts
interface Workspace {
  id: string;
  name?: string;
  [key: string]: unknown;
}
```

Both carry an index signature: the hub returns more fields than the SDK models, and they
pass through untyped. `demo/react` reads `agent.displayName` this way, for instance —
casting is on you.
