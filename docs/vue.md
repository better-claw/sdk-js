# Vue

```bash
npm install @better-claw/sdk vue
```

Vue `>= 3.4` is an optional peer dependency (the composables use `toValue` and
`MaybeRefOrGetter`).

The Vue adapter is a deliberate mirror of the [React](react.md) one — both are thin
readers over the same `ChatStore`, which is what keeps them from diverging. The
differences are noted below.

## Setup

```ts
import { createApp } from 'vue';
import { BetterClawClient, SessionTokenAuth } from '@better-claw/sdk';
import { createBetterClaw } from '@better-claw/sdk/vue';
import App from './App.vue';

const client = new BetterClawClient({
  baseUrl: import.meta.env.VITE_BC_API_URL,
  workspaceId,
  auth: new SessionTokenAuth(async () => (await fetch('/api/bc-token', { method: 'POST' })).json()),
});

createApp(App).use(createBetterClaw(client)).mount('#app');
```

`createBetterClaw(client)` returns a plugin whose `install` provides the client under an
internal injection key and calls `client.connect()`.

## `useChat`

```ts
function useChat(chatId: MaybeRefOrGetter<string | null | undefined>): UseChatResult;
```

Everything is returned as a ref. `status` and `error` are writable `Ref`s; the rest are
`ComputedRef`s.

| Field      | Type                                                 |
| ---------- | ---------------------------------------------------- |
| `messages` | `ComputedRef<ChatMessage[]>`                         |
| `status`   | `Ref<ConversationStatus>`                            |
| `live`     | `ComputedRef<LiveTurn \| undefined>`                 |
| `thinking` | `ComputedRef<string \| undefined>`                   |
| `todos`    | `ComputedRef<TodoChecklistItem[] \| undefined>`      |
| `loading`  | `ComputedRef<boolean>`                               |
| `error`    | `Ref<Error \| null>`                                 |
| `send`     | `(content: string, files?: File[]) => Promise<void>` |
| `stop`     | `() => Promise<void>`                                |

Same lifecycle as React: hydrate, then resume any turn already in flight — which is what
makes a mid-turn reload or a second tab pick the stream back up. The watcher runs
`immediate: true` and re-runs whenever the id changes; everything is torn down in
`onScopeDispose`.

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useChat } from '@better-claw/sdk/vue';

const chatId = ref<string | null>(null);
const { messages, status, thinking, todos, error, send, stop } = useChat(chatId);

const draft = ref('');
const busy = computed(() => ['sending', 'waking', 'streaming'].includes(status.value));
</script>

<template>
  <div v-if="error" class="banner">{{ error.message }}</div>

  <div v-for="m in messages" :key="m.id" class="msg" :class="[m.role, { error: m.status === 'error' }]">
    {{ m.content || (m.status === 'streaming' ? '…' : '') }}
  </div>

  <div v-if="thinking" class="thinking">{{ thinking }}</div>

  <ul v-if="todos?.length" class="todos">
    <li v-for="(t, i) in todos" :key="i">
      {{ t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○' }} {{ t.title }}
    </li>
  </ul>

  <p v-if="status === 'waking'">Waking the agent — a cold start can take a few minutes.</p>

  <button v-if="busy" @click="stop">Stop</button>
  <button v-else @click="send(draft)">Send</button>
</template>
```

Note `todos?.length` in the template rather than `todos.value?.length` — refs unwrap in
templates, but you need `.value` in `<script setup>`.

### Argument forms

`chatId` accepts a plain string, a `Ref`, or a getter — anything `MaybeRefOrGetter` covers.
Use a getter when the value comes from props, so the composable tracks it reactively:

```ts
const { agents } = useAgents(() => props.session.workspaceId);
```

### `send` never rejects

It catches and surfaces through `error.value`. As in React, distinguish two failures: a
turn that could not be _dispatched_ lands in `error`, while a turn the agent failed to
complete appears in `messages` with `status: 'error'` and an `errorMessage`.

### Sending the very first message

`useChat`'s `send` reads the current `chatId` at call time, but the watcher that binds the
new id has not run yet in the same tick. Start the conversation and send on it directly:

```ts
async function submit() {
  if (!chatId.value) {
    const { chat, conversation } = await client.startConversation({
      agentId: agent.value.id,
      agentName: agent.value.name,
    });
    chatId.value = chat.id;
    // Send on the conversation just created rather than the composable's `send`:
    // the watcher that rebinds it to the new id has not run yet.
    await conversation.send(text);
    return;
  }
  await send(text);
}
```

From [`demo/vue/src/Chat.vue`](../demo/vue/src/Chat.vue).

## `useChats`

```ts
function useChats(workspaceId: MaybeRefOrGetter<string>): {
  chats: Ref<ChatSession[]>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
};
```

Refetches whenever `workspaceId` changes. A one-shot fetch per id, not a live list — see
the same note under [React](react.md#usechats).

## `useAgents`

```ts
function useAgents(workspaceId: MaybeRefOrGetter<string>): {
  agents: Ref<Agent[]>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
};
```

Render `error`: an empty agent list with no explanation looks like a workspace that has
none.

## `useBetterClaw`

```ts
function useBetterClaw(): BetterClawClient;
```

Throws `useBetterClaw requires app.use(createBetterClaw(client))` when the plugin is not
installed.

## No `useWorkspaces`

React has `useWorkspaces`; Vue does not. Call the resource directly:

```ts
const workspaces = ref<Workspace[]>([]);
onMounted(async () => {
  workspaces.value = await useBetterClaw().workspaces.list();
});
```

For an API key this returns only the workspace the key is bound to, so most apps read
`workspaceId` off the session token instead and never need this.

## See also

- [Streaming and state](streaming-and-state.md) — what `status` and `live` actually mean
- [Errors](errors.md)
- [API reference: Vue](api-reference.md#better-clawsdkvue)
- [`demo/vue`](../demo/vue) — a complete working app
