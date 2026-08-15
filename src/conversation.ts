import type { ChatMessage } from './protocol/index.js';
import type { ChatStore, LiveTurn } from './store/chat-store.js';
import type { ChatsResource } from './resources/index.js';
import { TurnTimeoutError } from './http/errors.js';

export type ConversationStatus = 'idle' | 'sending' | 'waking' | 'streaming' | 'complete' | 'error';

export interface ConversationEvents {
  status: (status: ConversationStatus) => void;
  delta: (turn: LiveTurn) => void;
  message: (message: ChatMessage) => void;
}

export interface ConversationOptions {
  /**
   * Silence after which the agent is assumed to be cold-starting. The HTTP call
   * returns instantly, so a waking agent looks exactly like a stalled one until
   * the first frame lands.
   */
  wakingAfterMs?: number;
  /**
   * How long a turn may take in total. Defaults to 11 minutes: the hub's wake
   * budget is 6 minutes, plus 5 more if the wake lands mid-shutdown. This is
   * deliberately NOT an HTTP timeout — the request already returned.
   */
  turnTimeoutMs?: number;
}

const DEFAULT_WAKING_AFTER_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 11 * 60_000;

/**
 * A view over one chat. Cheap to construct — it holds no socket of its own, and
 * reads from the single client-wide store.
 */
export class Conversation {
  private listeners: { [K in keyof ConversationEvents]: Set<ConversationEvents[K]> } = {
    status: new Set(),
    delta: new Set(),
    message: new Set(),
  };
  private currentStatus: ConversationStatus = 'idle';
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly chatId: string,
    private readonly chats: ChatsResource,
    private readonly store: ChatStore,
    private readonly ensureConnected: () => Promise<void>,
    private readonly opts: ConversationOptions = {},
  ) {}

  get status(): ConversationStatus {
    return this.currentStatus;
  }

  get messages(): ChatMessage[] {
    return this.store.get(this.chatId).messages;
  }

  /** Transient state for the in-flight turn: thinking text, todos, subagents. */
  get live(): LiveTurn | undefined {
    const streaming = this.store.streamingMessage(this.chatId);
    return streaming ? this.store.liveTurn(this.chatId, streaming.id) : undefined;
  }

  on<K extends keyof ConversationEvents>(event: K, fn: ConversationEvents[K]): () => void {
    this.listeners[event].add(fn);
    this.attach();
    return () => {
      this.listeners[event].delete(fn);
    };
  }

  private emitStatus(status: ConversationStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const l of this.listeners.status) l(status);
  }

  /** Bridge store updates to `delta`/`message` listeners. */
  private attach(): void {
    if (this.unsubscribe) return;
    let lastLive: LiveTurn | undefined;
    let lastCount = -1;
    this.unsubscribe = this.store.subscribe(() => {
      const state = this.store.get(this.chatId);
      const live = this.live;
      if (live && live !== lastLive) {
        lastLive = live;
        for (const l of this.listeners.delta) l(live);
      }
      if (state.messages.length !== lastCount) {
        lastCount = state.messages.length;
        const latest = state.messages[state.messages.length - 1];
        if (latest) for (const l of this.listeners.message) l(latest);
      }
    });
  }

  /** Load history and start receiving. Safe to call repeatedly. */
  async hydrate(): Promise<void> {
    this.store.beginHydration(this.chatId);
    // Connect FIRST so frames emitted during the fetch are buffered rather than
    // lost; the buffer is drained on top of the fetched snapshot.
    await this.ensureConnected();
    const chat = await this.chats.get(this.chatId);
    this.store.applyFetchedChat(chat);
    this.attach();
  }

  /**
   * Send a message and resolve with the finished reply.
   *
   * The POST returns a placeholder in milliseconds; the answer only ever
   * arrives on the socket. So the id is taken from the placeholder and the
   * promise settles when a frame for THAT id reaches a terminal state.
   */
  async send(content: string, files?: File[]): Promise<ChatMessage> {
    await this.ensureConnected();
    this.emitStatus('sending');

    const { assistantMessage } = await this.chats.sendMessage(this.chatId, content, files);
    return this.awaitTurn(assistantMessage.id);
  }

  /**
   * Re-attach to a turn already in flight — after a reload, where the promise
   * from `send()` no longer exists. Driven off persisted state, not memory.
   *
   * Resolves immediately when the turn finished while the page was away: there
   * is no live snapshot left to replay, and the fetched row is already final.
   */
  async resume(): Promise<ChatMessage | null> {
    if (!this.store.get(this.chatId).hydrated) await this.hydrate();
    const streaming = this.store.streamingMessage(this.chatId);
    if (!streaming) {
      this.emitStatus('idle');
      return null;
    }
    return this.awaitTurn(streaming.id);
  }

  /** Cancel the in-flight turn. The hub finalizes it, so a terminal frame still arrives. */
  async stop(): Promise<void> {
    const streaming = this.store.streamingMessage(this.chatId);
    if (!streaming) return;
    await this.chats.stopMessage(this.chatId, streaming.id);
  }

  /** Settle when `messageId` reaches a terminal state, tracking status along the way. */
  private awaitTurn(messageId: string): Promise<ChatMessage> {
    const wakingAfter = this.opts.wakingAfterMs ?? DEFAULT_WAKING_AFTER_MS;
    const timeout = this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    return new Promise<ChatMessage>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(wakingTimer);
        clearTimeout(timeoutTimer);
        unsubscribe();
        fn();
      };

      // Silence here means a cold agent starting a Fly machine, not a hang.
      const wakingTimer = setTimeout(() => {
        if (this.currentStatus === 'sending') this.emitStatus('waking');
      }, wakingAfter);

      const timeoutTimer = setTimeout(() => {
        finish(() => {
          this.emitStatus('error');
          reject(new TurnTimeoutError(`Turn ${messageId} did not finish within ${timeout}ms`));
        });
      }, timeout);

      const check = () => {
        const state = this.store.get(this.chatId);
        const message = state.messages.find((m) => m.id === messageId);
        if (!message) return;
        if (message.status === 'streaming') {
          // The hub creates the assistant row as `streaming` the instant the
          // POST lands, long before the agent has said anything — on a cold
          // start, minutes before. So the row alone is NOT progress: only real
          // content or live transient state means the agent is producing.
          const live = state.live[messageId];
          if (message.content || live?.content || live?.thinking || live?.todos?.length) {
            clearTimeout(wakingTimer);
            this.emitStatus('streaming');
          } else {
            // In flight but silent. `send()` has already said `sending`; this is
            // what makes `resume()` report it too, so a chat reattached after a
            // reload doesn't sit on `idle` while the agent is mid-turn.
            this.emitStatus('sending');
          }
          return;
        }
        finish(() => {
          this.emitStatus(message.status === 'error' ? 'error' : 'complete');
          resolve(message);
        });
      };

      const unsubscribe = this.store.subscribe(check);
      // The turn may already be finished — a reload after completion, or a
      // frame that landed between the POST returning and this subscription.
      check();
    });
  }

  /** Drop listeners. The socket is client-wide and is not affected. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const set of Object.values(this.listeners)) set.clear();
  }
}
