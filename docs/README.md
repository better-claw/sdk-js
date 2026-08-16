# `@better-claw/sdk` documentation

Chat state lives on the BetterClaw hub, not in your app. The SDK subscribes to the hub's
WebSocket, reduces the frames into a store, and hands you a message list. These pages
cover how to use that, and — where it matters — why it works the way it does.

New here? Start with [Getting started](getting-started.md), then read
[Authentication](authentication.md); the key-custody rule shapes everything else.

## Which entry point?

The package has four. They are separate on purpose: `ApiKeyAuth` lives behind `/server`
so it is structurally unreachable from a browser bundle rather than merely discouraged.

| Import from               | Runs in     | Contains                                                                              |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `@better-claw/sdk`        | Anywhere    | `BetterClawClient`, `Conversation`, `SessionTokenAuth`, `ChatStore`, errors, types    |
| `@better-claw/sdk/server` | Node only   | `createServerClient`, `mintSessionToken`, `ApiKeyAuth` — anything holding the raw key |
| `@better-claw/sdk/react`  | React >= 18 | `BetterClawProvider`, `useChat`, `useChats`, `useAgents`, `useWorkspaces`             |
| `@better-claw/sdk/vue`    | Vue >= 3.4  | `createBetterClaw`, `useChat`, `useChats`, `useAgents`                                |

## Guides

| Page                                          | What it covers                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)         | Install, first client, first message, in a browser and in Node                      |
| [Authentication](authentication.md)           | API keys vs session tokens, the token route, scopes, custom `AuthProvider`s         |
| [React](react.md)                             | Provider and hooks, plus the sharp edges the demo works around                      |
| [Vue](vue.md)                                 | Plugin and composables, ref shapes, `MaybeRefOrGetter` arguments                    |
| [Vanilla and Node](vanilla-and-node.md)       | `Conversation` events without a framework; headless clients and `ws`                |
| [Streaming and state](streaming-and-state.md) | Cumulative frames, hydration order, the status machine, resume, reconnect policy    |
| [Errors](errors.md)                           | Every error class, which ones reject and which ones don't, retry behaviour          |
| [Testing](testing.md)                         | Faking the socket and `fetch`, driving the store directly, the protocol drift guard |

## Reference

| Page                                        | What it covers                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| [API reference](api-reference.md)           | Every exported symbol from all four entry points, with signatures and defaults |
| [Protocol types](api-reference-protocol.md) | The wire types and constants: `ChatMessage`, `ChatEvent`, `CLOSE_CODES`, …     |

## Also worth reading

- [`../README.md`](../README.md) — the short version
- [`../demo/react`](../demo/react) and [`../demo/vue`](../demo/vue) — the same chat app
  built twice, including the server-side token route
- [`../src/`](../src/) — the source carries dense comments explaining the protocol traps
  each design avoids; the guides here quote them
