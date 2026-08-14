import { createApp, h, ref } from 'vue';
import { BetterClawClient, SessionTokenAuth, type SdkSessionToken } from '@better-claw/sdk';
import { createBetterClaw } from '@better-claw/sdk/vue';
import Chat from './Chat.vue';
import '../../styles.css';

/**
 * The browser half. As in the React demo, the API key is absent: the page only
 * ever sees the short-lived token that `/api/bc-token` hands back.
 */
async function fetchToken(): Promise<SdkSessionToken> {
  const res = await fetch('/api/bc-token', { method: 'POST' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not get a session token');
  return res.json();
}

const error = ref<string | null>(null);

// One token fetch up front, only to learn which workspace the key is bound to.
fetchToken()
  .then((session) => {
    const client = new BetterClawClient({
      baseUrl: import.meta.env.VITE_BC_API_URL ?? '',
      auth: new SessionTokenAuth(fetchToken),
      workspaceId: session.workspaceId,
    });
    createApp(() => h(Chat, { session }))
      .use(createBetterClaw(client))
      .mount('#app');
  })
  .catch((err: Error) => {
    error.value = err.message;
    createApp(() => h('div', { class: 'app' }, h('div', { class: 'banner' }, error.value))).mount('#app');
  });
