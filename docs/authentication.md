# Authentication

## Two credentials, not interchangeable

| Shape     | What it is                                     | Where it may go                                                |
| --------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `bc_sk_…` | The durable API key. A **server-side secret**. | `Authorization` header, from a server. Never a URL.            |
| `bcs_…`   | A short-lived session token minted from a key. | A browser. The only credential allowed in the WS query string. |

The hub refuses a raw key outright if the request carries an `Origin` header — that is,
if it came from a browser. The SDK enforces the same rule in two more places, so it
cannot be missed by accident:

1. `ApiKeyAuth`'s constructor throws where `window` and `document` both exist.
2. `ApiKeyAuth` is only reachable through the `/server` entry point, so it does not appear
   in a browser bundle at all.

A raw key must never appear in a URL because query strings reach access logs, proxy logs,
and `Referer` headers. `ApiKeyAuth.getQueryToken()` therefore returns `null`, and the Node
WebSocket client sends the key as an upgrade header instead.

## Browser: session tokens

### 1. Mint on your server

`mintSessionToken` is the whole point of the `/server` entry: the key stays on your
backend, and only the result of the call reaches a browser.

```ts
import { mintSessionToken } from '@better-claw/sdk/server';

const session = await mintSessionToken(process.env.BC_API_KEY!, {
  baseUrl: process.env.BC_API_URL!,
  ttlSeconds: 600, // hub default 600, ceiling 900
  scopes: ['chats:read', 'chats:write'], // optional; can only narrow
});
```

It returns an [`SdkSessionToken`](api-reference-protocol.md#sdksessiontoken):

```ts
{
  token: 'bcs_…',
  expiresIn: 600,
  expiresAt: '2026-08-16T12:34:56.000Z',
  workspaceId: 'ws_…',
  userId: 'u_…',
  agentId: null,       // set when the key is pinned to one agent
  scopes: ['chats:read', 'chats:write'],
}
```

The hub signs the token; this function never holds signing material. Mount it as one route
in your own app — a Next.js route handler, an Express handler, a Nitro server route:

```ts
// app/api/bc-token/route.ts
import { mintSessionToken } from '@better-claw/sdk/server';

export async function POST() {
  return Response.json(await mintSessionToken(process.env.BC_API_KEY!, { baseUrl: process.env.BC_API_URL! }));
}
```

Two things this route should do that the one-liner above skips, both of which
[`demo/token-route.ts`](../demo/token-route.ts) demonstrates:

- **Authenticate the caller.** This route mints a credential for your BetterClaw
  workspace; whoever can call it can talk to your agents.
- **Re-surface the hub's status on failure**, so a revoked key reads as `401` in the
  browser rather than a generic `500`.

```ts
try {
  res.end(JSON.stringify(await mintSessionToken(apiKey, { baseUrl })));
} catch (err) {
  res.statusCode = (err as { status?: number }).status ?? 500;
  res.end(JSON.stringify({ message: (err as Error).message }));
}
```

### 2. Consume in the browser

```ts
import { BetterClawClient, SessionTokenAuth } from '@better-claw/sdk';

const client = new BetterClawClient({
  baseUrl,
  workspaceId,
  auth: new SessionTokenAuth(async () => (await fetch('/api/bc-token', { method: 'POST' })).json()),
});
```

`SessionTokenAuth` takes a `SessionTokenFetcher` — `() => Promise<SdkSessionToken> | SdkSessionToken`
— and handles the rest:

- **Caches** the token and reuses it until 60s before `expiresAt`, so a request never
  races the clock.
- **Collapses concurrent refreshes.** A page that fires six requests at mount mints one
  token, not six.
- **Does not cache a failure.** A rejected fetch leaves the cache empty, so the next call
  tries again.
- **Exposes the claims** via `auth.session` (`SdkSessionToken | null`) once a token has
  been fetched — useful for reading `workspaceId` or `scopes`.

Revoking the key kills its outstanding session tokens within one request: the hub re-reads
the key on every call rather than trusting the token's lifetime.

## Node: the key directly

```ts
import { WebSocket } from 'ws';
import { createServerClient } from '@better-claw/sdk/server';

const client = createServerClient({
  apiKey: process.env.BC_API_KEY!,
  baseUrl,
  workspaceId,
  webSocket: WebSocket,
});
```

The key rides the `Authorization` header on REST _and_ on the WebSocket upgrade. Node's
`ws` can set upgrade headers and browsers cannot, so the transport itself is what enforces
"the durable key stays server-side". See [Vanilla and Node](vanilla-and-node.md).

## Scopes

```ts
import { SDK_SCOPES } from '@better-claw/sdk';
// ['chats:read', 'chats:write', 'agents:read', 'workspaces:read']
```

A key carries a set of scopes; `mintSessionToken`'s `scopes` option can **narrow** a
token below the key's own scopes but never widen it. A call missing a scope throws
[`ForbiddenError`](errors.md), whose `.missingScopes` names what was lacking when the hub
said so:

```ts
try {
  await client.chats.create({ workspaceId, agentId, agentName });
} catch (err) {
  if (err instanceof ForbiddenError) console.error('needs:', err.missingScopes); // ['chats:write']
}
```

An API key is bound to one workspace and optionally pinned to one agent. Reads are
filtered to that scope, so `client.workspaces.list()` returns only the bound workspace.

## Custom credentials

`AuthProvider` is three methods. Implement it directly if you fetch and refresh tokens
some other way — there is no base class to extend.

```ts
import type { AuthProvider } from '@better-claw/sdk';

class MyAuth implements AuthProvider {
  /** Credential for the `Authorization: Bearer` header. */
  async getHeaderToken(): Promise<string> {
    return myToken();
  }

  /** Credential for `?token=` on the WS upgrade, or null when it must not appear in a URL. */
  async getQueryToken(): Promise<string | null> {
    return myToken();
  }

  /** Called after a 401 so a cached token can be discarded. */
  invalidate(): void {
    myCache.clear();
  }
}
```

Return `null` from `getQueryToken()` if your credential must not appear in a URL. When it
does, you must also supply `createWebSocket` so the socket can authenticate some other way
— otherwise the client throws with an explanation rather than opening a socket the hub
will reject as unauthenticated:

> This credential cannot open a WebSocket on its own — an API key must not appear in a
> URL. Use createServerClient() from "@better-claw/sdk/server" in Node, or a session token
> in a browser.

## Handling a dead credential

Two mechanisms, because HTTP and the socket fail differently.

**On HTTP**, a 401 triggers exactly one retry: the transport calls `auth.invalidate()`,
re-fetches the header token, and retries once. It does not loop — that would turn a
revoked key into a hot spin against the auth endpoint. If the retry also 401s, an
[`AuthError`](errors.md) is thrown.

**On the socket**, a terminal close code stops reconnection permanently and records the
reason:

```ts
if (client.lastAuthError) {
  const { code, reason } = client.lastAuthError; // e.g. { code: 4005, reason: 'key revoked' }
}
```

| Code   | Constant         | Terminal? |
| ------ | ---------------- | --------- |
| `4001` | `MISSING_TOKEN`  | yes       |
| `4002` | `USER_NOT_FOUND` | no        |
| `4003` | `AUTH_FAILED`    | **no**    |
| `4004` | `FORBIDDEN`      | yes       |
| `4005` | `KEY_REVOKED`    | yes       |

`AUTH_FAILED` is deliberately non-terminal: an expired session token is worth one more try
after a refresh. The others cannot succeed on a retry, so the stream stops and calls
`onAuthError` instead of hammering the endpoint.

## Verifying the key never ships

The custody rule is worth asserting mechanically rather than trusting. CI does exactly
this — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — and the same check
works against your own build output:

```bash
grep -c 'ApiKeyAuth\|server-side secret' dist/assets/*.js   # expect 0
```

If that ever returns non-zero, something imported from `@better-claw/sdk/server` into
browser code.

## See also

- [API reference: authentication](api-reference.md#authentication) — exact signatures
- [Errors](errors.md) — `AuthError`, `ForbiddenError`, and what rejects
- [Getting started](getting-started.md)
