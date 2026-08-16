# Errors

## The two kinds of failure

They are easy to conflate and behave completely differently.

**A turn that could not be dispatched** throws. The POST failed — no credits, missing
scope, no such chat, network down. Nothing is pending.

```ts
try {
  await conversation.send('hello');
} catch (err) {
  if (err instanceof PaymentRequiredError) showBilling(err.message);
}
```

**A turn the agent failed to complete** does _not_ throw. `send()` **resolves** with a
message whose `status` is `'error'`:

```ts
const reply = await conversation.send('hello');
if (reply.status === 'error') console.error(reply.errorMessage);
```

The turn ran, produced whatever it produced — partial content is preserved — and ended
badly. It is a message in the history, not an exception, and it renders as one.

The single exception is `TurnTimeoutError`, which rejects because there is no terminal
message to resolve with. So a complete handler looks like:

```ts
let reply;
try {
  reply = await conversation.send(text);
} catch (err) {
  if (err instanceof TurnTimeoutError) return showTimeout();
  return showError(err as Error); // dispatch failure
}
if (reply.status === 'error') showAgentFailure(reply.errorMessage);
```

In React and Vue the hooks' `send` never rejects at all — the dispatch failure lands in
`error` instead. The `status: 'error'` message still arrives in `messages`.

## Error classes

All extend `BetterClawError`, which carries `status`, `code`, and the parsed response
`body`. `err.name` is the subclass name.

| Class                   | `status` | `code`              | Thrown when                                                     |
| ----------------------- | -------- | ------------------- | --------------------------------------------------------------- |
| `AuthError`             | 401      | `unauthorized`      | Credential missing, expired, or revoked                         |
| `PaymentRequiredError`  | 402      | `payment_required`  | Out of credits, or the agent is locked on the Free plan         |
| `ForbiddenError`        | 403      | `forbidden`         | Key lacks a scope, or is bound to another workspace             |
| `NotFoundError`         | 404      | `not_found`         | No such chat, or outside this key's workspace                   |
| `RateLimitError`        | 429      | `rate_limited`      | Throttled                                                       |
| `AgentUnreachableError` | 503      | `agent_unreachable` | HTTP **502, 503, or 504** — the agent failed to wake or dropped |
| `TurnTimeoutError`      | 408      | `turn_timeout`      | Client-side: the turn exceeded `turnTimeoutMs`                  |
| `BetterClawError`       | actual   | `http_error`        | Any other non-2xx status                                        |

Note that `AgentUnreachableError.status` is always `503` even when the response was 502 or
504; switch on `err.code` or `instanceof`, not on `err.status`, if you need to distinguish.

Import from the root entry:

```ts
import {
  BetterClawError,
  AuthError,
  ForbiddenError,
  PaymentRequiredError,
  NotFoundError,
  RateLimitError,
  AgentUnreachableError,
  TurnTimeoutError,
} from '@better-claw/sdk';
```

### `ForbiddenError.missingScopes`

```ts
readonly missingScopes: string[];
```

Parsed out of the hub's message when it names them (`…missing scope(s): chats:write`), and
`[]` otherwise.

```ts
catch (err) {
  if (err instanceof ForbiddenError && err.missingScopes.includes('chats:write')) {
    // the token was minted too narrowly
  }
}
```

### `RateLimitError.retryAfter`

```ts
readonly retryAfter: number | null;
```

Seconds to wait, read from the `Retry-After` header. **In a browser this requires the
header to be CORS-exposed**, so it is often `null` there even when the hub sent one — plan
a fallback:

```ts
const wait = (err.retryAfter ?? 30) * 1000;
```

### `PaymentRequiredError`

Fires _before_ the turn is created, so nothing is pending when you see it. The fix is
billing, not a retry. Worth styling differently from other failures, as both demos do:

```tsx
<div className={`banner ${error instanceof PaymentRequiredError ? 'billing' : ''}`}>
  {error instanceof PaymentRequiredError ? `Billing: ${error.message}` : error.message}
</div>
```

### `TurnTimeoutError`

Client-side only — nothing failed on the hub, the SDK simply stopped waiting. Message:
`Turn <messageId> did not finish within <ms>ms`.

The default deadline is 11 minutes, covering the hub's worst-case wake (6 minutes, plus 5
more if the wake lands mid-shutdown). Raise it for agents that legitimately run long:

```ts
new BetterClawClient({ ..., conversation: { turnTimeoutMs: 30 * 60_000 } });
```

The turn itself is unaffected — it keeps running on the hub, and the store keeps receiving
its frames. Only your promise gave up. `resume()` can reattach to it.

## Error messages

The hub is NestJS, which returns `{ message: string | string[] }`. Both shapes occur; the
SDK normalizes them, joining an array with `', '`, so `err.message` is always a string.
When the body is not JSON, the raw text is used. When there is no usable message at all,
you get `Request failed with status <n>`.

The parsed body is always available on `err.body` if the hub returned structured detail.

## Automatic retry

The transport retries **exactly once** after a 401: it calls `auth.invalidate()`,
re-fetches the header token, and reissues the request. This exists because a session token
can expire between being read from cache and reaching the hub.

It deliberately does not loop — that would turn a revoked key into a hot spin against the
auth endpoint. A second 401 throws `AuthError`.

Nothing else is retried. 429 and 5xx are surfaced to you.

## Socket-level failures

Socket problems are not exceptions; nothing is throwing at a call site. The stream
reconnects with backoff, and a terminal close code records itself:

```ts
if (client.lastAuthError) {
  const { code, reason } = client.lastAuthError;
}
```

See [Streaming and state](streaming-and-state.md#reconnection) for the close-code table and
the backoff policy.

## Constructing errors yourself

The constructors are public, which is occasionally useful in tests or in a mock backend:

```ts
new BetterClawError(message, status, code, body?)
new AuthError(message, body?)
new PaymentRequiredError(message, body?)
new ForbiddenError(message, body?)
new NotFoundError(message, body?)
new RateLimitError(message, retryAfter, body?)
new AgentUnreachableError(message, body?)
new TurnTimeoutError(message)
```

The status→class mapping helper (`errorForStatus`) is internal and not exported.

## See also

- [Authentication](authentication.md) — credentials, scopes, close codes
- [API reference: errors](api-reference.md#errors)
