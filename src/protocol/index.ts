/**
 * The hub's wire protocol, mirrored.
 *
 * The hub's own definitions live in `packages/shared/src/` of the betterclaw
 * monorepo, which is `private: true` and cannot be depended on from here. These
 * types must therefore stay in lockstep with:
 *
 *   apps/api/src/chats/chat-events.gateway.ts   — the ChatEvent union
 *   packages/shared/src/sdk-auth.ts             — scopes and close codes
 *
 * `test/protocol-parity.spec.ts` diffs them against the source when
 * BETTERCLAW_REPO points at a checkout; it is skipped otherwise.
 */

export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageStatus = 'streaming' | 'complete' | 'error';

export interface TodoChecklistItem {
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SubagentEvent {
  id: string;
  name?: string;
  status: string;
  summary?: string;
}

export interface ChatDeliverable {
  filename: string;
  mimeType?: string;
  bytes?: number;
}

export interface ChatMessageAttachment {
  filename: string;
  mimeType?: string;
  bytes?: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatMessageRole;
  status: ChatMessageStatus;
  content: string;
  deliverable?: ChatDeliverable[] | null;
  updates?: Array<{ timestamp: string; message: string; status?: string }> | null;
  attachments?: ChatMessageAttachment[] | null;
  errorMessage?: string | null;
  turnIndex: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatSession {
  id: string;
  userId: string;
  workspaceId: string | null;
  agentId: string | null;
  agentName: string;
  title: string | null;
  isShared?: boolean;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A chat plus its full message history, as `GET /chats/:id` returns it. */
export interface ChatWithMessages extends ChatSession {
  messages: ChatMessage[];
}

/**
 * Frames on `/ws/chats`. The socket is receive-only — the client never sends.
 *
 * `message_streaming.content` and `.thinking` are CUMULATIVE, not deltas: each
 * frame carries the whole text so far. `thinking`, `todos` and `subagents` are
 * transient and never persisted, so only a live frame (or the gateway's replay
 * on reconnect) can produce them — a REST refetch cannot.
 */
export type ChatEvent =
  | { type: 'connected' }
  | { type: 'chat_upserted'; chat: ChatSession }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'message_upserted'; chatId: string; message: ChatMessage }
  | {
      type: 'message_streaming';
      chatId: string;
      messageId: string;
      content: string;
      status: ChatMessageStatus;
      thinking?: string;
      todos?: TodoChecklistItem[];
      subagents?: SubagentEvent[];
    };

export type ChatStreamEvent = Extract<ChatEvent, { type: 'message_streaming' }>;

export const SDK_SCOPES = ['chats:read', 'chats:write', 'agents:read', 'workspaces:read'] as const;
export type SdkScope = (typeof SDK_SCOPES)[number];

/**
 * `/ws/chats` close codes. 4001-4004 predate SDK auth; 4005 is the SDK's own.
 */
export const CLOSE_CODES = {
  MISSING_TOKEN: 4001,
  USER_NOT_FOUND: 4002,
  AUTH_FAILED: 4003,
  FORBIDDEN: 4004,
  KEY_REVOKED: 4005,
} as const;

/**
 * Codes after which reconnecting can only fail again. AUTH_FAILED is absent on
 * purpose: an expired session token is worth one more try after a refresh.
 */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  CLOSE_CODES.MISSING_TOKEN,
  CLOSE_CODES.FORBIDDEN,
  CLOSE_CODES.KEY_REVOKED,
]);

/** Response of `POST /auth/sdk-token`. */
export interface SdkSessionToken {
  token: string;
  expiresIn: number;
  expiresAt: string;
  workspaceId: string;
  userId: string;
  agentId: string | null;
  scopes: SdkScope[];
}

export interface Agent {
  id: string;
  name: string;
  workspaceId?: string;
  [key: string]: unknown;
}

export interface Workspace {
  id: string;
  name?: string;
  [key: string]: unknown;
}
