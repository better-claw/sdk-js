import type { AuthProvider } from './auth/index.js';
import { HttpTransport } from './http/transport.js';
import { AgentsResource, ChatsResource, WorkspacesResource, type CreateChatInput } from './resources/index.js';
import { ChatStore } from './store/chat-store.js';
import { ChatEventStream, type WebSocketFactory } from './ws/chat-event-stream.js';
import { Conversation, type ConversationOptions } from './conversation.js';
import type { ChatSession } from './protocol/index.js';

export interface BetterClawClientOptions {
  /** Hub origin, e.g. `https://api.betterclaw.com` or `http://localhost:3001`. */
  baseUrl: string;
  auth: AuthProvider;
  /**
   * Required. The socket is workspace-scoped, and a key-backed subscription
   * that names no workspace is refused by the hub — otherwise it would receive
   * events from the actor's other workspaces.
   */
  workspaceId: string;
  fetch?: typeof fetch;
  createWebSocket?: WebSocketFactory;
  conversation?: ConversationOptions;
}

/**
 * Entry point.
 *
 * Holds ONE socket for the whole client, not one per conversation. The socket
 * is workspace-scoped and already carries frames for every chat, so
 * `conversation()` is a cheap view over shared state — which is what makes
 * navigating between chats free and keeps a background turn from being dropped.
 */
export class BetterClawClient {
  readonly chats: ChatsResource;
  readonly agents: AgentsResource;
  readonly workspaces: WorkspacesResource;
  readonly store = new ChatStore();

  private readonly http: HttpTransport;
  private readonly stream: ChatEventStream;
  private readonly conversations = new Map<string, Conversation>();
  private connecting: Promise<void> | null = null;
  private authError: { code: number; reason: string } | null = null;

  constructor(private readonly opts: BetterClawClientOptions) {
    if (!opts.workspaceId) throw new Error('workspaceId is required');

    this.http = new HttpTransport({ baseUrl: opts.baseUrl, auth: opts.auth, fetch: opts.fetch });
    this.chats = new ChatsResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.workspaces = new WorkspacesResource(this.http);

    this.stream = new ChatEventStream({
      // Resolved per connect so a reconnect always carries a fresh token.
      url: async () => {
        const url = new URL(`${this.http.origin}/ws/chats`);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('workspaceId', opts.workspaceId);

        // A raw API key deliberately refuses to appear in a URL, so a
        // header-only credential yields null here. That is only workable if the
        // caller supplied a socket factory that authenticates some other way —
        // which is exactly what `createServerClient` does with an upgrade
        // header. Without one the socket would be rejected as unauthenticated,
        // so say so plainly instead.
        const token = await opts.auth.getQueryToken();
        if (token) {
          url.searchParams.set('token', token);
        } else if (!opts.createWebSocket) {
          throw new Error(
            'This credential cannot open a WebSocket on its own — an API key must not appear in a URL. ' +
              'Use createServerClient() from "@better-claw/sdk/server" in Node, or a session token in a browser.',
          );
        }
        return url.toString();
      },
      onEvent: (event) => this.store.apply(event),
      onAuthError: (code, reason) => {
        this.authError = { code, reason };
      },
      createWebSocket: opts.createWebSocket,
    });
  }

  /** Open the socket if it is not already open. Idempotent and concurrency-safe. */
  connect(): Promise<void> {
    this.connecting ??= this.stream.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  get connected(): boolean {
    return this.stream.connected;
  }

  /** Set once the socket closed with a terminal code — the credential is dead. */
  get lastAuthError(): { code: number; reason: string } | null {
    return this.authError;
  }

  /** A view over one chat. Repeated calls for the same id return the same object. */
  conversation(chatId: string): Conversation {
    let convo = this.conversations.get(chatId);
    if (!convo) {
      convo = new Conversation(chatId, this.chats, this.store, () => this.connect(), this.opts.conversation);
      this.conversations.set(chatId, convo);
    }
    return convo;
  }

  /** Create a chat and return a conversation already attached to it. */
  async startConversation(input: Omit<CreateChatInput, 'workspaceId'> & { workspaceId?: string }): Promise<{
    chat: ChatSession;
    conversation: Conversation;
  }> {
    const chat = await this.chats.create({ ...input, workspaceId: input.workspaceId ?? this.opts.workspaceId });
    await this.connect();
    return { chat, conversation: this.conversation(chat.id) };
  }

  disconnect(): void {
    this.stream.disconnect();
    for (const convo of this.conversations.values()) convo.dispose();
    this.conversations.clear();
  }
}
