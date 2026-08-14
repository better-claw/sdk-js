import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BetterClawClient, SessionTokenAuth, type SdkSessionToken } from '@better-claw/sdk';
import { BetterClawProvider } from '@better-claw/sdk/react';
import { Chat } from './Chat';
import '../../styles.css';

/**
 * The browser half.
 *
 * Note what is NOT here: the API key. `SessionTokenAuth` calls the demo's own
 * `/api/bc-token` route, which holds the key server-side and returns a
 * short-lived token. The SDK refreshes it on its own.
 */
async function fetchToken(): Promise<SdkSessionToken> {
  const res = await fetch('/api/bc-token', { method: 'POST' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not get a session token');
  return res.json();
}

function Boot() {
  const [client, setClient] = useState<BetterClawClient | null>(null);
  const [session, setSession] = useState<SdkSessionToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // One token fetch up front, only to learn which workspace the key is bound
    // to — the client needs it to scope the socket.
    fetchToken()
      .then((first) => {
        setSession(first);
        const auth = new SessionTokenAuth(fetchToken);
        setClient(
          new BetterClawClient({
            baseUrl: import.meta.env.VITE_BC_API_URL ?? '',
            auth,
            workspaceId: first.workspaceId,
          }),
        );
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error)
    return (
      <div className="app">
        <div className="banner">{error}</div>
      </div>
    );
  if (!client || !session)
    return (
      <div className="app">
        <p className="status">Connecting…</p>
      </div>
    );

  return (
    <BetterClawProvider client={client}>
      <Chat session={session} />
    </BetterClawProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
