import { describe, it, expect, vi } from 'vitest';
import { HttpTransport } from '../src/http/transport.js';
import {
  AuthError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitError,
  AgentUnreachableError,
  BetterClawError,
} from '../src/http/errors.js';

const auth = (over: Partial<Record<string, any>> = {}) => ({
  getHeaderToken: vi.fn(async () => 'tok'),
  getQueryToken: vi.fn(async () => 'tok'),
  invalidate: vi.fn(),
  ...over,
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers });
}

/**
 * The mocks are declared without argument types, so `mock.calls` infers as an
 * empty tuple. This reads the request the transport actually built.
 */
function requestAt(
  fetchImpl: unknown,
  index = 0,
): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = (fetchImpl as { mock: { calls: unknown[][] } }).mock.calls[index] as [
    string,
    RequestInit & { headers: Record<string, string> },
  ];
  return { url, init };
}

describe('HttpTransport', () => {
  it('sends the bearer token and parses JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'c-1' }));
    const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
    await expect(t.request('/chats/c-1')).resolves.toEqual({ id: 'c-1' });
    expect(requestAt(fetchImpl).init.headers.authorization).toBe('Bearer tok');
  });

  it('builds query strings and skips undefined values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []));
    const t = new HttpTransport({ baseUrl: 'http://api.test/', auth: auth() as any, fetch: fetchImpl as any });
    await t.request('/chats', { query: { workspaceId: 'ws-1', archived: undefined } });
    expect(requestAt(fetchImpl).url).toBe('http://api.test/chats?workspaceId=ws-1');
  });

  /**
   * Regression, browser-only in the wild: storing `globalThis.fetch` on the
   * instance and calling it as `this.fetchImpl(...)` invokes it with the
   * transport as its receiver. The DOM implementation rejects that with
   * "Illegal invocation"; Node's does not care, so no amount of Node testing
   * catches it. Here a receiver-checking stub stands in for the browser.
   */
  it('calls the global fetch with the correct receiver', async () => {
    const original = globalThis.fetch;
    const strict = function (this: unknown) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(jsonResponse(200, { ok: true }));
    };
    globalThis.fetch = strict as unknown as typeof fetch;
    try {
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any });
      await expect(t.request('/chats')).resolves.toEqual({ ok: true });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('returns undefined for 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
    await expect(t.request('/chats/c-1')).resolves.toBeUndefined();
  });

  describe('error mapping', () => {
    const cases: Array<[number, any, unknown]> = [
      [401, AuthError, { message: 'Invalid API key' }],
      [402, PaymentRequiredError, { message: 'Out of credits' }],
      [403, ForbiddenError, { message: 'API key is missing scope(s): chats:write' }],
      [404, NotFoundError, { message: 'Not found' }],
      [503, AgentUnreachableError, { message: 'Agent did not reconnect after restart' }],
      [500, BetterClawError, { message: 'boom' }],
    ];

    for (const [status, Ctor, body] of cases) {
      it(`maps ${status}`, async () => {
        // 401 retries once, so both attempts must fail.
        const fetchImpl = vi.fn(async () => jsonResponse(status, body));
        const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
        await expect(t.request('/chats')).rejects.toBeInstanceOf(Ctor);
      });
    }

    it('names the missing scopes on a 403', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(403, { message: 'API key is missing scope(s): chats:write, agents:read' }),
      );
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
      const err = (await t.request('/chats').catch((e) => e)) as ForbiddenError;
      expect(err.missingScopes).toEqual(['chats:write', 'agents:read']);
    });

    it('reads Retry-After on a 429', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(429, { message: 'slow down' }, { 'retry-after': '30' }));
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
      const err = (await t.request('/chats').catch((e) => e)) as RateLimitError;
      expect(err.retryAfter).toBe(30);
    });

    // Nest returns `message` as a string or an array of strings.
    it('flattens an array message', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(400, { message: ['a must be set', 'b must be a uuid'] }));
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
      await expect(t.request('/chats')).rejects.toThrow('a must be set, b must be a uuid');
    });

    it('survives a non-JSON error body', async () => {
      const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }));
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
      await expect(t.request('/chats')).rejects.toBeInstanceOf(AgentUnreachableError);
    });
  });

  /**
   * A session token can expire between being read from cache and reaching the
   * hub. Retrying EXACTLY once is the fix; a loop would turn a revoked key into
   * a hot spin against the consumer's token endpoint.
   */
  describe('401 handling', () => {
    it('refreshes and retries once', async () => {
      let calls = 0;
      const fetchImpl = vi.fn(async () =>
        ++calls === 1 ? jsonResponse(401, { message: 'expired' }) : jsonResponse(200, { ok: true }),
      );
      const a = auth();
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: a as any, fetch: fetchImpl as any });
      await expect(t.request('/chats')).resolves.toEqual({ ok: true });
      expect(a.invalidate).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not retry more than once', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(401, { message: 'revoked' }));
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
      await expect(t.request('/chats')).rejects.toBeInstanceOf(AuthError);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('multipart', () => {
    // The boundary is generated by the runtime; setting Content-Type by hand
    // produces a body the server cannot parse.
    it('never sets Content-Type for FormData', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
      const form = new FormData();
      form.set('content', 'hi');
      await t.request('/chats/c-1/messages', { method: 'POST', body: form });
      expect(requestAt(fetchImpl).init.headers['content-type']).toBeUndefined();
    });

    it('sets JSON Content-Type otherwise', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: fetchImpl as any });
      await t.request('/chats', { method: 'POST', body: { a: 1 } });
      expect(requestAt(fetchImpl).init.headers['content-type']).toBe('application/json');
    });
  });

  describe('queryToken', () => {
    it('returns the credential when one may appear in a URL', async () => {
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: auth() as any, fetch: vi.fn() as any });
      await expect(t.queryToken()).resolves.toBe('tok');
    });

    it('explains itself when the credential must stay in a header', async () => {
      const a = auth({ getQueryToken: vi.fn(async () => null) });
      const t = new HttpTransport({ baseUrl: 'http://api.test', auth: a as any, fetch: vi.fn() as any });
      await expect(t.queryToken()).rejects.toThrow(/must stay server-side/);
    });
  });
});
