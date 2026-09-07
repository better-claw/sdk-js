import { useState } from 'react';
import type { ChatMessage } from '@better-claw/sdk';
import { useBetterClaw } from '@better-claw/sdk/react';
import { saveFile } from '../../files';

export function Deliverables({ message }: { message: ChatMessage }) {
  const client = useBetterClaw();
  const [downloading, setDownloading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(index: number) {
    setDownloading(index);
    setError(null);
    try {
      const file = await client.chats.getDeliverable(message, index);
      saveFile(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download the file. Please try again.');
    } finally {
      setDownloading(null);
    }
  }

  if (!message.deliverable?.length) return null;
  return (
    <div className="deliverables">
      <ul aria-label="Generated files">
        {message.deliverable.map((file, index) => (
          <li key={index}>
            <button type="button" disabled={downloading !== null} onClick={() => download(index)}>
              {downloading === index ? 'Downloading' : 'Download'} {file.filename}
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
