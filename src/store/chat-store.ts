import type {
  ChatEvent,
  ChatMessage,
  ChatSession,
  ChatWithMessages,
  SubagentEvent,
  TodoChecklistItem,
} from '../protocol/index.js';

/** Transient per-turn state. None of it is persisted by the hub. */
export interface LiveTurn {
  messageId: string;
  content: string;
  thinking?: string;
  todos?: TodoChecklistItem[];
  subagents?: SubagentEvent[];
}

export interface ChatState {
  chat: ChatSession | null;
  messages: ChatMessage[];
  /** Keyed by messageId — usually 0 or 1 entries. */
  live: Record<string, LiveTurn>;
  /** True once the full history has been fetched. */
  hydrated: boolean;
}

export type StoreSnapshot = ReadonlyMap<string, ChatState>;

const emptyState = (): ChatState => ({ chat: null, messages: [], live: {}, hydrated: false });

/**
 * Reduces `/ws/chats` frames into per-chat state.
 *
 * This is the piece that makes the consumer thin: without it every app
 * re-implements the same reduction, including the two traps below.
 *
 * TRAP 1 — `content` and `thinking` are CUMULATIVE. Each frame carries the
 * whole text so far, so they are ASSIGNED, never appended. The gateway replays
 * the last frame on every reconnect, so an appending reducer silently doubles
 * the reply the first time a socket drops.
 *
 * TRAP 2 — a frame can arrive for a chat that has not been fetched yet. It is
 * buffered rather than dropped; see `hydrate`.
 */
export class ChatStore {
  private state = new Map<string, ChatState>();
  private listeners = new Set<() => void>();
  private snapshot: StoreSnapshot = new Map();
  /** Frames received for a chat whose history is still in flight. */
  private pending = new Map<string, ChatEvent[]>();

  constructor() {
    this.publish();
  }

  // ── subscription (shaped for useSyncExternalStore and Vue alike) ──

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreSnapshot => this.snapshot;

  get(chatId: string): ChatState {
    return this.snapshot.get(chatId) ?? emptyState();
  }

  private publish(): void {
    // A fresh Map identity each time, so identity comparison in React and Vue
    // detects the change without a deep compare.
    this.snapshot = new Map(this.state);
    for (const l of this.listeners) l();
  }

  private mutate(chatId: string, fn: (s: ChatState) => ChatState): void {
    const next = fn(this.state.get(chatId) ?? emptyState());
    this.state.set(chatId, next);
    this.publish();
  }

  // ── hydration ──

  /**
   * Start buffering frames for a chat before its history is fetched.
   *
   * Ordering matters and both naive orders are wrong: fetching first loses any
   * frame emitted during the request, and connecting first lets the older REST
   * snapshot overwrite newer streamed text. So: buffer → fetch → seed → drain.
   */
  beginHydration(chatId: string): void {
    if (!this.pending.has(chatId)) this.pending.set(chatId, []);
  }

  /** Seed from `GET /chats/:id`, then replay whatever arrived meanwhile. */
  applyFetchedChat(chat: ChatWithMessages): void {
    const { messages, ...session } = chat;
    this.mutate(chat.id, (s) => ({ ...s, chat: session as ChatSession, messages: [...messages], hydrated: true }));

    const buffered = this.pending.get(chat.id) ?? [];
    this.pending.delete(chat.id);
    for (const event of buffered) this.apply(event);
  }

  // ── reduction ──

  apply(event: ChatEvent): void {
    switch (event.type) {
      case 'connected':
        return;

      case 'chat_upserted':
        this.mutate(event.chat.id, (s) => ({ ...s, chat: event.chat }));
        return;

      case 'chat_deleted':
        this.state.delete(event.chatId);
        this.pending.delete(event.chatId);
        this.publish();
        return;

      case 'message_upserted': {
        if (this.buffer(event.chatId, event)) return;
        this.mutate(event.chatId, (s) => {
          const messages = upsertMessage(s.messages, event.message);
          // The persisted row is the truth once a turn ends; drop the live
          // snapshot so transient text cannot outlive it.
          const live = { ...s.live };
          if (event.message.status !== 'streaming') delete live[event.message.id];
          return { ...s, messages, live };
        });
        return;
      }

      case 'message_streaming': {
        if (this.buffer(event.chatId, event)) return;
        this.mutate(event.chatId, (s) => {
          const live = { ...s.live };
          if (event.status === 'streaming') {
            live[event.messageId] = {
              messageId: event.messageId,
              // ASSIGN — see TRAP 1.
              content: event.content,
              thinking: event.thinking,
              todos: event.todos,
              subagents: event.subagents,
            };
          } else {
            delete live[event.messageId];
          }

          // Mirror onto the message row so a renderer can read one list. The
          // authoritative row follows in `message_upserted`.
          const messages = s.messages.map((m) =>
            m.id === event.messageId ? { ...m, content: event.content, status: event.status } : m,
          );
          return { ...s, messages, live };
        });
        return;
      }
    }
  }

  /**
   * Hold a frame for a chat whose fetch is still in flight. Returns true when
   * the frame was buffered instead of applied.
   */
  private buffer(chatId: string, event: ChatEvent): boolean {
    const queue = this.pending.get(chatId);
    if (!queue) return false;
    queue.push(event);
    return true;
  }

  // ── reads ──

  /** The live snapshot for a turn, if one is streaming. */
  liveTurn(chatId: string, messageId: string): LiveTurn | undefined {
    return this.get(chatId).live[messageId];
  }

  /**
   * The in-flight assistant turn, from PERSISTED state. This is what makes
   * resumption work after a reload, where no promise survived.
   */
  streamingMessage(chatId: string): ChatMessage | undefined {
    return this.get(chatId).messages.find((m) => m.role === 'assistant' && m.status === 'streaming');
  }

  reset(): void {
    this.state.clear();
    this.pending.clear();
    this.publish();
  }
}

/** Replace by id, preserving order; append when new. */
function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === message.id);
  if (i === -1) return [...messages, message];
  const next = [...messages];
  next[i] = message;
  return next;
}
