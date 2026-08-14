import { useEffect, useState } from 'react';
import { PaymentRequiredError, type SdkSessionToken } from '@better-claw/sdk';
import { useAgents, useBetterClaw, useChat } from '@better-claw/sdk/react';

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
  const { messages, status, thinking, todos, error, send, stop } = useChat(chatId);
  const [draft, setDraft] = useState('');
  // Which agent a new chat goes to. A workspace usually has several, and they
  // are not interchangeable — an offline one simply never answers.
  const [agentId, setAgentId] = useState('');
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];

  // Remembering the id is what makes the reload test work: on refresh the SDK
  // rehydrates this chat and reattaches to any turn still running.
  useEffect(() => {
    if (chatId) localStorage.setItem('bc-demo-chat', chatId);
  }, [chatId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');

    if (!chatId) {
      if (!agent) return;
      const { chat, conversation } = await client.startConversation({ agentId: agent.id, agentName: agent.name });
      setChatId(chat.id);
      // Send on the conversation just created, NOT the hook's `send`: that one
      // is bound to the chatId from this render, which is still null. The hook
      // picks the turn up from the shared store on the next render.
      await conversation.send(text);
      return;
    }
    await send(text);
  }

  const busy = status === 'sending' || status === 'waking' || status === 'streaming';

  return (
    <div className="app">
      <header>
        <h1>BetterClaw — React demo</h1>
        <p>
          workspace {session.workspaceId.slice(0, 8)} · {agents.length} agent(s) · socket{' '}
          {client.connected ? 'live' : 'offline'}
        </p>
      </header>

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
          disabled={!!chatId || !agents.length}
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
          disabled={!agents.length}
          onChange={(e) => setDraft(e.target.value)}
        />
        {busy ? (
          <button type="button" className="stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
