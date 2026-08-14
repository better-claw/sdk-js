import type { AuthProvider } from './index.js';

/**
 * The durable `bc_sk_` key, sent straight on every request.
 *
 * Server-side only, and enforced in three independent places so the rule cannot
 * be missed:
 *   1. Here — the constructor throws if a browser global is present.
 *   2. This module is only reachable via the `/server` entry point, so it does
 *      not appear in a browser bundle at all.
 *   3. The hub refuses any raw key whose request carries an Origin header.
 *
 * `getQueryToken` returns null because a raw key must never appear in a URL:
 * query strings reach access logs, proxy logs and Referer headers. The Node
 * WebSocket client sends it as an upgrade header instead.
 */
export class ApiKeyAuth implements AuthProvider {
  constructor(private readonly apiKey: string) {
    if (typeof globalThis !== 'undefined' && 'window' in globalThis && 'document' in globalThis) {
      throw new Error(
        'ApiKeyAuth cannot be used in a browser: an API key is a server-side secret. ' +
          'Exchange it for a session token on your backend and use SessionTokenAuth in the browser.',
      );
    }
    if (!apiKey) throw new Error('An API key is required');
  }

  async getHeaderToken(): Promise<string> {
    return this.apiKey;
  }

  async getQueryToken(): Promise<string | null> {
    return null;
  }

  invalidate(): void {
    /* a durable key is not refreshable — a 401 means it is revoked */
  }
}
