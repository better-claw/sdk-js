import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  BetterClawClient,
  NotFoundError,
  RateLimitError,
  SessionTokenAuth,
  type ChatMessage,
  type SdkSessionToken,
} from '../src/index.js';

const message: ChatMessage = {
  id: 'message-1',
  chatId: 'chat-1',
  role: 'assistant',
  status: 'complete',
  content: 'Files are ready.',
  turnIndex: 1,
  deliverable: [
    { filename: 'project-plan.csv', mimeType: 'text/csv' },
    { filename: 'report.pdf', mimeType: 'application/pdf' },
  ],
};

function setup(fetchImpl: typeof fetch) {
  let tokenNumber = 0;
  const fetchToken = vi.fn(async (): Promise<SdkSessionToken> => ({
    token: `bcs_test_${++tokenNumber}`,
    expiresIn: 3600,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    workspaceId: 'workspace-1',
    userId: 'user-1',
    agentId: null,
    scopes: ['chats:read'],
  }));
  const client = new BetterClawClient({
    baseUrl: 'https://api.test/',
    workspaceId: 'workspace-1',
    auth: new SessionTokenAuth(fetchToken),
    fetch: fetchImpl,
  });
  return { client, fetchToken };
}

describe('client.chats.getDeliverable', () => {
  it('returns the first file with its name, MIME type, and readable text', async () => {
    const csv = 'Task,Owner,Status\nDesign,Zoë,Done\n';
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(csv, { headers: { 'content-type': 'text/csv' } }));
    const { client } = setup(fetchImpl);

    const file = await client.chats.getDeliverable(message);

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('project-plan.csv');
    expect(file.type).toBe('text/csv');
    expect(file.size).toBe(new TextEncoder().encode(csv).length);
    expect(await file.text()).toBe(csv);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/chats/chat-1/messages/message-1/deliverables/0?inline=true',
      expect.objectContaining({ headers: { authorization: 'Bearer bcs_test_1' } }),
    );
  });

  it('preserves binary bytes and uses the selected deliverable metadata when no content type is sent', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(bytes));
    const { client } = setup(fetchImpl);

    const file = await client.chats.getDeliverable(message, 1);

    expect(file.name).toBe('report.pdf');
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.test/chats/chat-1/messages/message-1/deliverables/1?inline=true',
    );
  });

  it('refreshes the client token once after a 401', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"message":"Expired token"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('CSV contents'));
    const { client, fetchToken } = setup(fetchImpl);

    expect(await (await client.chats.getDeliverable(message)).text()).toBe('CSV contents');
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { authorization: 'Bearer bcs_test_1' },
      { authorization: 'Bearer bcs_test_2' },
    ]);
  });

  it('stops retrying and throws AuthError when the refreshed token is rejected', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"message":"Revoked key"}', { status: 401 }));
    const { client } = setup(fetchImpl);

    await expect(client.chats.getDeliverable(message)).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('preserves the hub error instead of returning the error response as a file', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{"message":"Deliverable not found"}', { status: 404 }),
    );
    const { client } = setup(fetchImpl);

    await expect(client.chats.getDeliverable(message)).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Deliverable not found',
      status: 404,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps rate-limit details on file requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('{"message":"Slow down"}', {
          status: 429,
          headers: { 'retry-after': '5' },
        }),
    );
    const { client } = setup(fetchImpl);
    await expect(client.chats.getDeliverable(message)).rejects.toMatchObject({
      constructor: RateLimitError,
      retryAfter: 5,
    });
  });

  it.each([-1, 0.5, 2, NaN])('rejects an invalid index before making a request: %s', async (index) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client } = setup(fetchImpl);
    await expect(client.chats.getDeliverable(message, index)).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, null, []])('rejects a message without deliverables: %s', async (deliverable) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client } = setup(fetchImpl);
    await expect(client.chats.getDeliverable({ ...message, deliverable })).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes cancellation through to the file request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      init?.signal?.throwIfAborted();
      return new Response('');
    });
    const { client } = setup(fetchImpl);
    await expect(client.chats.getDeliverable(message, 0, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
