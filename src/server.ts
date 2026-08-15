/**
 * Node-only entry point.
 *
 * Everything here either holds the durable API key or needs a Node WebSocket,
 * so it is kept out of `.` — that separation is what makes `ApiKeyAuth`
 * structurally unreachable from a browser bundle rather than merely discouraged.
 */
import { BetterClawClient, type BetterClawClientOptions } from './client.js';
import { ApiKeyAuth } from './auth/api-key-auth.js';
import { errorForStatus } from './http/errors.js';
import type { SdkScope, SdkSessionToken } from './protocol/index.js';
import type { WebSocketLike } from './ws/chat-event-stream.js';

export { ApiKeyAuth } from './auth/api-key-auth.js';

export interface MintSessionTokenOptions {
  baseUrl: string;
  /** Seconds. Hub default 600, ceiling 900. */
  ttlSeconds?: number;
  /** Narrow the token below the key's own scopes. Cannot widen. */
  scopes?: SdkScope[];
  fetch?: typeof fetch;
}

/**
 * Exchange an API key for a short-lived session token.
 *
 * This is the whole point of the `/server` entry: the key stays on your
 * backend, and only the result of this call reaches a browser. Mount it as one
 * route in your own app:
 *
 *   // app/api/bc-token/route.ts
 *   import { mintSessionToken } from '@better-claw/sdk/server';
 *   export const POST = async () =>
 *     Response.json(await mintSessionToken(process.env.BC_API_KEY!, { baseUrl: process.env.BC_API_URL! }));
 *
 * The hub signs the token; this function never holds signing material.
 */
export async function mintSessionToken(apiKey: string, opts: MintSessionTokenOptions): Promise<SdkSessionToken> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const res = await fetchImpl(`${opts.baseUrl.replace(/\/+$/, '')}/auth/sdk-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttlSeconds: opts.ttlSeconds, scopes: opts.scopes }),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) throw errorForStatus(res.status, body);
  return body as SdkSessionToken;
}

/** Constructor shape of the `ws` package's WebSocket. */
export type NodeWebSocketCtor = new (url: string, opts: { headers: Record<string, string> }) => unknown;

export interface ServerClientOptions extends Omit<BetterClawClientOptions, 'auth' | 'createWebSocket'> {
  apiKey: string;
  /**
   * The `ws` package's WebSocket, required ONLY if you subscribe to the stream:
   *
   *   import { WebSocket } from 'ws';
   *   createServerClient({ ..., webSocket: WebSocket })
   *
   * Passed in rather than imported so REST-only consumers need no `ws`
   * dependency at all. Node's built-in global WebSocket is not usable here: it
   * cannot set upgrade headers, and the header is the only way a raw key may
   * travel.
   */
  webSocket?: NodeWebSocketCtor;
}

/**
 * A headless client that sends the raw key directly.
 *
 * The key rides the `Authorization` header on REST *and* on the WebSocket
 * upgrade — never the query string, which would put it in access logs. Node's
 * `ws` can set upgrade headers and browsers cannot, so the transport itself is
 * what enforces "the durable key stays server-side".
 */
export function createServerClient(opts: ServerClientOptions): BetterClawClient {
  const auth = new ApiKeyAuth(opts.apiKey);

  return new BetterClawClient({
    ...opts,
    auth,
    createWebSocket: (url) => {
      if (!opts.webSocket) {
        throw new Error(
          'Streaming from Node needs the `ws` package: `import { WebSocket } from "ws"` and pass it as ' +
            "`webSocket` to createServerClient. Node's global WebSocket cannot send the Authorization " +
            'header an API key requires.',
        );
      }
      // ApiKeyAuth.getQueryToken() returns null, so the URL the client built
      // carries no credential — strip the empty param and authenticate by header.
      const bare = new URL(url);
      bare.searchParams.delete('token');
      return new opts.webSocket(bare.toString(), {
        headers: { authorization: `Bearer ${opts.apiKey}` },
      }) as unknown as WebSocketLike;
    },
  });
}
