import { describe, it, expect, vi } from 'vitest';
import { Conversation } from '../src/conversation.js';
import { ChatStore } from '../src/store/chat-store.js';
import type { ChatMessage, ChatWithMessages } from '../src/protocol/index.js';

/**
 * The adapters are thin, but the seam between them and `Conversation` is not:
 * both hooks bind their local `status` state to an event, and an event only
 * fires on a CHANGE. This covers that seam without a DOM renderer.
 */

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm-1',
  chatId: 'c-1',
  role: 'assistant',
  status: 'complete',
  content: 'done',
  turnIndex: 1,
  ...over,
});

const chatWith = (id: string, messages: ChatMessage[]): ChatWithMessages => ({
  id,
  userId: 'u-1',
  workspaceId: 'ws-1',
  agentId: 'a-1',
  agentName: 'Ada',
  title: null,
  messages,
});

function makeConversation(chatId: string, messages: ChatMessage[]) {
  const store = new ChatStore();
  const chats = {
    get: vi.fn(async () => chatWith(chatId, messages)),
    sendMessage: vi.fn(),
    stopMessage: vi.fn(),
  } as any;
  return { store, convo: new Conversation(chatId, chats, store, async () => {}) };
}

describe('adapter status binding', () => {
  /**
   * The bug this guards: `emitStatus` dedupes, and a fresh Conversation starts
   * at 'idle'. So `resume()` finding nothing in flight emits 'idle' → no-op →
   * no listener fires. A hook that only subscribes would keep rendering the
   * PREVIOUS chat's status (e.g. "waking") after switching to an idle chat.
   *
   * Both adapters therefore seed from `conversation.status` synchronously on
   * attach rather than waiting for an event.
   */
  it('exposes a readable status synchronously, so a subscriber can seed from it', async () => {
    const { convo } = makeConversation('c-idle', [message()]);

    // Nothing in flight: resume settles without ever emitting.
    const emitted: string[] = [];
    convo.on('status', (s) => emitted.push(s));
    await convo.resume();

    expect(emitted).toEqual([]); // no event — this is what made it stale
    expect(convo.status).toBe('idle'); // but the value is readable
  });

  // A turn resumed after a reload is in flight but silent until the first
  // frame; reporting 'idle' there would render a finished-looking chat that is
  // actually mid-answer.
  it('reports a resumed in-flight turn rather than idle', async () => {
    const { convo } = makeConversation('c-busy', [message({ status: 'streaming', content: '' })]);
    const emitted: string[] = [];
    convo.on('status', (s) => emitted.push(s));
    void convo.resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(convo.status).toBe('sending');
    expect(emitted).toContain('sending');
  });

  // Two conversations must not share status — the adapters key their local
  // state off whichever one is currently selected.
  it('keeps status independent per conversation', async () => {
    const busy = makeConversation('c-busy', [message({ status: 'streaming', content: '' })]);
    const idle = makeConversation('c-idle', [message()]);

    void busy.convo.resume();
    await new Promise((r) => setTimeout(r, 0));
    await idle.convo.resume();

    expect(busy.convo.status).toBe('sending');
    expect(idle.convo.status).toBe('idle');
  });
});
