import { useEffect, useState } from 'react';
import { NotFoundError, PaymentRequiredError, type SdkSessionToken } from '@better-claw/sdk';
import { useAgents, useBetterClaw, useChat } from '@better-claw/sdk/react';
import { FILE_DEMO_PROMPT } from '../../files';
import { Deliverables } from './Deliverables';

/**
 * The whole chat UI.
 *
 * Everything hard lives in the SDK: reconnects, cumulative-delta reduction,
 * replay after a drop, and resuming a turn that was already running when this
 * component mounted. What is left is rendering.
 */
export function Chat({ session }: { session: SdkSessionToken }) {
  const client = useBetterClaw();
  const { agents, error: agentsError } = useAgents(session.workspaceId);
  const [chatId, setChatId] = useState<string | null>(() => localStorage.getItem('bc-demo-chat'));
  const { messages, status, thinking, todos, loading, error: chatError, send, stop } = useChat(chatId);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const error = sendError ?? chatError;
  // Which agent a new chat goes to. A workspace usually has several, and they
  // are not interchangeable — an offline one simply never answers.
  const [agentId, setAgentId] = useState('');
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];

  // Remembering the id is what makes the reload test work: on refresh the SDK
  // rehydrates this chat and reattaches to any turn still running.
  useEffect(() => {
    if (chatId) localStorage.setItem('bc-demo-chat', chatId);
    else localStorage.removeItem('bc-demo-chat');
  }, [chatId]);

  useEffect(() => {
    if (chatId && error instanceof NotFoundError) {
      setChatId(null);
      setSendError(null);
      setNotice('The saved chat is no longer available. Your next message will start a new chat.');
    }
  }, [chatId, error]);

  const busy = submitting || status === 'sending' || status === 'waking' || status === 'streaming';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || loading || !agent) return;
    setDraft('');
    void sendText(text);
  }

  async function sendText(text: string) {
    if (busy || loading || !agent) return;
    setSubmitting(true);
    setSendError(null);
    setNotice(null);
    try {
      if (!chatId) {
        const { chat, conversation } = await client.startConversation({ agentId: agent.id, agentName: agent.name });
        setChatId(chat.id);
        // The hook's send is still bound to the previous chatId in this render.
        await conversation.send(text);
      } else {
        await send(text);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err : new Error('Could not send the message.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>BetterClaw — React demo</h1>
        <p>
          workspace {session.workspaceId.slice(0, 8)} · {agents.length} agent(s) · socket{' '}
          {client.connected ? 'live' : 'offline'}
        </p>
      </header>

      <section className="file-demo" aria-labelledby="file-demo-title">
        <h2 id="file-demo-title">Generate a file</h2>
        <p>Create a sample project plan with the agent, then download the CSV from its reply.</p>
        <button type="button" disabled={busy || loading || !agent} onClick={() => sendText(FILE_DEMO_PROMPT)}>
          Generate a CSV
        </button>
      </section>

      {notice && (
        <p className="status" role="status">
          {notice}
        </p>
      )}

      {/* Without this, a failure to load agents renders as an empty list and an
          inert composer, which looks like an empty workspace rather than a fault. */}
      {agentsError && <div className="banner">Could not load agents: {agentsError.message}</div>}

      {error && (
        <div className={`banner ${error instanceof PaymentRequiredError ? 'billing' : ''}`}>
          {error instanceof PaymentRequiredError ? `Billing: ${error.message}` : error.message}
        </div>
      )}

      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.role} ${m.status === 'error' ? 'error' : ''}`}>
          {m.content || (m.status === 'streaming' ? '…' : '')}
          {m.status === 'error' && m.errorMessage ? `\n${m.errorMessage}` : ''}
          <Deliverables message={m} />
        </div>
      ))}

      {thinking && <div className="thinking">{thinking}</div>}

      {!!todos?.length && (
        <ul className="todos">
          {todos.map((t, i) => (
            <li key={i}>
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} {t.title}
            </li>
          ))}
        </ul>
      )}

      {/* A cold agent can take minutes to start, so this must not look like an
          ordinary pause. */}
      {status === 'waking' && <p className="status waking">Waking the agent — a cold start can take a few minutes.</p>}
      {status === 'sending' && <p className="status">Sending…</p>}

      <form onSubmit={submit}>
        {/* Locked once the chat exists — a chat belongs to one agent. */}
        <select
          value={agent?.id ?? ''}
          disabled={busy || !!chatId || !agents.length}
          onChange={(e) => setAgentId(e.target.value)}
          aria-label="Agent"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {String(a.displayName ?? a.name)}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={draft}
          placeholder={agents.length ? 'Ask the agent…' : 'No agents in this workspace'}
          disabled={loading || !agents.length}
          onChange={(e) => setDraft(e.target.value)}
        />
        {busy ? (
          <button type="button" className="stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={loading || !draft.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
