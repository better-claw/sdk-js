<script setup lang="ts">
/**
 * The Vue twin of demo/react/src/Chat.tsx — same behaviour, same markup, so the
 * two adapters can be read side by side. Everything hard (reconnects,
 * cumulative deltas, replay, resuming a running turn) is in the SDK.
 */
import { computed, ref, watch } from 'vue';
import { NotFoundError, PaymentRequiredError, type SdkSessionToken } from '@better-claw/sdk';
import { useAgents, useBetterClaw, useChat } from '@better-claw/sdk/vue';
import { FILE_DEMO_PROMPT } from '../../files';
import Deliverables from './Deliverables.vue';

const props = defineProps<{ session: SdkSessionToken }>();

const client = useBetterClaw();
const { agents } = useAgents(() => props.session.workspaceId);

const chatId = ref<string | null>(localStorage.getItem('bc-demo-chat'));
const { messages, status, thinking, todos, loading, error: chatError, send, stop } = useChat(chatId);
const draft = ref('');
const submitting = ref(false);
const sendError = ref<Error | null>(null);
const notice = ref<string | null>(null);
const error = computed(() => sendError.value ?? chatError.value);
// Which agent a new chat goes to. A workspace usually has several, and they are
// not interchangeable — an offline one simply never answers.
const agentId = ref('');
const agent = computed(() => agents.value.find((a) => a.id === agentId.value) ?? agents.value[0]);

// Remembering the id is what makes the reload test work: on refresh the SDK
// rehydrates this chat and reattaches to any turn still running.
watch(chatId, (id) => {
  if (id) localStorage.setItem('bc-demo-chat', id);
  else localStorage.removeItem('bc-demo-chat');
});

watch(error, (err) => {
  if (chatId.value && err instanceof NotFoundError) {
    chatId.value = null;
    sendError.value = null;
    notice.value = 'The saved chat is no longer available. Your next message will start a new chat.';
  }
});

const busy = computed(() => submitting.value || ['sending', 'waking', 'streaming'].includes(status.value));

function submit() {
  const text = draft.value.trim();
  if (!text || busy.value || loading.value || !agent.value) return;
  draft.value = '';
  void sendText(text);
}

async function sendText(text: string) {
  if (busy.value || loading.value || !agent.value) return;
  submitting.value = true;
  sendError.value = null;
  notice.value = null;
  try {
    if (!chatId.value) {
      const { chat, conversation } = await client.startConversation({
        agentId: agent.value.id,
        agentName: agent.value.name,
      });
      chatId.value = chat.id;
      // The composable's watcher has not rebound send to the new id yet.
      await conversation.send(text);
    } else {
      await send(text);
    }
  } catch (err) {
    sendError.value = err instanceof Error ? err : new Error('Could not send the message.');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="app">
    <header>
      <h1>BetterClaw — Vue demo</h1>
      <p>
        workspace {{ session.workspaceId.slice(0, 8) }} · {{ agents.length }} agent(s) · socket
        {{ client.connected ? 'live' : 'offline' }}
      </p>
    </header>

    <section class="file-demo" aria-labelledby="file-demo-title">
      <h2 id="file-demo-title">Generate a file</h2>
      <p>Create a sample project plan with the agent, then download the CSV from its reply.</p>
      <button type="button" :disabled="busy || loading || !agent" @click="sendText(FILE_DEMO_PROMPT)">
        Generate a CSV
      </button>
    </section>

    <p v-if="notice" class="status" role="status">{{ notice }}</p>

    <div v-if="error" class="banner" :class="{ billing: error instanceof PaymentRequiredError }">
      {{ error instanceof PaymentRequiredError ? `Billing: ${error.message}` : error.message }}
    </div>

    <div v-for="m in messages" :key="m.id" class="msg" :class="[m.role, { error: m.status === 'error' }]">
      {{ m.content || (m.status === 'streaming' ? '…' : '') }}
      <template v-if="m.status === 'error' && m.errorMessage">{{ '\n' + m.errorMessage }}</template>
      <Deliverables :message="m" />
    </div>

    <div v-if="thinking" class="thinking">{{ thinking }}</div>

    <ul v-if="todos?.length" class="todos">
      <li v-for="(t, i) in todos" :key="i">
        {{ t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○' }} {{ t.title }}
      </li>
    </ul>

    <!-- A cold agent can take minutes to start, so this must not look like an
         ordinary pause. -->
    <p v-if="status === 'waking'" class="status waking">Waking the agent — a cold start can take a few minutes.</p>
    <p v-else-if="status === 'sending'" class="status">Sending…</p>

    <form @submit.prevent="submit">
      <!-- Locked once the chat exists — a chat belongs to one agent. -->
      <select
        :value="agent?.id ?? ''"
        :disabled="busy || !!chatId || !agents.length"
        aria-label="Agent"
        @change="agentId = ($event.target as HTMLSelectElement).value"
      >
        <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.displayName ?? a.name }}</option>
      </select>
      <input
        v-model="draft"
        type="text"
        :placeholder="agents.length ? 'Ask the agent…' : 'No agents in this workspace'"
        :disabled="loading || !agents.length"
      />
      <button v-if="busy" type="button" class="stop" @click="stop">Stop</button>
      <button v-else type="submit" :disabled="loading || !draft.trim()">Send</button>
    </form>
  </div>
</template>
