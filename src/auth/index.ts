import type { SdkSessionToken } from '../protocol/index.js';

/**
 * How a client proves who it is.
 *
 * Two credential shapes exist and they are not interchangeable:
 *   `bc_sk_…`  the durable key. A server-side secret. The hub refuses it
 *              outright if the request carries an Origin header.
 *   `bcs_…`    a short-lived session token exchanged from a key. Safe in a
 *              browser, and the only thing that may ride in the WS query string.
 */
export interface AuthProvider {
  /** Credential for the `Authorization: Bearer` header. */
  getHeaderToken(): Promise<string>;
  /**
   * Credential for `?token=` on the WebSocket upgrade, or null when this
   * provider must not appear in a URL.
   */
  getQueryToken(): Promise<string | null>;
  /** Called after a 401 so a cached token can be discarded. */
  invalidate(): void;
}

/** Fetches a fresh session token — typically a POST to the consumer's own backend. */
export type SessionTokenFetcher = () => Promise<SdkSessionToken> | SdkSessionToken;

/** Refresh this many ms before expiry, so a request never races the clock. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * The browser strategy. Holds no durable secret: it calls back to the
 * consumer's own endpoint, which is where the API key actually lives.
 *
 *   const client = new BetterClawClient({
 *     baseUrl, workspaceId,
 *     auth: new SessionTokenAuth(async () => (await fetch('/api/bc-token', { method: 'POST' })).json()),
 *   });
 */
export class SessionTokenAuth implements AuthProvider {
  private cached: SdkSessionToken | null = null;
  private inflight: Promise<SdkSessionToken> | null = null;

  constructor(private readonly fetcher: SessionTokenFetcher) {}

  private async token(): Promise<string> {
    if (this.cached && Date.parse(this.cached.expiresAt) - Date.now() > REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    // Collapse concurrent refreshes; a page that fires six requests at mount
    // should mint one token, not six.
    this.inflight ??= Promise.resolve(this.fetcher())
      .then((t) => {
        this.cached = t;
        return t;
      })
      .finally(() => {
        this.inflight = null;
      });
    return (await this.inflight).token;
  }

  getHeaderToken(): Promise<string> {
    return this.token();
  }

  getQueryToken(): Promise<string | null> {
    return this.token();
  }

  invalidate(): void {
    this.cached = null;
  }

  /** The session's own claims, once a token has been fetched. */
  get session(): SdkSessionToken | null {
    return this.cached;
  }
}

/**
 * Anything else — a token you fetch and refresh yourself — implements
 * `AuthProvider` directly; it is three small methods and there is no base class
 * worth adding until a second real case turns up.
 */
