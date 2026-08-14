import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLOSE_CODES, SDK_SCOPES } from '../src/protocol/index.js';

/**
 * Drift guard.
 *
 * `@openclaw/shared` is `private: true`, so the hub's protocol types cannot be
 * imported and are mirrored in `src/protocol/` by hand. Hand-mirrored types
 * rot silently: the SDK keeps compiling, and the failure shows up as a field
 * that is quietly always undefined at runtime.
 *
 * Opt-in rather than always-on, because it needs a checkout of the hub:
 *
 *   BETTERCLAW_REPO=/path/to/betterclaw pnpm test
 *
 * CI runs without it and skips. Run it before releasing.
 */
const repo = process.env.BETTERCLAW_REPO;
const gateway = repo ? join(repo, 'apps/api/src/chats/chat-events.gateway.ts') : null;
const sharedAuth = repo ? join(repo, 'packages/shared/src/sdk-auth.ts') : null;
const available = !!(gateway && sharedAuth && existsSync(gateway) && existsSync(sharedAuth));

describe.skipIf(!available)('protocol parity with the hub', () => {
  it('covers every ChatEvent variant the gateway can emit', () => {
    const source = readFileSync(gateway!, 'utf8');
    const union = source.slice(source.indexOf('export type ChatEvent'), source.indexOf('const HEARTBEAT_MS'));
    const variants = [...union.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();

    const mirrored = ['chat_deleted', 'chat_upserted', 'connected', 'message_streaming', 'message_upserted'];
    expect([...new Set(variants)]).toEqual(mirrored);
  });

  it('matches the hub on close codes', () => {
    const source = readFileSync(sharedAuth!, 'utf8');
    const block = source.slice(source.indexOf('export const SDK_CLOSE_CODES'));
    for (const [name, value] of Object.entries(CLOSE_CODES)) {
      expect(block).toContain(`${name}: ${value}`);
    }
  });

  it('matches the hub on the scope vocabulary', () => {
    const source = readFileSync(sharedAuth!, 'utf8');
    const line = /export const SDK_SCOPES = \[(.*?)\]/s.exec(source)?.[1] ?? '';
    const hubScopes = [...line.matchAll(/'([a-z:]+)'/g)].map((m) => m[1]);
    expect(hubScopes).toEqual([...SDK_SCOPES]);
  });

  it('still carries the transient fields the reducer depends on', () => {
    const source = readFileSync(gateway!, 'utf8');
    for (const field of ['thinking?', 'todos?', 'subagents?']) {
      expect(source).toContain(field);
    }
  });
});

describe('protocol parity harness', () => {
  it('reports whether it ran', () => {
    if (!available) {
      console.info('protocol parity skipped — set BETTERCLAW_REPO to a betterclaw checkout to run it');
    }
    expect(true).toBe(true);
  });
});
