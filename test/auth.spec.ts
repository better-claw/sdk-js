import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionTokenAuth } from '../src/auth/index.js';
import { ApiKeyAuth } from '../src/auth/api-key-auth.js';
import type { SdkSessionToken } from '../src/protocol/index.js';

const token = (over: Partial<SdkSessionToken> = {}): SdkSessionToken => ({
  token: 'bcs_abc',
  expiresIn: 600,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  workspaceId: 'ws-1',
  userId: 'u-1',
  agentId: null,
  scopes: ['chats:read', 'chats:write'],
  ...over,
});

describe('SessionTokenAuth', () => {
  it('fetches once and caches', async () => {
    const fetcher = vi.fn(async () => token());
    const auth = new SessionTokenAuth(fetcher);
    expect(await auth.getHeaderToken()).toBe('bcs_abc');
    await auth.getHeaderToken();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // A page that fires several requests at mount should mint one token, not one
  // per request.
  it('collapses concurrent refreshes into one fetch', async () => {
    const fetcher = vi.fn(async () => token());
    const auth = new SessionTokenAuth(fetcher);
    await Promise.all([auth.getHeaderToken(), auth.getHeaderToken(), auth.getHeaderToken()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidate', async () => {
    const fetcher = vi.fn(async () => token());
    const auth = new SessionTokenAuth(fetcher);
    await auth.getHeaderToken();
    auth.invalidate();
    await auth.getHeaderToken();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // Refreshing only at expiry means a request minted at T-1ms can arrive dead.
  it('refreshes before expiry rather than at it', async () => {
    const fetcher = vi.fn(async () => token({ expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    const auth = new SessionTokenAuth(fetcher);
    await auth.getHeaderToken();
    await auth.getHeaderToken();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('exposes the session claims once fetched', async () => {
    const auth = new SessionTokenAuth(async () => token({ agentId: 'agent-9' }));
    expect(auth.session).toBeNull();
    await auth.getHeaderToken();
    expect(auth.session).toMatchObject({ workspaceId: 'ws-1', agentId: 'agent-9' });
  });

  // Safe in a URL — that is the entire reason this credential type exists.
  it('may be used as a WebSocket query token', async () => {
    const auth = new SessionTokenAuth(async () => token());
    expect(await auth.getQueryToken()).toBe('bcs_abc');
  });

  it('does not cache a failed fetch', async () => {
    let calls = 0;
    const auth = new SessionTokenAuth(async () => {
      if (++calls === 1) throw new Error('backend down');
      return token();
    });
    await expect(auth.getHeaderToken()).rejects.toThrow('backend down');
    expect(await auth.getHeaderToken()).toBe('bcs_abc');
  });
});

describe('ApiKeyAuth', () => {
  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  it('sends the key on the Authorization header', async () => {
    const auth = new ApiKeyAuth('bc_sk_test');
    expect(await auth.getHeaderToken()).toBe('bc_sk_test');
  });

  /**
   * Never in a URL: query strings reach access logs, proxy logs and Referer
   * headers. The Node WebSocket client sends it as an upgrade header instead.
   */
  it('refuses to be used as a query token', async () => {
    expect(await new ApiKeyAuth('bc_sk_test').getQueryToken()).toBeNull();
  });

  // Defence in depth: the /server entry point already keeps this out of a
  // browser bundle, and the hub refuses a raw key that arrives with an Origin.
  it('throws when constructed in a browser', () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    expect(() => new ApiKeyAuth('bc_sk_test')).toThrow(/server-side secret/);
  });

  it('rejects an empty key', () => {
    expect(() => new ApiKeyAuth('')).toThrow(/API key is required/);
  });
});
