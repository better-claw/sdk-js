import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatEventStream, type WebSocketLike } from '../src/ws/chat-event-stream.js';
import { CLOSE_CODES } from '../src/protocol/index.js';

/** A socket the test drives by hand. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = 3;
  });
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  emitRaw(data: string) {
    this.onmessage?.({ data });
  }
  fail(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function setup(opts: { url?: () => Promise<string> } = {}) {
  const sockets: FakeSocket[] = [];
  const events: unknown[] = [];
  const authErrors: Array<{ code: number; reason: string }> = [];
  const stream = new ChatEventStream({
    url: opts.url ?? (async () => 'ws://api.test/ws/chats?token=tok&workspaceId=ws-1'),
    onEvent: (e) => events.push(e),
    onAuthError: (code, reason) => authErrors.push({ code, reason }),
    createWebSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  return { stream, sockets, events, authErrors };
}

/**
 * `connect()` now resolves on open, so the fake socket has to be opened while
 * the promise is still pending.
 */
async function connectOpen(stream: ChatEventStream, sockets: FakeSocket[]) {
  const p = stream.connect();
  await vi.advanceTimersByTimeAsync(0);
  sockets[sockets.length - 1]!.open();
  await p;
}

describe('ChatEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects and forwards parsed frames', async () => {
    const { stream, sockets, events } = setup();
    await connectOpen(stream, sockets);
    expect(stream.connected).toBe(true);
    sockets[0]!.emit({ type: 'connected' });
    expect(events).toEqual([{ type: 'connected' }]);
  });

  it('survives an unparseable frame', async () => {
    const { stream, sockets, events } = setup();
    await connectOpen(stream, sockets);
    sockets[0]!.emitRaw('not json');
    sockets[0]!.emit({ type: 'connected' });
    expect(events).toEqual([{ type: 'connected' }]);
  });

  /**
   * `await connect()` must mean the socket is open. Resolving as soon as a
   * socket object exists leaves `connected` false immediately afterwards, which
   * is a confusing thing to hand a caller.
   */
  describe('connect() resolves on open', () => {
    it('waits for the socket to open', async () => {
      const { stream, sockets } = setup();
      let resolved = false;
      const promise = stream.connect().then(() => (resolved = true));

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      sockets[0]!.open();
      await promise;
      expect(stream.connected).toBe(true);
    });

    // Otherwise a caller — and every send() awaiting it — hangs while the hub
    // is down, instead of proceeding while the retry runs in the background.
    it('does not hang when the attempt fails before opening', async () => {
      const { stream, sockets } = setup();
      const promise = stream.connect();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.fail(1006);
      await expect(promise).resolves.toBeUndefined();
      expect(stream.connected).toBe(false);
    });

    it('does not hang when the URL cannot be built', async () => {
      const { stream } = setup({
        url: async () => {
          throw new Error('token endpoint down');
        },
      });
      await expect(stream.connect()).resolves.toBeUndefined();
    });

    it('does not hang on a terminal close', async () => {
      const { stream, sockets } = setup();
      const promise = stream.connect();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.fail(CLOSE_CODES.KEY_REVOKED);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  it('does not open a second socket while one is live', async () => {
    const { stream, sockets } = setup();
    await connectOpen(stream, sockets);
    await stream.connect();
    expect(sockets).toHaveLength(1);
  });

  describe('reconnection', () => {
    it('reconnects with exponential backoff after an unexpected close', async () => {
      const { stream, sockets } = setup();
      await connectOpen(stream, sockets);
      sockets[0]!.fail(1006);

      // First retry is 2s (1000 * 2^1).
      await vi.advanceTimersByTimeAsync(1999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(sockets).toHaveLength(2);
    });

    it('caps the backoff at 30s', async () => {
      const { stream, sockets } = setup();
      const first = stream.connect();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.open();
      await first;
      for (let i = 0; i < 8; i++) {
        sockets[sockets.length - 1]!.fail(1006);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      // Would have grown past 30s without the cap; each round still connects.
      expect(sockets.length).toBeGreaterThan(6);
    });

    it('resets the backoff after a successful open', async () => {
      const { stream, sockets } = setup();
      await connectOpen(stream, sockets);
      sockets[0]!.fail(1006);
      await vi.advanceTimersByTimeAsync(2000);
      sockets[1]!.open();
      sockets[1]!.fail(1006);
      // Back to the first step rather than continuing to grow.
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(3);
    });

    it('retries when the URL cannot be built — the token endpoint may be down', async () => {
      let fail = true;
      const { stream, sockets } = setup({
        url: async () => {
          if (fail) throw new Error('token endpoint down');
          return 'ws://api.test/ws/chats?token=tok';
        },
      });
      await stream.connect();
      expect(sockets).toHaveLength(0);
      fail = false;
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(1);
    });

    it('stops reconnecting after an intentional disconnect', async () => {
      const { stream, sockets } = setup();
      await connectOpen(stream, sockets);
      stream.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
    });
  });

  /**
   * Reconnecting against a dead credential is a hot loop that can never
   * succeed. AUTH_FAILED is deliberately NOT terminal: an expired session token
   * is worth one more try after a refresh.
   */
  describe('terminal close codes', () => {
    for (const code of [CLOSE_CODES.MISSING_TOKEN, CLOSE_CODES.FORBIDDEN, CLOSE_CODES.KEY_REVOKED]) {
      it(`stops reconnecting on ${code} and reports it`, async () => {
        const { stream, sockets, authErrors } = setup();
        await connectOpen(stream, sockets);
        sockets[0]!.fail(code, 'nope');

        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(1);
        expect(authErrors).toEqual([{ code, reason: 'nope' }]);
      });
    }

    it('keeps retrying on 4003, which a refresh can fix', async () => {
      const { stream, sockets, authErrors } = setup();
      await connectOpen(stream, sockets);
      sockets[0]!.fail(CLOSE_CODES.AUTH_FAILED);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(2);
      expect(authErrors).toHaveLength(0);
    });

    it('keeps retrying on an ordinary transport close', async () => {
      const { stream, sockets } = setup();
      await connectOpen(stream, sockets);
      sockets[0]!.fail(1006);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(2);
    });
  });

  // A backgrounded tab has its timers throttled, so waiting out the backoff can
  // leave a mid-turn stream blank for many seconds after the user returns.
  it('reconnects immediately on reconnectNow, skipping the backoff', async () => {
    const { stream, sockets } = setup();
    await connectOpen(stream, sockets);
    sockets[0]!.fail(1006);
    stream.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
  });

  it('reports status transitions', async () => {
    const sockets: FakeSocket[] = [];
    const seen: boolean[] = [];
    const stream = new ChatEventStream({
      url: async () => 'ws://api.test/ws/chats',
      onEvent: () => {},
      onStatusChange: (c) => seen.push(c),
      createWebSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });

    await connectOpen(stream, sockets);
    expect(seen).toEqual([true]);

    sockets[0]!.fail(1006);
    expect(seen).toEqual([true, false]);
    stream.disconnect();
  });

  // Otherwise a caller awaiting connect() while another code path tears the
  // client down waits forever on a socket that will never open.
  it('releases a pending connect() when disconnected mid-attempt', async () => {
    const { stream } = setup();
    const promise = stream.connect();
    await vi.advanceTimersByTimeAsync(0);
    stream.disconnect();
    await expect(promise).resolves.toBeUndefined();
  });
});
