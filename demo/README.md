# BetterClaw SDK demos

The [React](react) and [Vue](vue) demos implement the same chat UI: streaming
replies, thinking text, todos, stop, generated file downloads, and error handling.
Their framework components can be read side by side; token exchange and saving
files are shared.

## Run with a live API

Use Node 20+ and pnpm. From the repository root:

```bash
pnpm install
pnpm build

export BC_API_KEY="bc_sk_YOUR_KEY"
export BC_API_URL="http://localhost:3001"
export VITE_BC_API_URL="$BC_API_URL"
```

Replace `BC_API_URL` with your live hub's origin if it is hosted elsewhere. The
key needs `agents:read`, `chats:read`, and `chats:write` for the selected workspace.
Export the variables in the terminal that starts the demo; the demo does not
load a root `.env` file.

Choose a framework:

| Demo  | Command                                     | Open                  |
| ----- | ------------------------------------------- | --------------------- |
| React | `pnpm --filter @better-claw/demo-react dev` | http://localhost:5173 |
| Vue   | `pnpm --filter @better-claw/demo-vue dev`   | http://localhost:5174 |

Use the `dev` command: the token route is Vite development middleware and is not
included in static build output or `vite preview`.

## Generate and download a file

1. Select an agent that supports file output and click **Generate a CSV**.
2. Wait for `project-plan.csv` to appear in the reply.
3. Click **Download project-plan.csv** to save the file.

You can also request other files in the composer. Each returned deliverable
gets a download button. Text pasted into a reply is not a file deliverable.
Downloads show progress, surface API errors, and can be retried.

The chat is restored after reload, including its file downloads. If its saved
ID is no longer available to the API, the demo clears it and your next message
starts a new chat. A rejected message request releases the sending state.

## Embed file handling in your app

Both demos use the public SDK method:

```ts
const file = await client.chats.getDeliverable(message, 0);
const text = await file.text(); // CSV, JSON, Markdown, or other text
// For binary content: const bytes = await file.arrayBuffer();
```

The returned `File` includes its name, MIME type, and size. The SDK handles
authentication, token refresh, and typed errors. The demos only add
[`saveFile`](files.ts), a small DOM helper for saving the file in the browser.

See the [React integration example](../docs/react.md#rendering-deliverables),
[API reference](../docs/api-reference.md#chatsresource), and the download
components in [React](react/src/Deliverables.tsx) and [Vue](vue/src/Deliverables.vue).
The hub's inline file route supports files up to 50 MB.

## Token exchange

[`token-route.ts`](token-route.ts) reads `BC_API_KEY` on the development server
and exchanges it for a short-lived session token. The browser calls
`/api/bc-token` and uses only that session token. `VITE_BC_API_URL` is the public
hub URL; the API key stays in `BC_API_KEY`.

In an embedded app, put the token exchange in your own authenticated backend
route. See [Authentication](../docs/authentication.md).

## Other flows to try

- **Cold start:** send a message after the agent has gone idle. The `waking`
  state explains the wait while the agent starts.
- **Resume:** reload during a long response or toggle offline mid-stream.
  The SDK restores the turn and avoids duplicating cumulative text.

See [Testing](../docs/testing.md#end-to-end) for the mocked browser suite and
the separate live-agent tests.
