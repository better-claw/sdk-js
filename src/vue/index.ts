import {
  computed,
  inject,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
  type App,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';
import type { BetterClawClient } from '../client.js';
import type { ConversationStatus } from '../conversation.js';
import type { Agent, ChatMessage, ChatSession } from '../protocol/index.js';
import type { LiveTurn, StoreSnapshot } from '../store/chat-store.js';

const CLIENT_KEY: InjectionKey<BetterClawClient> = Symbol('betterclaw');

/**
 * Vue plugin:
 *
 *   app.use(createBetterClaw(client))
 *
 * Binds to the same ChatStore the React adapter uses — both are thin readers
 * over one shared reduction, which is what keeps them from diverging.
 */
export function createBetterClaw(client: BetterClawClient) {
  return {
    install(app: App) {
      app.provide(CLIENT_KEY, client);
      void client.connect();
    },
  };
}

export function useBetterClaw(): BetterClawClient {
  const client = inject(CLIENT_KEY, null);
  if (!client) throw new Error('useBetterClaw requires app.use(createBetterClaw(client))');
  return client;
}

/** Track the store as a ref. The store publishes a new Map identity per change. */
function useStoreSnapshot(client: BetterClawClient): Ref<StoreSnapshot> {
  const snapshot = shallowRef<StoreSnapshot>(client.store.getSnapshot());
  const unsubscribe = client.store.subscribe(() => {
    snapshot.value = client.store.getSnapshot();
  });
  onScopeDispose(unsubscribe);
  return snapshot;
}

export interface UseChatResult {
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

/**
 * Mirror of the React `useChat`, returning refs. Same lifecycle: hydrate, then
 * resume any turn already in flight — which is what makes a mid-turn reload or
 * a second tab pick the stream back up.
 */
export function useChat(chatId: MaybeRefOrGetter<string | null | undefined>): UseChatResult {
  const client = useBetterClaw();
  const snapshot = useStoreSnapshot(client);

  const status = ref<ConversationStatus>('idle');
  const error = ref<Error | null>(null);

  let detachStatus: (() => void) | null = null;

  const stopWatch = watch(
    () => toValue(chatId),
    (id) => {
      detachStatus?.();
      detachStatus = null;
      error.value = null;
      if (!id) {
        status.value = 'idle';
        return;
      }

      const conversation = client.conversation(id);
      // Seed from the conversation's CURRENT status rather than waiting for an
      // event. `emitStatus` only fires on a change and a fresh Conversation
      // starts at 'idle', so switching from a busy chat to an idle one would
      // otherwise leave this stuck on the previous chat's status.
      status.value = conversation.status;
      detachStatus = conversation.on('status', (s) => {
        status.value = s;
      });
      void conversation
        .hydrate()
        .then(() => conversation.resume())
        .catch((err: Error) => {
          error.value = err;
        });
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    detachStatus?.();
    stopWatch();
  });

  const state = computed(() => {
    const id = toValue(chatId);
    return id ? snapshot.value.get(id) : undefined;
  });
  const live = computed(() => {
    const l = state.value?.live;
    if (!l) return undefined;
    for (const key in l) return l[key];
    return undefined;
  });

  return {
    messages: computed(() => state.value?.messages ?? []),
    status,
    live,
    thinking: computed(() => live.value?.thinking),
    todos: computed(() => live.value?.todos),
    loading: computed(() => !!toValue(chatId) && !state.value?.hydrated),
    error,
    async send(content, files) {
      const id = toValue(chatId);
      if (!id) return;
      error.value = null;
      try {
        await client.conversation(id).send(content, files);
      } catch (err) {
        error.value = err as Error;
      }
    },
    async stop() {
      const id = toValue(chatId);
      if (id) await client.conversation(id).stop();
    },
  };
}

export function useChats(workspaceId: MaybeRefOrGetter<string>) {
  const client = useBetterClaw();
  const chats = ref<ChatSession[]>([]);
  const loading = ref(true);
  const error = ref<Error | null>(null);

  const stop = watch(
    () => toValue(workspaceId),
    async (ws) => {
      loading.value = true;
      try {
        chats.value = await client.chats.list(ws);
      } catch (err) {
        error.value = err as Error;
      } finally {
        loading.value = false;
      }
    },
    { immediate: true },
  );
  onScopeDispose(stop);

  return { chats, loading, error };
}

export function useAgents(workspaceId: MaybeRefOrGetter<string>) {
  const client = useBetterClaw();
  const agents = ref<Agent[]>([]);
  const loading = ref(true);
  const error = ref<Error | null>(null);

  const stop = watch(
    () => toValue(workspaceId),
    async (ws) => {
      loading.value = true;
      try {
        agents.value = await client.agents.list(ws);
      } catch (err) {
        error.value = err as Error;
      } finally {
        loading.value = false;
      }
    },
    { immediate: true },
  );
  onScopeDispose(stop);

  return { agents, loading, error };
}
