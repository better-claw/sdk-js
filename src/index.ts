export { BetterClawClient, type BetterClawClientOptions } from './client.js';
export {
  Conversation,
  type ConversationOptions,
  type ConversationStatus,
  type ConversationEvents,
} from './conversation.js';

export { SessionTokenAuth, type AuthProvider, type SessionTokenFetcher } from './auth/index.js';

export { ChatStore, type ChatState, type LiveTurn, type StoreSnapshot } from './store/chat-store.js';
export { ChatEventStream, type WebSocketLike, type WebSocketFactory } from './ws/chat-event-stream.js';
export {
  ChatsResource,
  AgentsResource,
  WorkspacesResource,
  type CreateChatInput,
  type SendMessageResult,
} from './resources/index.js';
export { HttpTransport } from './http/transport.js';

export {
  BetterClawError,
  AuthError,
  ForbiddenError,
  PaymentRequiredError,
  NotFoundError,
  RateLimitError,
  AgentUnreachableError,
  TurnTimeoutError,
} from './http/errors.js';

export type {
  Agent,
  ChatEvent,
  ChatMessage,
  ChatMessageRole,
  ChatMessageStatus,
  ChatSession,
  ChatStreamEvent,
  ChatWithMessages,
  SdkScope,
  SdkSessionToken,
  SubagentEvent,
  TodoChecklistItem,
  Workspace,
} from './protocol/index.js';
export { CLOSE_CODES, TERMINAL_CLOSE_CODES, SDK_SCOPES } from './protocol/index.js';
