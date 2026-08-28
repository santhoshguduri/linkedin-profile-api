/**
 * Receives a LinkedIn session from the companion browser extension.
 *
 * The extension cannot be detected by asking — it has no page-visible surface —
 * so the contract is one-way: it posts a message into this page when the user
 * presses "Send to this tab", and this module listens. Nothing happens until
 * they do, which is the point.
 */
import type { LinkedInSession } from './api';

/** Must match MESSAGE_TYPE in extension/popup.js. */
const MESSAGE_TYPE = 'linkedin-profile-api:session';

interface ExtensionMessage {
  type: typeof MESSAGE_TYPE;
  session: { liAt?: unknown; jsessionId?: unknown };
}

function isExtensionMessage(data: unknown): data is ExtensionMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === MESSAGE_TYPE &&
    typeof (data as { session?: unknown }).session === 'object'
  );
}

/**
 * Subscribes to sessions delivered by the extension. Returns an unsubscribe.
 *
 * The origin check is the security boundary: the extension injects into this
 * page and posts with `window.location.origin`, so anything arriving from an
 * embedded frame or another window is not ours and is dropped.
 */
export function onExtensionSession(handler: (session: LinkedInSession) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== window) return;
    if (!isExtensionMessage(event.data)) return;

    const { liAt, jsessionId } = event.data.session;
    if (typeof liAt !== 'string' || !liAt) return;

    handler({
      liAt,
      ...(typeof jsessionId === 'string' && jsessionId ? { jsessionId } : {}),
    });
  };

  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
