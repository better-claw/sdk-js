import { test, expect } from '@playwright/test';
import type { ChatMessage } from '../src/protocol/index.js';
import { DEMO_URL, mockDemoSession, readDownloadText } from './helpers';

/** Run against either demo with BC_DEMO_URL; all hub traffic is mocked. */
const CSV =
  'Task,Owner,Status\nDesign,Ada,Done\nBuild,Sam,In progress\nTest,Jo,Pending\nReview,Lee,Pending\nShip,Max,Pending\n';

test('generates a file, retries failed downloads with fresh auth, and downloads after reload', async ({ page }) => {
  const chat = {
    id: 'file-demo-chat',
    userId: 'demo-user',
    workspaceId: 'demo-workspace',
    agentId: 'demo-agent',
    agentName: 'Demo agent',
    title: null,
  };
  let messages: ChatMessage[] = [];
  let sentContent = '';
  const sockets = await mockDemoSession(page, chat);
  const downloadTokens: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/chats', (route) => route.fulfill({ json: chat }));
  await page.route(`**/chats/${chat.id}`, (route) => route.fulfill({ json: { ...chat, messages } }));
  await page.route(`**/chats/${chat.id}/messages`, async (route) => {
    sentContent = route.request().postDataJSON().content;
    const userMessage: ChatMessage = {
      id: 'file-request',
      chatId: chat.id,
      role: 'user',
      status: 'complete',
      content: sentContent,
      turnIndex: 0,
    };
    const assistantMessage: ChatMessage = {
      id: 'file-reply',
      chatId: chat.id,
      role: 'assistant',
      status: 'streaming',
      content: '',
      turnIndex: 1,
    };
    messages = [userMessage, assistantMessage];
    await route.fulfill({ json: { userMessage, assistantMessage } });
    for (const socket of sockets) {
      for (const message of messages) {
        socket.send(JSON.stringify({ type: 'message_upserted', chatId: chat.id, message }));
      }
    }
  });
  await page.route(`**/chats/${chat.id}/messages/file-reply/deliverables/0?*`, (route) => {
    const url = new URL(route.request().url());
    expect([...url.searchParams.entries()]).toEqual([['inline', 'true']]);
    downloadTokens.push(route.request().headers().authorization!);
    // First click fails visibly. The second click expires once, then succeeds.
    const status = downloadTokens.length === 1 ? 404 : downloadTokens.length === 2 ? 401 : 200;
    return route.fulfill({ status, contentType: 'text/csv', body: status === 200 ? CSV : 'Download failed' });
  });

  await page.goto(DEMO_URL);
  const generate = page.getByRole('button', { name: 'Generate a CSV', exact: true });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(generate).toBeDisabled();
  await expect.poll(() => sentContent).toContain('project-plan.csv');
  expect(sentContent).toContain('file deliverable');
  await expect(page.locator('.msg.assistant')).toBeVisible();

  const reply: ChatMessage = {
    ...messages[1]!,
    status: 'complete',
    content: 'Your project plan is ready.',
    deliverable: [{ filename: 'project-plan.csv', mimeType: 'text/csv', bytes: Buffer.byteLength(CSV) }],
  };
  messages = [messages[0]!, reply];
  for (const socket of sockets) {
    socket.send(JSON.stringify({ type: 'message_upserted', chatId: chat.id, message: reply }));
  }

  const downloadButton = page.getByRole('button', { name: 'Download project-plan.csv', exact: true });
  await expect(downloadButton).toBeVisible();
  await expect(generate).toBeEnabled();
  await downloadButton.click();
  await expect(page.getByRole('alert')).toContainText('Request failed with status 404');
  await expect(downloadButton).toBeEnabled();

  async function saveAndCheck() {
    const event = page.waitForEvent('download');
    await downloadButton.click();
    const download = await event;
    expect(download.suggestedFilename()).toBe('project-plan.csv');
    expect(await readDownloadText(download)).toBe(CSV);
    expect(await download.failure()).toBeNull();
  }

  await saveAndCheck();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(downloadTokens).toHaveLength(3);
  expect(downloadTokens[0]).toBe(downloadTokens[1]);
  expect(downloadTokens[2]).not.toBe(downloadTokens[1]);
  expect(downloadTokens.every((token) => token.startsWith('Bearer bcs_demo_'))).toBe(true);

  await page.reload();
  await expect(downloadButton).toBeVisible();
  await saveAndCheck();
  expect(pageErrors).toEqual([]);
});
