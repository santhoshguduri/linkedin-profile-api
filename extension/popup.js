/**
 * Reads the LinkedIn session out of the browser's own cookie store and hands it
 * to whichever tab the user points at.
 *
 * There is no network code in this file, and there is none anywhere else in the
 * extension. The cookie goes to the page the user explicitly chose and nowhere
 * else — that is the whole security story, and it is short on purpose.
 */

/** The page contract. The web app listens for exactly this message type. */
const MESSAGE_TYPE = 'linkedin-profile-api:session';

const $ = (id) => document.getElementById(id);

/**
 * `li_at` is HttpOnly, which is the entire reason this is an extension: the
 * cookies API can see it, `document.cookie` never can.
 */
async function readSession() {
  const url = 'https://www.linkedin.com';
  const [liAt, jsession] = await Promise.all([
    chrome.cookies.get({ url, name: 'li_at' }),
    chrome.cookies.get({ url, name: 'JSESSIONID' }),
  ]);
  if (!liAt?.value) return null;
  // JSESSIONID is stored quoted; the API accepts either form, so it is sent as-is.
  return { liAt: liAt.value, jsessionId: jsession?.value ?? null };
}

/** Runs in the target page. Kept tiny — it is serialised across the boundary. */
function deliver(type, session) {
  window.postMessage({ type, session }, window.location.origin);
}

async function sendToTab(session) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
    return { ok: false, message: 'Open the web app in this tab first.' };
  }

  // Ask for this one origin, only when the user presses the button. Standing
  // access to every site would be a much bigger ask than this feature needs.
  const origin = new URL(tab.url).origin + '/*';
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) return { ok: false, message: 'Permission declined.' };

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: deliver,
    args: [MESSAGE_TYPE, session],
  });
  return { ok: true, message: 'Sent. The app should be connected now.' };
}

async function main() {
  const status = $('status');
  const result = $('result');

  let session;
  try {
    session = await readSession();
  } catch {
    status.className = 'status status--missing';
    status.textContent = 'Could not read cookies.';
    return;
  }

  if (!session) {
    status.className = 'status status--missing';
    status.textContent = 'No LinkedIn session in this browser.';
    $('signin').hidden = false;
    return;
  }

  status.className = 'status status--found';
  status.textContent = 'Session found.';
  $('actions').hidden = false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) {
    $('target').textContent = `Target: ${new URL(tab.url).origin}`;
  } else {
    $('target').textContent = 'No web page in this tab — use Copy instead.';
    $('send').disabled = true;
  }

  $('send').addEventListener('click', async () => {
    $('send').disabled = true;
    const outcome = await sendToTab(session);
    result.textContent = outcome.message;
    if (!outcome.ok) $('send').disabled = false;
  });

  $('copy').addEventListener('click', async () => {
    // The `name=value` form so it can be pasted straight into the app's paste
    // box, or into a curl command as a Cookie header.
    const parts = [`li_at=${session.liAt}`];
    if (session.jsessionId) parts.push(`JSESSIONID=${session.jsessionId}`);
    await navigator.clipboard.writeText(parts.join('; '));
    result.textContent = 'Copied. Paste it into the app.';
  });
}

void main();
