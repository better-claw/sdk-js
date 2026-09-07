# BetterClaw SDK — Vue demo

The Vue version of the shared chat and file-generation demo.

Follow the [shared setup](../README.md#run-with-a-live-api), then run from the
repository root:

```bash
pnpm --filter @better-claw/demo-vue dev
```

Open http://localhost:5174. Select an agent, click **Generate a CSV**, then
**Download project-plan.csv** when the file appears in the reply.

[`Deliverables.vue`](src/Deliverables.vue) shows how to fetch a file using
`client.chats.getDeliverable(message, index)` and save it with the shared
[`saveFile`](../files.ts) helper.

See the [shared demo guide](../README.md) for authentication, downloads,
restoring chats, and browser tests, and the [Vue SDK guide](../../docs/vue.md)
for embedding the SDK in your own app.
