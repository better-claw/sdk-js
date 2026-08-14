/**
 * Typed errors.
 *
 * The hub is NestJS, which returns `{ message: string | string[] }` — both
 * shapes occur, so both are normalized here rather than at each call site.
 */
export class BetterClawError extends Error {
  readonly status: number;
  readonly code: string;
  /** The parsed response body, when there was one. */
  readonly body: unknown;

  constructor(message: string, status: number, code: string, body?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class AuthError extends BetterClawError {
  constructor(message: string, body?: unknown) {
    super(message, 401, 'unauthorized', body);
  }
}

export class ForbiddenError extends BetterClawError {
  /** Scopes the key is missing, when the hub named them. */
  readonly missingScopes: string[];

  constructor(message: string, body?: unknown) {
    super(message, 403, 'forbidden', body);
    const match = /missing scope\(s\): (.+)$/.exec(message);
    this.missingScopes = match?.[1] ? match[1].split(',').map((s) => s.trim()) : [];
  }
}

/**
 * The workspace is out of credits, or the agent is locked by the Free-tier
 * rule. Thrown by `sendMessage` BEFORE the turn is created, so nothing is
 * pending when you see it — the fix is billing, not a retry.
 */
export class PaymentRequiredError extends BetterClawError {
  constructor(message: string, body?: unknown) {
    super(message, 402, 'payment_required', body);
  }
}

export class NotFoundError extends BetterClawError {
  constructor(message: string, body?: unknown) {
    super(message, 404, 'not_found', body);
  }
}

export class RateLimitError extends BetterClawError {
  /** Seconds to wait, from `Retry-After`. Requires the header to be CORS-exposed. */
  readonly retryAfter: number | null;

  constructor(message: string, retryAfter: number | null, body?: unknown) {
    super(message, 429, 'rate_limited', body);
    this.retryAfter = retryAfter;
  }
}

/**
 * The hub could not reach the agent — it failed to wake, or went down
 * mid-turn. Distinct from a transport error: the request succeeded, the agent
 * did not.
 */
export class AgentUnreachableError extends BetterClawError {
  constructor(message: string, body?: unknown) {
    super(message, 503, 'agent_unreachable', body);
  }
}

/** A turn that did not finish inside the deadline. See `waking` in the docs. */
export class TurnTimeoutError extends BetterClawError {
  constructor(message: string) {
    super(message, 408, 'turn_timeout');
  }
}

/** Nest returns `message` as a string or an array of strings. */
export function extractMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join(', ');
  }
  return fallback;
}

export function errorForStatus(status: number, body: unknown, retryAfter: number | null = null): BetterClawError {
  const message = extractMessage(body, `Request failed with status ${status}`);
  switch (status) {
    case 401:
      return new AuthError(message, body);
    case 402:
      return new PaymentRequiredError(message, body);
    case 403:
      return new ForbiddenError(message, body);
    case 404:
      return new NotFoundError(message, body);
    case 429:
      return new RateLimitError(message, retryAfter, body);
    case 502:
    case 503:
    case 504:
      return new AgentUnreachableError(message, body);
    default:
      return new BetterClawError(message, status, 'http_error', body);
  }
}
