import type { Download, Page, WebSocketRoute } from '@playwright/test';

export const DEMO_URL = process.env.BC_DEMO_URL ?? 'http://localhost:5173';

/** Common browser setup; individual tests control chats and file responses. */
export async function mockDemoSession(
  page: Page,
  chat: { workspaceId: string; agentId: string; agentName: string },
): Promise<WebSocketRoute[]> {
  let tokenNumber = 0;
  const sockets: WebSocketRoute[] = [];
  await page.route('**/api/bc-token', (route) =>
    route.fulfill({
      json: {
        token: `bcs_demo_${++tokenNumber}`,
        expiresIn: 3600,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        workspaceId: chat.workspaceId,
        scopes: ['chats:read', 'chats:write', 'agents:read'],
      },
    }),
  );
  await page.route('**/workspaces/*/agents', (route) =>
    route.fulfill({ json: [{ id: chat.agentId, name: chat.agentName }] }),
  );
  await page.routeWebSocket('**/ws/chats?*', (socket) => {
    sockets.push(socket);
    socket.send(JSON.stringify({ type: 'connected' }));
  });
  return sockets;
}

export async function readDownloadText(download: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
