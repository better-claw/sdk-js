import type { ChatEvent } from '../protocol/index.js';
import { TERMINAL_CLOSE_CODES } from '../protocol/index.js';

/** Minimal shape shared by the browser WebSocket and the `ws` package. */
export interface WebSocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: any) => void): void;
  onopen?: ((ev: any) => void) | null;
  onmessage?: ((ev: any) => void) | null;
  onclose?: ((ev: any) => void) | null;
  onerror?: ((ev: any) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ChatEventStreamOptions {
  /** Resolved fresh on every connect, so a reconnect never reuses a dead token. */
  url: () => Promise<string>;
  onEvent: (event: ChatEvent) => void;
  onStatusChange?: (connected: boolean) => void;
  /** Terminal close — the credential is dead and retrying cannot help. */
  onAuthError?: (code: number, reason: string) => void;
  createWebSocket?: WebSocketFactory;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_BACKOFF_ATTEMPT = 6;

/**
 * The `/ws/chats` subscription: one socket per client, receive-only.
 *
 * One socket serves every chat in the workspace, which is what makes navigating
 * between conversations free — a socket per conversation would drop a turn
 * already in flight the moment the user navigated away.
 *
 * Backoff and the refocus/online listeners mirror the hub's own reference
 * client: a backgrounded tab has its timers throttled, so without an immediate
 * reconnect on visibility change a mid-turn stream can stay blank for many
 * seconds after the user comes back.
 */
export class ChatEventStream {
  private ws: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private intentionalClose = false;
  private listenersAdded = false;
  private readonly opts: ChatEventStreamOptions;
  /** Settled by the current attempt, so `connect()` means "open", not "dialed". */
  private settleAttempt: (() => void) | null = null;

  connected = false;

  constructor(opts: ChatEventStreamOptions) {
    this.opts = opts;
  }

  /**
   * Resolves once the socket is OPEN — awaiting a promise that resolved merely
   * because a socket object had been constructed leaves `connected` false right
   * after `await connect()`, which is a confusing thing to hand a caller.
   *
   * It also resolves if this attempt fails, rather than waiting for a
   * later retry: reconnection continues in the background either way, and a
   * promise that hangs while the hub is down would block `send()` from even
   * issuing its POST.
   */
  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.intentionalClose = false;
    this.addLifecycleListeners();

    const attemptSettled = new Promise<void>((resolve) => {
      this.settleAttempt = () => {
        this.settleAttempt = null;
        resolve();
      };
    });
    const settle = () => this.settleAttempt?.();

    let url: string;
    try {
      url = await this.opts.url();
    } catch {
      this.scheduleReconnect();
      settle();
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = (this.opts.createWebSocket ?? defaultFactory)(url);
    } catch {
      this.scheduleReconnect();
      settle();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.opts.onStatusChange?.(true);
      settle();
    };

    socket.onmessage = (event: { data: unknown }) => {
      try {
        this.opts.onEvent(JSON.parse(String(event.data)) as ChatEvent);
      } catch {
        /* a frame we cannot parse is not worth tearing the socket down for */
      }
    };

    socket.onerror = () => {
      /* onclose always follows; reconnect is decided there */
    };

    socket.onclose = (event: { code?: number; reason?: string }) => {
      this.connected = false;
      this.ws = null;
      this.opts.onStatusChange?.(false);

      const code = event?.code ?? 0;
      // Retrying a dead credential is a hot loop against the auth endpoint, and
      // it can never succeed. Stop and tell the caller instead.
      if (TERMINAL_CLOSE_CODES.has(code)) {
        this.intentionalClose = true;
        this.removeLifecycleListeners();
        this.opts.onAuthError?.(code, event?.reason ?? '');
        settle();
        return;
      }
      if (!this.intentionalClose) this.scheduleReconnect();
      // Unblocks a caller whose socket died before it ever opened; the retry
      // continues in the background.
      settle();
    };

    return attemptSettled;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalClose) return;
    this.attempt = Math.min(this.attempt + 1, MAX_BACKOFF_ATTEMPT);
    const backoff = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, backoff);
  }

  /** Skip the remaining backoff — the network or the tab just came back. */
  reconnectNow = (): void => {
    if (this.intentionalClose) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempt = 0;
    void this.connect();
  };

  private onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.reconnectNow();
  };

  private addLifecycleListeners(): void {
    if (typeof window === 'undefined' || this.listenersAdded) return;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('online', this.reconnectNow);
    window.addEventListener('focus', this.reconnectNow);
    this.listenersAdded = true;
  }

  private removeLifecycleListeners(): void {
    if (typeof window === 'undefined' || !this.listenersAdded) return;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('online', this.reconnectNow);
    window.removeEventListener('focus', this.reconnectNow);
    this.listenersAdded = false;
  }

  disconnect(): void {
    this.intentionalClose = true;
    // Release anyone awaiting an attempt that will now never open, rather than
    // leaving them hung on a socket we are about to discard.
    this.settleAttempt?.();
    this.removeLifecycleListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    this.connected = false;
  }
}

function defaultFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) {
    throw new Error(
      'No WebSocket implementation found. In Node, import the client from "@better-claw/sdk/server", ' +
        'which supplies one.',
    );
  }
  return new Ctor(url);
}
