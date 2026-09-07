import type { HttpTransport } from '../http/transport.js';
import type { Agent, ChatMessage, ChatSession, ChatWithMessages, Workspace } from '../protocol/index.js';

export interface CreateChatInput {
  workspaceId: string;
  agentId: string;
  agentName: string;
  title?: string;
}

export interface SendMessageResult {
  userMessage: ChatMessage;
  /**
   * A PLACEHOLDER, not the answer. The hub dispatches the turn in the
   * background and the reply arrives over `/ws/chats`; this row exists so the
   * caller has an id to correlate against.
   */
  assistantMessage: ChatMessage;
}

export class ChatsResource {
  constructor(private readonly http: HttpTransport) {}

  create(input: CreateChatInput): Promise<ChatSession> {
    return this.http.request<ChatSession>('/chats', { method: 'POST', body: input });
  }

  list(workspaceId: string): Promise<ChatSession[]> {
    return this.http.request<ChatSession[]>('/chats', { query: { workspaceId } });
  }

  get(chatId: string): Promise<ChatWithMessages> {
    return this.http.request<ChatWithMessages>(`/chats/${chatId}`);
  }

  update(chatId: string, patch: { title?: string; archived?: boolean }): Promise<ChatSession> {
    return this.http.request<ChatSession>(`/chats/${chatId}`, { method: 'PATCH', body: patch });
  }

  delete(chatId: string): Promise<unknown> {
    return this.http.request(`/chats/${chatId}`, { method: 'DELETE' });
  }

  /**
   * Returns as soon as the rows are created — NOT when the agent has answered.
   * Use `client.conversation(id).send()` for a promise that resolves with the
   * reply.
   */
  sendMessage(chatId: string, content: string, files?: File[]): Promise<SendMessageResult> {
    if (files?.length) {
      const form = new FormData();
      form.set('content', content);
      for (const f of files) form.append('files', f);
      return this.http.request<SendMessageResult>(`/chats/${chatId}/messages`, { method: 'POST', body: form });
    }
    return this.http.request<SendMessageResult>(`/chats/${chatId}/messages`, { method: 'POST', body: { content } });
  }

  /** Idempotent — stopping an already-finished turn is a no-op, not an error. */
  stopMessage(chatId: string, messageId: string): Promise<{ ok: boolean; stopped: boolean }> {
    return this.http.request(`/chats/${chatId}/messages/${messageId}/stop`, { method: 'POST' });
  }

  /**
   * Fetch a message's generated file. The index is zero-based and defaults to
   * the first deliverable. Use file.text(), file.arrayBuffer(), or a blob URL.
   * Authentication and token refresh use this client's existing transport.
   */
  async getDeliverable(
    message: Pick<ChatMessage, 'chatId' | 'id' | 'deliverable'>,
    index = 0,
    options: { signal?: AbortSignal } = {},
  ): Promise<File> {
    const deliverable = message.deliverable?.[index];
    if (!Number.isInteger(index) || index < 0 || !deliverable) {
      throw new RangeError(`No deliverable at index ${index}.`);
    }
    // Inline mode returns bytes through the hub instead of redirecting fetch
    // to object storage, where cross-origin requests may be rejected.
    const blob = await this.http.requestBlob(deliverablePath(message.chatId, message.id, index), {
      query: { inline: true },
      signal: options.signal,
    });
    return new File([blob], deliverable.filename, {
      type: blob.type || deliverable.mimeType || 'application/octet-stream',
    });
  }

  /** URL for a produced file. The request needs the caller's credential. */
  deliverableUrl(chatId: string, messageId: string, index: number): string {
    return `${this.http.origin}${deliverablePath(chatId, messageId, index)}`;
  }
}

function deliverablePath(chatId: string, messageId: string, index: number): string {
  return `/chats/${chatId}/messages/${messageId}/deliverables/${index}`;
}

export class AgentsResource {
  constructor(private readonly http: HttpTransport) {}

  list(workspaceId: string): Promise<Agent[]> {
    return this.http.request<Agent[]>(`/workspaces/${workspaceId}/agents`);
  }

  get(workspaceId: string, agentId: string): Promise<Agent> {
    return this.http.request<Agent>(`/workspaces/${workspaceId}/agents/${agentId}`);
  }
}

export class WorkspacesResource {
  constructor(private readonly http: HttpTransport) {}

  /** For an API key this returns only the workspace the key is bound to. */
  list(): Promise<Workspace[]> {
    return this.http.request<Workspace[]>('/workspaces');
  }

  get(workspaceId: string): Promise<Workspace> {
    return this.http.request<Workspace>(`/workspaces/${workspaceId}`);
  }
}
