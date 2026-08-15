import { describe, it, expect, beforeEach } from 'vitest';
import { ChatStore } from '../src/store/chat-store.js';
import type { ChatEvent, ChatMessage, ChatWithMessages } from '../src/protocol/index.js';

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm-1',
  chatId: 'c-1',
  role: 'assistant',
  status: 'streaming',
  content: '',
  turnIndex: 1,
  ...over,
});

const chat = (over: Partial<ChatWithMessages> = {}): ChatWithMessages => ({
  id: 'c-1',
  userId: 'u-1',
  workspaceId: 'ws-1',
  agentId: 'a-1',
  agentName: 'Ada',
  title: 'Test',
  messages: [],
  ...over,
});

const streaming = (over: Partial<Extract<ChatEvent, { type: 'message_streaming' }>> = {}): ChatEvent => ({
  type: 'message_streaming',
  chatId: 'c-1',
  messageId: 'm-1',
  content: '',
  status: 'streaming',
  ...over,
});

describe('ChatStore', () => {
  let store: ChatStore;
  beforeEach(() => {
    store = new ChatStore();
  });

  /**
   * The single most important behaviour in the SDK. `message_streaming.content`
   * is CUMULATIVE, and the gateway replays the last frame on every reconnect —
   * so an appending reducer silently doubles the reply the first time a socket
   * drops, which is exactly when nobody is looking.
   */
  describe('cumulative content', () => {
    it('assigns rather than appends across successive frames', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      store.apply(streaming({ content: 'Hel' }));
      store.apply(streaming({ content: 'Hello' }));
      store.apply(streaming({ content: 'Hello world' }));
      expect(store.get('c-1').messages[0]!.content).toBe('Hello world');
    });

    it('does not double text when the same frame is replayed', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      const frame = streaming({ content: 'Hello world' });
      store.apply(frame);
      store.apply(frame); // the gateway's replay after a reconnect
      expect(store.get('c-1').messages[0]!.content).toBe('Hello world');
    });

    it('treats thinking the same way', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      store.apply(streaming({ content: 'x', thinking: 'Considering' }));
      store.apply(streaming({ content: 'x', thinking: 'Considering the options' }));
      expect(store.liveTurn('c-1', 'm-1')?.thinking).toBe('Considering the options');
    });

    it('tolerates a frame that goes backwards without corrupting state', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      store.apply(streaming({ content: 'Hello world' }));
      store.apply(streaming({ content: 'Hello' }));
      expect(store.get('c-1').messages[0]!.content).toBe('Hello');
    });
  });

  describe('terminal frames', () => {
    it('clears the live snapshot when the turn ends', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      store.apply(streaming({ content: 'partial', thinking: 'hmm' }));
      expect(store.liveTurn('c-1', 'm-1')).toBeDefined();
      store.apply(streaming({ content: 'done', status: 'complete' }));
      expect(store.liveTurn('c-1', 'm-1')).toBeUndefined();
    });

    it('lets the persisted row win over the streamed text', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      store.apply(streaming({ content: 'streamed text' }));
      store.apply({
        type: 'message_upserted',
        chatId: 'c-1',
        message: message({ status: 'complete', content: 'final text' }),
      });
      expect(store.get('c-1').messages[0]!.content).toBe('final text');
      expect(store.get('c-1').messages[0]!.status).toBe('complete');
      expect(store.liveTurn('c-1', 'm-1')).toBeUndefined();
    });

    it('keeps partial text when a turn errors', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      store.apply(streaming({ content: 'half an ans', status: 'error' }));
      expect(store.get('c-1').messages[0]!.content).toBe('half an ans');
      expect(store.get('c-1').messages[0]!.status).toBe('error');
    });
  });

  /**
   * Both naive orderings are wrong: fetching first loses frames emitted during
   * the request, connecting first lets the older REST snapshot overwrite newer
   * streamed text. The buffer is what makes a mid-turn page load correct.
   */
  describe('hydration ordering', () => {
    it('does not lose a frame that arrives during the fetch', () => {
      store.beginHydration('c-1');
      store.apply(streaming({ content: 'streamed while fetching' }));
      // The REST snapshot is older — it shows the message still empty.
      store.applyFetchedChat(chat({ messages: [message({ content: '' })] }));
      expect(store.get('c-1').messages[0]!.content).toBe('streamed while fetching');
    });

    it('does not let the older snapshot clobber newer streamed text', () => {
      store.beginHydration('c-1');
      store.apply(streaming({ content: 'newer' }));
      store.applyFetchedChat(chat({ messages: [message({ content: 'older' })] }));
      expect(store.get('c-1').messages[0]!.content).toBe('newer');
    });

    it('replays buffered frames in order', () => {
      store.beginHydration('c-1');
      store.apply(streaming({ content: 'a' }));
      store.apply(streaming({ content: 'ab' }));
      store.apply(streaming({ content: 'abc' }));
      store.applyFetchedChat(chat({ messages: [message()] }));
      expect(store.get('c-1').messages[0]!.content).toBe('abc');
    });

    it('applies frames immediately once hydrated', () => {
      store.applyFetchedChat(chat({ messages: [message()] }));
      store.apply(streaming({ content: 'live' }));
      expect(store.get('c-1').messages[0]!.content).toBe('live');
    });

    it('buffers only the chat being hydrated', () => {
      store.beginHydration('c-1');
      store.applyFetchedChat(chat({ id: 'c-2', messages: [message({ id: 'm-2', chatId: 'c-2' })] }));
      store.apply(streaming({ chatId: 'c-2', messageId: 'm-2', content: 'other chat' }));
      expect(store.get('c-2').messages[0]!.content).toBe('other chat');
    });
  });

  describe('resumption', () => {
    it('finds the in-flight turn from persisted state alone', () => {
      store.applyFetchedChat(
        chat({
          messages: [
            message({ id: 'm-0', role: 'user', status: 'complete', turnIndex: 0 }),
            message({ id: 'm-1', status: 'streaming' }),
          ],
        }),
      );
      expect(store.streamingMessage('c-1')?.id).toBe('m-1');
    });

    it('reports nothing in flight when the turn already finished', () => {
      store.applyFetchedChat(chat({ messages: [message({ status: 'complete' })] }));
      expect(store.streamingMessage('c-1')).toBeUndefined();
    });

    it('ignores a streaming user message', () => {
      store.applyFetchedChat(chat({ messages: [message({ role: 'user', status: 'streaming' })] }));
      expect(store.streamingMessage('c-1')).toBeUndefined();
    });
  });

  describe('subscription', () => {
    it('publishes a new snapshot identity so identity checks detect the change', () => {
      const before = store.getSnapshot();
      store.applyFetchedChat(chat());
      expect(store.getSnapshot()).not.toBe(before);
    });

    it('notifies subscribers and stops after unsubscribe', () => {
      let calls = 0;
      const off = store.subscribe(() => calls++);
      store.applyFetchedChat(chat());
      expect(calls).toBe(1);
      off();
      store.apply({ type: 'chat_deleted', chatId: 'c-1' });
      expect(calls).toBe(1);
    });

    it('ignores the connected frame', () => {
      let calls = 0;
      store.subscribe(() => calls++);
      store.apply({ type: 'connected' });
      expect(calls).toBe(0);
    });
  });

  it('drops a deleted chat', () => {
    store.applyFetchedChat(chat());
    store.apply({ type: 'chat_deleted', chatId: 'c-1' });
    expect(store.get('c-1').chat).toBeNull();
  });

  it('appends a message it has not seen before', () => {
    store.applyFetchedChat(chat({ messages: [message({ id: 'm-1' })] }));
    store.apply({ type: 'message_upserted', chatId: 'c-1', message: message({ id: 'm-2', turnIndex: 2 }) });
    expect(store.get('c-1').messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  });
});
