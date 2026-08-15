import { test, expect, type Page } from '@playwright/test';

/**
 * Browser e2e against a REAL stack — hub API, a live agent, and one of the
 * demos. Not part of CI: it needs a running hub and an agent that answers, so
 * `pnpm test:e2e` runs it on demand. See the root README.
 *
 * Everything here is a behaviour that unit tests structurally cannot reach:
 * the `fetch` receiver bug was browser-only, and the cumulative-delta and
 * resume paths only matter against a real socket.
 *
 *   BC_DEMO_URL   demo origin      (default http://localhost:5173)
 *   BC_E2E_AGENT  agent to talk to (default "Content Writer")
 */
const DEMO_URL = process.env.BC_DEMO_URL ?? 'http://localhost:5173';
const AGENT = process.env.BC_E2E_AGENT ?? 'Content Writer';

/** Agents can be cold — a stopped machine takes minutes to answer. */
const REPLY_TIMEOUT = 300_000;

async function openFreshChat(page: Page) {
  await page.goto(DEMO_URL, { waitUntil: 'networkidle' });
  // Cleared here rather than in an init script: that re-runs on every
  // navigation and would wipe the chat id the reload test depends on.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('select:not([disabled])');
  await page.selectOption('select', { label: AGENT });
}

const lastReply = (page: Page) => page.$$eval('.msg.assistant', (n) => n[n.length - 1]?.textContent?.trim() ?? '');

async function waitForReply(page: Page, minChars = 3) {
  await page.waitForFunction(
    (min) => {
      const el = [...document.querySelectorAll('.msg.assistant')].pop();
      const text = el?.textContent?.trim() ?? '';
      return text.length > min && text !== '…';
    },
    minChars,
    { timeout: REPLY_TIMEOUT, polling: 400 },
  );
}

test.describe('BetterClaw SDK demo', () => {
  test.describe.configure({ mode: 'serial', timeout: REPLY_TIMEOUT + 60_000 });

  test('connects, lists agents, and streams a reply', async ({ page }) => {
    await openFreshChat(page);
    await expect(page.locator('header p')).toContainText('socket live');

    await page.fill('input[type=text]', 'Reply with exactly: browser works. Nothing else.');
    await page.click('button[type=submit]');
    await waitForReply(page);

    expect(await lastReply(page)).toContain('browser works');
    // A visible banner means auth, billing or agent loading failed.
    expect(await page.$$eval('.banner', (n) => n.map((e) => e.textContent))).toHaveLength(0);
  });

  /**
   * The custody rule the whole auth design exists to enforce: the durable key
   * lives on the demo's server, and the browser only ever sees a session token.
   */
  test('never exposes the API key to the browser', async ({ page }) => {
    await openFreshChat(page);
    const leaked = await page.evaluate(() =>
      /bc_sk_/.test(document.documentElement.outerHTML + JSON.stringify(Object.entries(localStorage))),
    );
    expect(leaked).toBe(false);
  });

  /**
   * After a reload nothing is awaited across the boundary, so resumption runs
   * off the persisted `streaming` row. The no-duplication assertion is the real
   * point: streamed content is cumulative, and the gateway replays its last
   * frame on reconnect, so a reducer that appends doubles the reply here.
   */
  test('resumes a turn across a hard reload without duplicating text', async ({ page }) => {
    await openFreshChat(page);
    await page.fill('input[type=text]', 'Write about 400 words on why caching is hard. Plain prose, no preamble.');
    await page.click('button[type=submit]');

    await waitForReply(page, 120);
    const before = (await lastReply(page)).length;

    await page.reload({ waitUntil: 'networkidle' });
    await waitForReply(page, before);

    const text = await lastReply(page);
    expect(text.length).toBeGreaterThan(before);
    expect(text.indexOf(text.slice(0, 100), 1)).toBe(-1);
    await expect(page.locator('.msg')).toHaveCount(2);
  });
});
