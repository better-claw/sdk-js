import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Conversation } from '../src/conversation.js';
import { ChatStore } from '../src/store/chat-store.js';
import { TurnTimeoutError } from '../src/http/errors.js';
import type { ChatMessage, ChatWithMessages } from '../src/protocol/index.js';

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm-1',
  chatId: 'c-1',
  role: 'assistant',
  status: 'streaming',
  content: '',
  turnIndex: 1,
  ...over,
});

const chatWith = (messages: ChatMessage[]): ChatWithMessages => ({
  id: 'c-1',
  userId: 'u-1',
  workspaceId: 'ws-1',
  agentId: 'a-1',
  agentName: 'Ada',
  title: null,
  messages,
});

function setup(opts: { fetched?: ChatWithMessages } = {}) {
  const store = new ChatStore();
  const chats = {
    get: vi.fn(async () => opts.fetched ?? chatWith([])),
    sendMessage: vi.fn(async () => ({
      userMessage: message({ id: 'm-0', role: 'user' }),
      assistantMessage: message(),
    })),
    stopMessage: vi.fn(async () => ({ ok: true, stopped: true })),
  } as any;
  const connect = vi.fn(async () => {});
  const convo = new Conversation('c-1', chats, store, connect, { wakingAfterMs: 1000, turnTimeoutMs: 10_000 });
  return { store, chats, connect, convo };
}

describe('Conversation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('send', () => {
    it('resolves only once the turn reaches a terminal state', async () => {
      const { store, convo } = setup();
      store.applyFetchedChat(chatWith([message()]));

      const promise = convo.send('hello');
      await vi.advanceTimersByTimeAsync(0);
      // The placeholder row already says `streaming`, but nothing has been
      // produced yet — so the conversation is still merely `sending`.
      expect(convo.status).toBe('sending');

      store.apply({ type: 'message_streaming', chatId: 'c-1', messageId: 'm-1', content: 'hi', status: 'streaming' });
      expect(convo.status).toBe('streaming');

      store.apply({ type: 'message_upserted', chatId: 'c-1', message: message({ status: 'complete', content: 'hi' }) });
      await expect(promise).resolves.toMatchObject({ status: 'complete', content: 'hi' });
      expect(convo.status).toBe('complete');
    });

    // The distinction the `waking` state depends on: a row is not progress.
    it('does not call an empty placeholder row streaming', async () => {
      const { store, convo } = setup();
      store.applyFetchedChat(chatWith([message()]));
      const promise = convo.send('hello');
      await vi.advanceTimersByTimeAsync(0);
      expect(convo.status).toBe('sending');

      // Thinking text with no visible content still counts as progress.
      store.apply({
        type: 'message_streaming',
        chatId: 'c-1',
        messageId: 'm-1',
        content: '',
        thinking: 'Let me look',
        status: 'streaming',
      });
      expect(convo.status).toBe('streaming');

      store.apply({ type: 'message_upserted', chatId: 'c-1', message: message({ status: 'complete' }) });
      await promise;
    });

    it('correlates on the placeholder id, not the latest message', async () => {
      const { store, convo } = setup();
      store.applyFetchedChat(chatWith([message()]));
      const promise = convo.send('hello');
      await vi.advanceTimersByTimeAsync(0);

      // A different turn finishing must not settle this one.
      store.apply({
        type: 'message_upserted',
        chatId: 'c-1',
        message: message({ id: 'm-other', status: 'complete', turnIndex: 5 }),
      });
      let settled = false;
      void promise.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);

      store.apply({ type: 'message_upserted', chatId: 'c-1', message: message({ status: 'complete' }) });
      await expect(promise).resolves.toMatchObject({ id: 'm-1' });
    });

    it('surfaces an errored turn as a resolved message with error status', async () => {
      const { store, convo } = setup();
      store.applyFetchedChat(chatWith([message()]));
      const promise = convo.send('hello');
      await vi.advanceTimersByTimeAsync(0);
      store.apply({ type: 'message_upserted', chatId: 'c-1', message: message({ status: 'error' }) });
      await expect(promise).resolves.toMatchObject({ status: 'error' });
      expect(convo.status).toBe('error');
    });
  });

  /**
   * The HTTP call returns instantly, so a cold agent starting a Fly machine is
   * indistinguishable from a hang until the first frame lands. Without this the
   * UI sits on "sending" for up to six minutes.
   */
  describe('waking', () => {
    it('reports waking after silence', async () => {
      const { store, convo } = setup();
      store.applyFetchedChat(chatWith([message()]));
      const seen: string[] = [];
      convo.on('status', (s) => seen.push(s));

      const promise = convo.send('hello');
      await vi.advanceTimersByTimeAsync(1100);
      expect(seen).toContain('waking');

      store.apply({ type: 'message_upserted', chatId: 'c-1', message: message({ status: 'complete' }) });
      await promise;
    });

    it('does not report waking when the agent answers promptly', async () => {
      const { store, convo } = setup();
      store.applyFetchedChat(chatWith([message()]));
      const seen: string[] = [];
      convo.on('status', (s) => seen.push(s));

      const promise = convo.send('hello');
      await vi.advanceTimersByTimeAsync(10);
      store.apply({ type: 'message_streaming', chatId: 'c-1', messageId: 'm-1', content: 'hi', status: 'streaming' });
      await vi.advanceTimersByTimeAsync(2000);
      store.apply({ type: 'message_upserted', chatId: 'c-1', message: message({ status: 'complete' }) });
      await promise;

      expect(seen).not.toContain('waking');
    });

    it('rejects with TurnTimeoutError past the deadline', async () => {
      const { store, convo } = setup();
      store.applyFetchedChat(chatWith([message()]));
      const promise = convo.send('hello');
      const assertion = expect(promise).rejects.toBeInstanceOf(TurnTimeoutError);
      await vi.advanceTimersByTimeAsync(10_100);
      await assertion;
    });
  });

  /**
   * After a reload the promise from `send()` is gone, so resumption has to be
   * driven off the persisted `status: 'streaming'` row.
   */
  describe('resume', () => {
    it('reattaches to a turn still in flight', async () => {
      const { convo, store } = setup({ fetched: chatWith([message({ status: 'streaming' })]) });
      const promise = convo.resume();
      await vi.advanceTimersByTimeAsync(0);

      store.apply({
        type: 'message_upserted',
        chatId: 'c-1',
        message: message({ status: 'complete', content: 'done' }),
      });
      await expect(promise).resolves.toMatchObject({ content: 'done' });
    });

    // The turn finished while the page was away: there is no live snapshot left
    // to replay, so waiting for a frame would hang forever.
    it('resolves null immediately when the turn already finished', async () => {
      const { convo } = setup({ fetched: chatWith([message({ status: 'complete' })]) });
      const promise = convo.resume();
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeNull();
      expect(convo.status).toBe('idle');
    });

    it('resolves null when there is no turn at all', async () => {
      const { convo } = setup({ fetched: chatWith([]) });
      const promise = convo.resume();
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeNull();
    });
  });

  describe('hydrate', () => {
    // Connect first so frames emitted during the fetch are buffered, not lost.
    it('opens the socket before fetching history', async () => {
      const order: string[] = [];
      const store = new ChatStore();
      const chats = {
        get: vi.fn(async () => {
          order.push('fetch');
          return chatWith([]);
        }),
      } as any;
      const connect = vi.fn(async () => {
        order.push('connect');
      });
      await new Conversation('c-1', chats, store, connect).hydrate();
      expect(order).toEqual(['connect', 'fetch']);
    });
  });

  describe('stop', () => {
    it('cancels the in-flight turn', async () => {
      const { convo, chats, store } = setup();
      store.applyFetchedChat(chatWith([message({ status: 'streaming' })]));
      await convo.stop();
      expect(chats.stopMessage).toHaveBeenCalledWith('c-1', 'm-1');
    });

    it('is a no-op when nothing is streaming', async () => {
      const { convo, chats, store } = setup();
      store.applyFetchedChat(chatWith([message({ status: 'complete' })]));
      await convo.stop();
      expect(chats.stopMessage).not.toHaveBeenCalled();
    });
  });
});
