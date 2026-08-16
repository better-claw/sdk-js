# API reference

Every exported symbol, by entry point. Protocol types live in
[api-reference-protocol.md](api-reference-protocol.md).

- [`@better-claw/sdk`](#better-clawsdk) — client, conversation, auth, store, stream, resources, errors
- [`@better-claw/sdk/server`](#better-clawsdkserver) — Node only
- [`@better-claw/sdk/react`](#better-clawsdkreact)
- [`@better-claw/sdk/vue`](#better-clawsdkvue)
- [Protocol types](api-reference-protocol.md) — wire types and constants

---

## `@better-claw/sdk`

### `BetterClawClient`

```ts
class BetterClawClient {
  constructor(opts: BetterClawClientOptions);

  readonly chats: ChatsResource;
  readonly agents: AgentsResource;
  readonly workspaces: WorkspacesResource;
  readonly store: ChatStore;

  connect(): Promise<void>;
  get connected(): boolean;
  get lastAuthError(): { code: number; reason: string } | null;
  conversation(chatId: string): Conversation;
  startConversation(
    input: Omit<CreateChatInput, 'workspaceId'> & { workspaceId?: string },
  ): Promise<{ chat: ChatSession; conversation: Conversation }>;
  disconnect(): void;
}
```

Holds **one** socket for the whole client, not one per conversation. The socket is
workspace-scoped and already carries frames for every chat, so `conversation()` is a cheap
view over shared state — which is what makes navigating between chats free and keeps a
background turn from being dropped.

Throws `workspaceId is required` if `opts.workspaceId` is empty.

| Member                | Notes                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`           | Opens the socket if not already open. Idempotent and concurrency-safe. Resolves on **open**, or when the attempt fails — reconnection continues in the background either way, so it never hangs while the hub is down. |
| `connected`           | Whether the socket is currently open.                                                                                                                                                                                  |
| `lastAuthError`       | Set once the socket closed with a terminal code (4001/4004/4005) — the credential is dead.                                                                                                                             |
| `conversation(id)`    | Repeated calls for the same id return the **same object**.                                                                                                                                                             |
| `startConversation()` | Creates the chat, awaits `connect()`, returns a conversation attached to it. `workspaceId` defaults to the client's.                                                                                                   |
| `disconnect()`        | Closes the socket and disposes every cached conversation.                                                                                                                                                              |

The socket URL is `${baseUrl}/ws/chats?workspaceId=<id>[&token=<queryToken>]`, with
`https:` upgraded to `wss:` and anything else to `ws:`.

#### `BetterClawClientOptions`

```ts
interface BetterClawClientOptions {
  baseUrl: string;
  auth: AuthProvider;
  workspaceId: string;
  fetch?: typeof fetch;
  createWebSocket?: WebSocketFactory;
  conversation?: ConversationOptions;
}
```

| Field             | Type                  | Default                | Notes                                                                                               |
| ----------------- | --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `baseUrl`         | `string`              | required               | Hub origin, `https://api.betterclaw.io`. Trailing slashes are stripped                              |
| `auth`            | `AuthProvider`        | required               | See [Authentication](authentication.md)                                                             |
| `workspaceId`     | `string`              | required               | The socket is workspace-scoped; a key-backed subscription naming no workspace is refused by the hub |
| `fetch`           | `typeof fetch`        | `globalThis.fetch`     | Throws at construction if neither is available                                                      |
| `createWebSocket` | `WebSocketFactory`    | `globalThis.WebSocket` | Required when `auth.getQueryToken()` returns `null`                                                 |
| `conversation`    | `ConversationOptions` | `{}`                   | Applied to every `Conversation` this client creates                                                 |

If `getQueryToken()` resolves `null` and no `createWebSocket` was supplied, connecting
throws:

> This credential cannot open a WebSocket on its own — an API key must not appear in a
> URL. Use createServerClient() from "@better-claw/sdk/server" in Node, or a session token
> in a browser.

---

### `Conversation`

```ts
class Conversation {
  constructor(
    chatId: string,
    chats: ChatsResource,
    store: ChatStore,
    ensureConnected: () => Promise<void>,
    opts?: ConversationOptions,
  );

  readonly chatId: string;
  get status(): ConversationStatus;
  get messages(): ChatMessage[];
  get live(): LiveTurn | undefined;

  on<K extends keyof ConversationEvents>(event: K, fn: ConversationEvents[K]): () => void;
  hydrate(): Promise<void>;
  send(content: string, files?: File[]): Promise<ChatMessage>;
  resume(): Promise<ChatMessage | null>;
  stop(): Promise<void>;
  dispose(): void;
}
```

A view over one chat. Cheap to construct — it holds no socket of its own and reads from
the client-wide store. Normally obtained from `client.conversation(id)` or
`client.startConversation()`; the constructor is public mainly so it can be built with
test doubles (see [Testing](testing.md)).

| Member      | Notes                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`    | Readable synchronously. Status _events_ only fire on a change, so seed from this rather than waiting for one                                                                                                           |
| `messages`  | The store's message list for this chat                                                                                                                                                                                 |
| `live`      | Transient state for the in-flight turn: thinking text, todos, subagents. `undefined` between turns                                                                                                                     |
| `on()`      | Returns an unsubscribe function                                                                                                                                                                                        |
| `hydrate()` | `beginHydration` → `connect` → `GET /chats/:id` → seed → drain. Safe to call repeatedly                                                                                                                                |
| `send()`    | Resolves with the **finished** reply. Correlates on the placeholder's id, so overlapping turns do not cross                                                                                                            |
| `resume()`  | Reattaches to a turn already in flight, off persisted state. Resolves `null` (and emits `idle`) when nothing is running; resolves immediately when the turn finished while the page was away. Hydrates first if needed |
| `stop()`    | Cancels the in-flight turn. The hub finalizes it, so a terminal frame still arrives. No-op when idle                                                                                                                   |
| `dispose()` | Drops listeners. The socket is client-wide and is not affected                                                                                                                                                         |

**`send()` and `resume()` resolve with a `status: 'error'` message when the turn fails —
they do not reject.** The only rejection is `TurnTimeoutError`. See [Errors](errors.md).

#### `ConversationStatus`

```ts
type ConversationStatus = 'idle' | 'sending' | 'waking' | 'streaming' | 'complete' | 'error';
```

`idle → sending → waking → streaming → complete | error`. `waking` only fires while the
status is still `sending`; `streaming` only once real content, thinking, or todos have
arrived — a bare placeholder row is not progress. Full semantics in
[Streaming and state](streaming-and-state.md#the-status-machine).

#### `ConversationEvents`

```ts
interface ConversationEvents {
  status: (status: ConversationStatus) => void;
  delta: (turn: LiveTurn) => void;
  message: (message: ChatMessage) => void;
}
```

| Event     | Fires when                                             |
| --------- | ------------------------------------------------------ |
| `status`  | The status changes. Repeats are suppressed             |
| `delta`   | The live turn snapshot changes                         |
| `message` | The message count changes; receives the latest message |

#### `ConversationOptions`

```ts
interface ConversationOptions {
  wakingAfterMs?: number;
  turnTimeoutMs?: number;
}
```

| Field           | Default            | Notes                                                                                                                                                                                  |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakingAfterMs` | `10_000`           | Silence after which the agent is assumed to be cold-starting. The HTTP call returns instantly, so a waking agent looks exactly like a stalled one until the first frame lands          |
| `turnTimeoutMs` | `660_000` (11 min) | How long a turn may take in total: the hub's wake budget is 6 minutes, plus 5 more if the wake lands mid-shutdown. Deliberately **not** an HTTP timeout — the request already returned |

---

### Authentication

#### `AuthProvider`

```ts
interface AuthProvider {
  getHeaderToken(): Promise<string>;
  getQueryToken(): Promise<string | null>;
  invalidate(): void;
}
```

Two credential shapes exist and they are not interchangeable: `bc_sk_…` is the durable
key, a server-side secret the hub refuses outright if the request carries an `Origin`
header; `bcs_…` is a short-lived session token exchanged from a key, safe in a browser and
the only thing that may ride in the WS query string.

| Method             | Purpose                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `getHeaderToken()` | Credential for the `Authorization: Bearer` header                                                 |
| `getQueryToken()`  | Credential for `?token=` on the WS upgrade, or `null` when this provider must not appear in a URL |
| `invalidate()`     | Called after a 401 so a cached token can be discarded                                             |

#### `SessionTokenAuth`

```ts
class SessionTokenAuth implements AuthProvider {
  constructor(fetcher: SessionTokenFetcher);
  getHeaderToken(): Promise<string>;
  getQueryToken(): Promise<string | null>;
  invalidate(): void;
  get session(): SdkSessionToken | null;
}
```

The browser strategy. Holds no durable secret — it calls back to your own endpoint, which
is where the API key lives.

- Caches the token and refreshes it **60s before** `expiresAt`, so a request never races
  the clock.
- Collapses concurrent refreshes into a single in-flight fetch.
- Does not cache a failed fetch.
- `session` exposes the token's claims once one has been fetched.

#### `SessionTokenFetcher`

```ts
type SessionTokenFetcher = () => Promise<SdkSessionToken> | SdkSessionToken;
```

Typically a POST to your own backend.

> `ApiKeyAuth` is exported only from [`@better-claw/sdk/server`](#apikeyauth).

---

### `ChatStore`

```ts
class ChatStore {
  constructor();

  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => StoreSnapshot;
  get(chatId: string): ChatState;

  beginHydration(chatId: string): void;
  applyFetchedChat(chat: ChatWithMessages): void;
  apply(event: ChatEvent): void;

  liveTurn(chatId: string, messageId: string): LiveTurn | undefined;
  streamingMessage(chatId: string): ChatMessage | undefined;
  reset(): void;
}
```

Reduces `/ws/chats` frames into per-chat state. `subscribe` and `getSnapshot` are bound
arrow properties, so they can be passed straight to `useSyncExternalStore`. Every publish
creates a fresh `Map` identity, so React and Vue detect changes by identity without a deep
compare.

| Member               | Notes                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `get(chatId)`        | Returns an empty `ChatState` for an unknown chat rather than `undefined`                                   |
| `beginHydration()`   | Start buffering frames for a chat before its history is fetched                                            |
| `applyFetchedChat()` | Seed from `GET /chats/:id`, then replay whatever arrived meanwhile                                         |
| `apply(event)`       | The reducer. `connected` is ignored; `chat_deleted` removes the state and any pending buffer               |
| `liveTurn()`         | The live snapshot for a turn, if one is streaming                                                          |
| `streamingMessage()` | The in-flight assistant turn, from **persisted** state — this is what makes resumption work after a reload |
| `reset()`            | Clears all state and buffers                                                                               |

Two traps it exists to absorb:

- **`content` and `thinking` are cumulative.** Each frame carries the whole text so far, so
  they are assigned, never appended. The gateway replays the last frame on every reconnect,
  so an appending reducer silently doubles the reply the first time a socket drops.
- **A frame can arrive for a chat that has not been fetched yet.** It is buffered rather
  than dropped. Fetching first loses any frame emitted during the request; connecting first
  lets the older REST snapshot overwrite newer streamed text. So: buffer → fetch → seed →
  drain.

On `message_streaming` the store also mirrors `content` and `status` onto the message row,
so a renderer can read one list. Once a turn reaches a terminal status the `live` entry is
deleted and the persisted row wins.

#### `ChatState`

```ts
interface ChatState {
  chat: ChatSession | null;
  messages: ChatMessage[];
  live: Record<string, LiveTurn>;
  hydrated: boolean;
}
```

`live` is keyed by messageId — usually 0 or 1 entries. `hydrated` is true once the full
history has been fetched.

#### `LiveTurn`

```ts
interface LiveTurn {
  messageId: string;
  content: string;
  thinking?: string;
  todos?: TodoChecklistItem[];
  subagents?: SubagentEvent[];
}
```

Transient per-turn state. **None of it is persisted by the hub** — only a live frame (or
the gateway's replay on reconnect) can produce it; a REST refetch cannot.

#### `StoreSnapshot`

```ts
type StoreSnapshot = ReadonlyMap<string, ChatState>;
```

---

### `ChatEventStream`

```ts
class ChatEventStream {
  constructor(opts: ChatEventStreamOptions);
  connected: boolean;
  connect(): Promise<void>;
  reconnectNow: () => void;
  disconnect(): void;
}
```

The `/ws/chats` subscription: one socket per client, **receive-only** — the client never
sends. `BetterClawClient` owns one; you rarely construct it yourself.

`connected` is a public field, not a getter. `reconnectNow` is a bound arrow — safe to pass
as an event listener.

| Member           | Notes                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `connect()`      | Resolves once the socket is **open**, or when this attempt fails — retries continue in the background rather than hanging the caller |
| `reconnectNow()` | Skip the remaining backoff. No-op when a socket is already open or connecting, or after an intentional disconnect                    |
| `disconnect()`   | Intentional close; stops reconnection and releases anyone awaiting the current attempt                                               |

Backoff: `attempt = min(attempt + 1, 6)`, `delay = min(1000 * 2 ** attempt, 30_000)`,
reset to 0 on a successful open. In a browser it also reconnects immediately on
`visibilitychange` (when visible), `online`, and `focus`. Terminal close codes
(`TERMINAL_CLOSE_CODES`) stop reconnection permanently and fire `onAuthError`.
Unparseable frames are ignored.

> `ChatEventStreamOptions` is **not** exported from the package root. Its fields are
> `url: () => Promise<string>` (resolved fresh on every connect, so a reconnect never
> reuses a dead token), `onEvent: (event: ChatEvent) => void`,
> `onStatusChange?: (connected: boolean) => void`,
> `onAuthError?: (code: number, reason: string) => void`, and
> `createWebSocket?: WebSocketFactory`.

#### `WebSocketLike`

```ts
interface WebSocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: any) => void): void;
  onopen?: ((ev: any) => void) | null;
  onmessage?: ((ev: any) => void) | null;
  onclose?: ((ev: any) => void) | null;
  onerror?: ((ev: any) => void) | null;
}
```

The minimal shape shared by the browser `WebSocket` and the `ws` package — and small
enough to fake in a test.

#### `WebSocketFactory`

```ts
type WebSocketFactory = (url: string) => WebSocketLike;
```

The default uses `globalThis.WebSocket` and throws when there is none:

> No WebSocket implementation found. In Node, import the client from
> "@better-claw/sdk/server", which supplies one.

---

### Resources

Reached through `client.chats`, `client.agents`, `client.workspaces`. Each takes an
`HttpTransport` in its constructor.

#### `ChatsResource`

```ts
class ChatsResource {
  create(input: CreateChatInput): Promise<ChatSession>;
  list(workspaceId: string): Promise<ChatSession[]>;
  get(chatId: string): Promise<ChatWithMessages>;
  update(chatId: string, patch: { title?: string; archived?: boolean }): Promise<ChatSession>;
  delete(chatId: string): Promise<unknown>;
  sendMessage(chatId: string, content: string, files?: File[]): Promise<SendMessageResult>;
  stopMessage(chatId: string, messageId: string): Promise<{ ok: boolean; stopped: boolean }>;
  deliverableUrl(chatId: string, messageId: string, index: number): string;
}
```

| Method           | Endpoint                             | Notes                                                                                                                  |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `create`         | `POST /chats`                        |                                                                                                                        |
| `list`           | `GET /chats?workspaceId=`            |                                                                                                                        |
| `get`            | `GET /chats/:id`                     | Chat plus full message history                                                                                         |
| `update`         | `PATCH /chats/:id`                   |                                                                                                                        |
| `delete`         | `DELETE /chats/:id`                  |                                                                                                                        |
| `sendMessage`    | `POST /chats/:id/messages`           | Returns as soon as the rows are created — **not** when the agent has answered. `files` switches the body to `FormData` |
| `stopMessage`    | `POST /chats/:id/messages/:mid/stop` | Idempotent — stopping an already-finished turn is a no-op, not an error                                                |
| `deliverableUrl` | —                                    | Builds a URL for a produced file. The request needs the caller's credential                                            |

Use `client.conversation(id).send()` for a promise that resolves with the reply.

#### `AgentsResource`

```ts
class AgentsResource {
  list(workspaceId: string): Promise<Agent[]>; // GET /workspaces/:ws/agents
  get(workspaceId: string, agentId: string): Promise<Agent>; // GET /workspaces/:ws/agents/:id
}
```

#### `WorkspacesResource`

```ts
class WorkspacesResource {
  list(): Promise<Workspace[]>; // GET /workspaces
  get(workspaceId: string): Promise<Workspace>; // GET /workspaces/:id
}
```

For an API key, `list()` returns only the workspace the key is bound to.

#### `CreateChatInput`

```ts
interface CreateChatInput {
  workspaceId: string;
  agentId: string;
  agentName: string;
  title?: string;
}
```

`client.startConversation()` accepts the same shape with `workspaceId` optional, defaulting
to the client's.

#### `SendMessageResult`

```ts
interface SendMessageResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}
```

`assistantMessage` is a **placeholder, not the answer**. The hub dispatches the turn in the
background and the reply arrives over `/ws/chats`; this row exists so the caller has an id
to correlate against.

---

### `HttpTransport`

```ts
class HttpTransport {
  constructor(opts: { baseUrl: string; auth: AuthProvider; fetch?: typeof fetch });
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
  queryToken(): Promise<string>;
  get origin(): string;
}
```

A thin `fetch` wrapper: auth header, query building, error normalization, and a single
retry after a 401. Exported for advanced use — the resources are built on it — but most
apps never touch it.

| Behaviour       | Detail                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Base URL        | Trailing slashes stripped; `origin` returns the cleaned value                                          |
| Content type    | `application/json` set only for non-`FormData` bodies — a multipart boundary must be runtime-generated |
| `204`           | Resolves `undefined`                                                                                   |
| Non-JSON bodies | Fall back to raw text                                                                                  |
| 401             | Invalidates the credential, re-fetches the header token, retries **exactly once**                      |
| `queryToken()`  | Throws `AuthError` when `getQueryToken()` returns `null`                                               |

Missing `fetch` throws at construction: `No fetch implementation available — pass one via
'fetch' (Node < 18).`

> `TransportOptions` and `RequestOptions` are not exported from the package root.
> `RequestOptions` is `{ method?: string /* 'GET' */; query?: Record<string, string | number | boolean | undefined>; body?: unknown; signal?: AbortSignal }`;
> `undefined` query values are skipped.

---

### Errors

```ts
class BetterClawError extends Error {
  constructor(message: string, status: number, code: string, body?: unknown);
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
}
```

`name` is set to the subclass name. `body` is the parsed response body, when there was one.

| Class                   | Constructor                                    | `status` | `code`              |
| ----------------------- | ---------------------------------------------- | -------- | ------------------- |
| `AuthError`             | `(message, body?)`                             | 401      | `unauthorized`      |
| `PaymentRequiredError`  | `(message, body?)`                             | 402      | `payment_required`  |
| `ForbiddenError`        | `(message, body?)`                             | 403      | `forbidden`         |
| `NotFoundError`         | `(message, body?)`                             | 404      | `not_found`         |
| `RateLimitError`        | `(message, retryAfter: number \| null, body?)` | 429      | `rate_limited`      |
| `AgentUnreachableError` | `(message, body?)`                             | 503      | `agent_unreachable` |
| `TurnTimeoutError`      | `(message)`                                    | 408      | `turn_timeout`      |

Extra members:

- `ForbiddenError.missingScopes: string[]` — parsed from a `missing scope(s): …` message,
  `[]` when the hub did not name them.
- `RateLimitError.retryAfter: number | null` — seconds, from `Retry-After`. Requires the
  header to be CORS-exposed, so it is often `null` in a browser.

Status mapping: 401/402/403/404/429 map to their classes; **502, 503, and 504** all map to
`AgentUnreachableError` (with `status` reported as `503`); anything else becomes
`BetterClawError` with code `http_error`. `TurnTimeoutError` is client-side only.

Nest returns `message` as a string or an array of strings; arrays are joined with `', '`.
See [Errors](errors.md) for which failures throw and which arrive as messages.

---

## `@better-claw/sdk/server`

Node only. Everything here either holds the durable API key or needs a Node WebSocket, so
it is kept out of `.` — that separation is what makes `ApiKeyAuth` structurally
unreachable from a browser bundle rather than merely discouraged.

### `createServerClient`

```ts
function createServerClient(opts: ServerClientOptions): BetterClawClient;
```

A headless client that sends the raw key directly. The key rides the `Authorization`
header on REST _and_ on the WebSocket upgrade — never the query string, which would put it
in access logs.

#### `ServerClientOptions`

```ts
interface ServerClientOptions extends Omit<BetterClawClientOptions, 'auth' | 'createWebSocket'> {
  apiKey: string;
  webSocket?: NodeWebSocketCtor;
}
```

So: `{ apiKey, baseUrl, workspaceId, fetch?, conversation?, webSocket? }`.

`webSocket` is required **only if you subscribe to the stream**. It is passed in rather
than imported so REST-only consumers need no `ws` dependency at all. Node's built-in global
`WebSocket` is not usable: it cannot set upgrade headers, and the header is the only way a
raw key may travel. Omitting it and then connecting throws:

> Streaming from Node needs the `ws` package: `import { WebSocket } from "ws"` and pass it
> as `webSocket` to createServerClient. Node's global WebSocket cannot send the
> Authorization header an API key requires.

### `NodeWebSocketCtor`

```ts
type NodeWebSocketCtor = new (url: string, opts: { headers: Record<string, string> }) => unknown;
```

The constructor shape of the `ws` package's `WebSocket`.

### `mintSessionToken`

```ts
function mintSessionToken(apiKey: string, opts: MintSessionTokenOptions): Promise<SdkSessionToken>;
```

Exchange an API key for a short-lived session token via `POST /auth/sdk-token`. The hub
signs the token; this function never holds signing material. Throws the mapped error class
on a non-2xx response.

#### `MintSessionTokenOptions`

```ts
interface MintSessionTokenOptions {
  baseUrl: string;
  ttlSeconds?: number;
  scopes?: SdkScope[];
  fetch?: typeof fetch;
}
```

| Field        | Default                      | Notes                                    |
| ------------ | ---------------------------- | ---------------------------------------- |
| `baseUrl`    | required                     | Trailing slashes stripped                |
| `ttlSeconds` | hub default 600, ceiling 900 |                                          |
| `scopes`     | the key's own scopes         | Can **narrow** the token, never widen it |
| `fetch`      | `globalThis.fetch`           |                                          |

### `ApiKeyAuth`

```ts
class ApiKeyAuth implements AuthProvider {
  constructor(apiKey: string);
  getHeaderToken(): Promise<string>;
  getQueryToken(): Promise<string | null>; // always null
  invalidate(): void; // no-op — a durable key is not refreshable
}
```

The durable `bc_sk_` key, sent straight on every request. Throws in a browser:

> ApiKeyAuth cannot be used in a browser: an API key is a server-side secret. Exchange it
> for a session token on your backend and use SessionTokenAuth in the browser.

Also throws `An API key is required` for an empty key. `getQueryToken()` returns `null`
because a raw key must never appear in a URL — query strings reach access logs, proxy logs,
and `Referer` headers.

---

## `@better-claw/sdk/react`

Requires React `>= 18` (an optional peer dependency). See the [React guide](react.md).

```ts
function BetterClawProvider(props: BetterClawProviderProps): ReactElement;
function useBetterClaw(): BetterClawClient;
function useChat(chatId: string | null | undefined): UseChatResult;
function useChats(workspaceId: string): { chats: ChatSession[]; loading: boolean; error: Error | null };
function useAgents(workspaceId: string): { agents: Agent[]; loading: boolean; error: Error | null };
function useWorkspaces(): { workspaces: Workspace[]; loading: boolean };
```

### `BetterClawProviderProps`

```ts
interface BetterClawProviderProps {
  client: BetterClawClient;
  children: ReactNode;
}
```

Calls `client.connect()` in an effect keyed on `client`. It deliberately does **not**
disconnect on unmount: the provider usually lives for the app's lifetime, and tearing the
socket down on a StrictMode double-mount would drop an in-flight turn.

`useBetterClaw()` throws `useBetterClaw must be used inside <BetterClawProvider>` outside a
provider.

### `UseChatResult`

```ts
interface UseChatResult {
  messages: ChatMessage[];
  status: ConversationStatus;
  live: LiveTurn | undefined;
  thinking: string | undefined;
  todos: LiveTurn['todos'];
  loading: boolean;
  error: Error | null;
  send: (content: string, files?: File[]) => Promise<void>;
  stop: () => Promise<void>;
}
```

Reads through `useSyncExternalStore`, so the store is the single source of truth and the
socket is shared with every other mounted chat. On mount it hydrates and then **resumes**:
a turn already in flight — from a reload, or another tab — reattaches on its own.

- `loading` is `!!chatId && !hydrated`.
- `send` **swallows** errors into `error` rather than rethrowing.
- `status` is seeded synchronously from `conversation.status`, because status events only
  fire on a change.
- `live` is the first entry of the chat's `live` record.

`useWorkspaces` has no `error` field, unlike the other list hooks.

---

## `@better-claw/sdk/vue`

Requires Vue `>= 3.4` (an optional peer dependency). See the [Vue guide](vue.md).

```ts
function createBetterClaw(client: BetterClawClient): { install(app: App): void };
function useBetterClaw(): BetterClawClient;
function useChat(chatId: MaybeRefOrGetter<string | null | undefined>): UseChatResult;
function useChats(workspaceId: MaybeRefOrGetter<string>): {
  chats: Ref<ChatSession[]>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
};
function useAgents(workspaceId: MaybeRefOrGetter<string>): {
  agents: Ref<Agent[]>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
};
```

`createBetterClaw(client)` returns a plugin; `install` provides the client and calls
`client.connect()`. `useBetterClaw()` throws
`useBetterClaw requires app.use(createBetterClaw(client))` when the plugin is missing.

### `UseChatResult` (Vue)

```ts
interface UseChatResult {
  messages: ComputedRef<ChatMessage[]>;
  status: Ref<ConversationStatus>;
  live: ComputedRef<LiveTurn | undefined>;
  thinking: ComputedRef<string | undefined>;
  todos: ComputedRef<LiveTurn['todos']>;
  loading: ComputedRef<boolean>;
  error: Ref<Error | null>;
  send: (content: string, files?: File[]) => Promise<void>;
  stop: () => Promise<void>;
}
```

Same lifecycle as the React hook: hydrate, then resume. The `chatId` watcher runs with
`immediate: true`; everything is torn down in `onScopeDispose`.

**There is no `useWorkspaces` in the Vue adapter** — use `client.workspaces.list()`.

---

## Protocol types

Wire types and constants — `ChatMessage`, `ChatSession`, `ChatEvent`, `SdkSessionToken`,
`CLOSE_CODES`, and the rest — are documented in
[api-reference-protocol.md](api-reference-protocol.md).
