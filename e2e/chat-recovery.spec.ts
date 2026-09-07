import { test, expect } from '@playwright/test';
import { DEMO_URL, mockDemoSession } from './helpers';

for (const failure of ['restore', 'send', 'server'] as const) {
  test(`recovers from a ${failure} failure without getting stuck sending`, async ({ page }) => {
    const chat = {
      id: 'saved-chat',
      userId: 'demo-user',
      workspaceId: 'demo-workspace',
      agentId: 'demo-agent',
      agentName: 'Demo agent',
      title: null,
      messages: [],
    };
    const sockets = await mockDemoSession(page, chat);
    let savedChatLoads = 0;
    let savedChatSends = 0;
    let createdChats = 0;

    await page.route('**/chats/saved-chat', (route) => {
      savedChatLoads++;
      return route.fulfill(
        failure === 'restore' ? { status: 404, json: { message: 'Chat not found' } } : { json: chat },
      );
    });
    await page.route('**/chats', (route) => {
      createdChats++;
      return route.fulfill({ json: { ...chat, id: 'new-chat' } });
    });
    await page.route('**/chats/new-chat', (route) => route.fulfill({ json: { ...chat, id: 'new-chat' } }));
    await page.route('**/chats/*/messages', async (route) => {
      const chatId = new URL(route.request().url()).pathname.split('/')[2];
      if (chatId === 'saved-chat' && savedChatSends++ === 0) {
        await route.fulfill({
          status: failure === 'server' ? 500 : 404,
          json: {
            message: failure === 'server' ? 'Please try again' : 'Chat not found',
          },
        });
        return;
      }
      const userMessage = {
        id: 'request',
        chatId,
        role: 'user',
        status: 'complete',
        content: route.request().postDataJSON().content,
        turnIndex: 0,
      };
      const assistantMessage = {
        id: 'reply',
        chatId,
        role: 'assistant',
        status: 'complete',
        content: 'Your CSV is ready.',
        turnIndex: 1,
      };
      await route.fulfill({ json: { userMessage, assistantMessage } });
      for (const socket of sockets) {
        socket.send(JSON.stringify({ type: 'message_upserted', chatId, message: assistantMessage }));
      }
    });

    await page.goto(DEMO_URL);
    await expect(page.getByRole('button', { name: 'Generate a CSV', exact: true })).toBeEnabled();
    // Seed only this test's isolated browser context with a stale saved chat.
    await page.evaluate(() => localStorage.setItem('bc-demo-chat', 'saved-chat'));
    await page.reload();
    const generate = page.getByRole('button', { name: 'Generate a CSV', exact: true });

    if (failure !== 'restore') {
      await expect(page.getByRole('combobox', { name: 'Agent' })).toBeDisabled();
      await generate.click();
    }
    if (failure === 'server') {
      await expect(page.locator('.banner')).toHaveText('Please try again');
    } else {
      await expect(page.getByRole('status')).toContainText('saved chat is no longer available', { timeout: 5000 });
      await expect(page.getByRole('combobox', { name: 'Agent' })).toBeEnabled();
      await expect(page.locator('.banner')).toHaveCount(0);
      const previousLoads = savedChatLoads;
      await page.reload();
      await expect(generate).toBeEnabled();
      expect(savedChatLoads).toBe(previousLoads);
    }

    await expect(generate).toBeEnabled();
    await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0);
    await generate.click();
    await expect(page.locator('.msg.assistant')).toHaveText('Your CSV is ready.');
    await expect(generate).toBeEnabled();
    expect(createdChats).toBe(failure === 'server' ? 0 : 1);
  });
}
