# BetterClaw SDK — React demo

The React version of the shared chat and file-generation demo.

Follow the [shared setup](../README.md#run-with-a-live-api), then run from the
repository root:

```bash
pnpm --filter @better-claw/demo-react dev
```

Open http://localhost:5173. Select an agent, click **Generate a CSV**, then
**Download project-plan.csv** when the file appears in the reply.

[`Deliverables.tsx`](src/Deliverables.tsx) shows how to fetch a file using
`client.chats.getDeliverable(message, index)` and save it with the shared
[`saveFile`](../files.ts) helper.

See the [shared demo guide](../README.md) for authentication, downloads,
restoring chats, and browser tests, and the [React SDK guide](../../docs/react.md)
for embedding the SDK in your own app.
