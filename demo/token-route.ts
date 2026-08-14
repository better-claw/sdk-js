import type { Plugin } from 'vite';
import { mintSessionToken } from '@better-claw/sdk/server';

/**
 * The half of a demo that must live on a server.
 *
 * `BC_API_KEY` is read here and never reaches the browser: the page calls
 * `/api/bc-token`, this route exchanges the key for a short-lived session
 * token, and only that token is sent back. In a real app this is one route
 * handler in your own backend — a Next.js route, an Express handler, a Nitro
 * server route. It is a Vite middleware here purely so the demo is one process.
 *
 * Both demos import this so the React and Vue versions differ only in UI code.
 */
export function tokenRoute(): Plugin {
  return {
    name: 'betterclaw-token-route',
    configureServer(server) {
      server.middlewares.use('/api/bc-token', async (req, res) => {
        const apiKey = process.env.BC_API_KEY;
        const baseUrl = process.env.BC_API_URL ?? 'http://localhost:3001';

        res.setHeader('content-type', 'application/json');
        if (!apiKey) {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: 'Set BC_API_KEY (and optionally BC_API_URL) before starting the demo.' }));
          return;
        }

        try {
          res.end(JSON.stringify(await mintSessionToken(apiKey, { baseUrl })));
        } catch (err) {
          // Surface the hub's own status so a revoked key reads as 401 in the
          // browser rather than a generic failure.
          res.statusCode = (err as { status?: number }).status ?? 500;
          res.end(JSON.stringify({ message: (err as Error).message }));
        }
      });
    },
  };
}
