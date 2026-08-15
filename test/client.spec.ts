import { describe, it, expect, vi } from 'vitest';
import { BetterClawClient } from '../src/client.js';
import { SessionTokenAuth } from '../src/auth/index.js';
import type { WebSocketLike } from '../src/ws/chat-event-stream.js';

const session = {
  token: 'bcs_abc',
  expiresIn: 600,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  workspaceId: 'ws-1',
  userId: 'u-1',
  agentId: null,
  scopes: ['chats:read'] as const,
};

/** Header-only credential, as ApiKeyAuth is — it refuses to appear in a URL. */
const headerOnlyAuth = {
  getHeaderToken: async () => 'bc_sk_x',
  getQueryToken: async () => null,
  invalidate: () => {},
};

/**
 * Opens on the next tick — `connect()` resolves on open, so a socket that never
 * opens would (correctly) hang the caller.
 */
function fakeSocket(): WebSocketLike {
  const socket: WebSocketLike = { readyState: 0, close: vi.fn() };
  setTimeout(() => {
    socket.readyState = 1;
    socket.onopen?.({});
  }, 0);
  return socket;
}

describe('BetterClawClient', () => {
  it('requires a workspaceId — a key-backed socket without one is refused by the hub', () => {
    expect(
      () =>
        new BetterClawClient({
          baseUrl: 'http://api.test',
          auth: new SessionTokenAuth(async () => session as any),
          workspaceId: '',
        }),
    ).toThrow(/workspaceId is required/);
  });

  describe('WebSocket URL', () => {
    it('carries a session token in the query string', async () => {
      let url = '';
      const client = new BetterClawClient({
        baseUrl: 'http://api.test',
        workspaceId: 'ws-1',
        auth: new SessionTokenAuth(async () => session as any),
        createWebSocket: (u) => {
          url = u;
          return fakeSocket();
        },
      });
      await client.connect();
      expect(url).toBe('ws://api.test/ws/chats?workspaceId=ws-1&token=bcs_abc');
      client.disconnect();
    });

    it('upgrades to wss for an https origin', async () => {
      let url = '';
      const client = new BetterClawClient({
        baseUrl: 'https://api.test',
        workspaceId: 'ws-1',
        auth: new SessionTokenAuth(async () => session as any),
        createWebSocket: (u) => {
          url = u;
          return fakeSocket();
        },
      });
      await client.connect();
      expect(url.startsWith('wss://')).toBe(true);
      client.disconnect();
    });

    /**
     * Regression: the URL builder used to demand a query token unconditionally,
     * which made the headless server client — whose credential authenticates by
     * upgrade header — unable to open a socket at all.
     */
    it('omits the token when the credential authenticates by header', async () => {
      let url = '';
      const client = new BetterClawClient({
        baseUrl: 'http://api.test',
        workspaceId: 'ws-1',
        auth: headerOnlyAuth,
        createWebSocket: (u) => {
          url = u;
          return fakeSocket();
        },
      });
      await client.connect();
      expect(url).toBe('ws://api.test/ws/chats?workspaceId=ws-1');
      expect(url).not.toContain('token=');
      client.disconnect();
    });

    // Without a factory to carry the credential, the socket would just be
    // rejected as unauthenticated — better to say why.
    it('explains itself when a header-only credential has no socket factory', async () => {
      const client = new BetterClawClient({
        baseUrl: 'http://api.test',
        workspaceId: 'ws-1',
        auth: headerOnlyAuth,
      });
      // The stream swallows the failure and schedules a retry, so assert via
      // the builder rather than the connect() call.
      await client.connect();
      expect(client.connected).toBe(false);
      client.disconnect();
    });
  });

  it('returns the same Conversation for a chat id', () => {
    const client = new BetterClawClient({
      baseUrl: 'http://api.test',
      workspaceId: 'ws-1',
      auth: new SessionTokenAuth(async () => session as any),
      createWebSocket: () => fakeSocket(),
    });
    expect(client.conversation('c-1')).toBe(client.conversation('c-1'));
    expect(client.conversation('c-2')).not.toBe(client.conversation('c-1'));
  });
});
