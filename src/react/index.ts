import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { BetterClawClient } from '../client.js';
import type { ConversationStatus } from '../conversation.js';
import type { Agent, ChatMessage, ChatSession, Workspace } from '../protocol/index.js';
import type { LiveTurn } from '../store/chat-store.js';

const ClientContext = createContext<BetterClawClient | null>(null);

export interface BetterClawProviderProps {
  client: BetterClawClient;
  children: ReactNode;
}

export function BetterClawProvider({ client, children }: BetterClawProviderProps) {
  useEffect(() => {
    void client.connect();
    // Not disconnected on unmount: the provider usually lives for the app's
    // lifetime, and tearing the socket down on a StrictMode double-mount would
    // drop an in-flight turn.
  }, [client]);
  return createElement(ClientContext.Provider, { value: client }, children);
}

export function useBetterClaw(): BetterClawClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useBetterClaw must be used inside <BetterClawProvider>');
  return client;
}

export interface UseChatResult {
  messages: ChatMessage[];
  status: ConversationStatus;
  /** Transient per-turn state: thinking text, todos, subagents. */
  live: LiveTurn | undefined;
  thinking: string | undefined;
  todos: LiveTurn['todos'];
  /** True until the history has been fetched. */
  loading: boolean;
  error: Error | null;
  send: (content: string, files?: File[]) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Bind a chat to a component.
 *
 * Reads through `useSyncExternalStore`, so the store is the single source of
 * truth and the socket is shared with every other mounted chat.
 *
 * On mount it hydrates and then RESUMES: a turn already in flight (from a
 * reload, or another tab) reattaches on its own, because resumption is driven
 * off the persisted `status: 'streaming'` row rather than a live promise.
 */
export function useChat(chatId: string | null | undefined): UseChatResult {
  const client = useBetterClaw();
  const snapshot = useSyncExternalStore(client.store.subscribe, client.store.getSnapshot, client.store.getSnapshot);

  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  const conversation = useMemo(() => (chatId ? client.conversation(chatId) : null), [client, chatId]);
  const state = chatId ? snapshot.get(chatId) : undefined;

  useEffect(() => {
    if (!conversation) {
      setStatus('idle');
      return;
    }
    setError(null);
    // Seed from the conversation's CURRENT status rather than waiting for an
    // event. `emitStatus` only fires on a change and a fresh Conversation starts
    // at 'idle', so switching from a busy chat to an idle one would otherwise
    // leave this stuck on the previous chat's status — there is no event to
    // correct it.
    setStatus(conversation.status);
    const off = conversation.on('status', setStatus);
    let cancelled = false;

    void conversation
      .hydrate()
      .then(() => (cancelled ? null : conversation.resume()))
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      });

    return () => {
      cancelled = true;
      off();
    };
  }, [conversation]);

  const send = useCallback(
    async (content: string, files?: File[]) => {
      if (!conversation) return;
      setError(null);
      try {
        await conversation.send(content, files);
      } catch (err) {
        setError(err as Error);
        // Rethrow would leave every caller writing the same try/catch; the
        // error is surfaced through `error` instead.
      }
    },
    [conversation],
  );

  const stop = useCallback(async () => {
    await conversation?.stop();
  }, [conversation]);

  const live = chatId && state ? findLive(state.live) : undefined;

  return {
    messages: state?.messages ?? [],
    status,
    live,
    thinking: live?.thinking,
    todos: live?.todos,
    loading: !!chatId && !state?.hydrated,
    error,
    send,
    stop,
  };
}

/** Every chat in the workspace, kept live by the same socket. */
export function useChats(workspaceId: string): { chats: ChatSession[]; loading: boolean; error: Error | null } {
  const client = useBetterClaw();
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.chats
      .list(workspaceId)
      .then((list) => {
        if (!cancelled) setChats(list);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  return { chats, loading, error };
}

/**
 * Agents in a workspace. Surface `error` — a swallowed failure here renders as
 * an empty agent list with no explanation, which is indistinguishable from a
 * workspace that genuinely has none.
 */
export function useAgents(workspaceId: string): { agents: Agent[]; loading: boolean; error: Error | null } {
  const client = useBetterClaw();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.agents
      .list(workspaceId)
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  return { agents, loading, error };
}

export function useWorkspaces(): { workspaces: Workspace[]; loading: boolean } {
  const client = useBetterClaw();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    client.workspaces
      .list()
      .then((list) => {
        if (!cancelled) setWorkspaces(list);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { workspaces, loading };
}

function findLive(live: Record<string, LiveTurn>): LiveTurn | undefined {
  for (const key in live) return live[key];
  return undefined;
}
