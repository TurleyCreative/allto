// "Ask about this site": a Copilot Studio agent in Ultrahand, told what Ultrahand knows.
//
// The agent is reached through Bot Framework Web Chat over Direct Line. A token comes from the allto
// token Worker (workers/agent-token), so the agent's secret never reaches the browser. When the chat
// connects, Ultrahand gives the agent the site two ways, so it works with any Copilot Studio agent:
//  - a message starting "[Ultrahand site context]" with the site as JSON. It is hidden from the chat,
//    and so is the agent's short reply to it. Agents without topics (the newer Copilot Studio view)
//    read it as part of the conversation; their instructions say what it is (docs/agent).
//  - an event named "allto.siteContext", for agents with a topic that stores it in a variable.
// When the site changes, it is sent again just before the user's next question.
//
// Without an agent yet, the panel still shows exactly what would be sent, to copy or download.

const WEBCHAT_URL = (import.meta.env.VITE_WEBCHAT_URL as string) || 'https://cdn.jsdelivr.net/npm/botframework-webchat@4.19.1/dist/webchat.js';
const BUILT_TOKEN_URL = (import.meta.env.VITE_AGENT_TOKEN_URL as string) || '';
const KEY = 'ultrahand:agentTokenUrl';

export interface AgentDeps {
  context(): object | null; // the site, as structured data
  summary(): string; // the same, as readable text
  place(): string;
}

const PROMPTS = [
  'Summarise the planning constraints on this site',
  'How sensitive is the heritage setting?',
  'What has been approved nearby in the last five years?',
  'Draft a site and context paragraph for a design and access statement',
];

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function tokenUrl(): string {
  try {
    return localStorage.getItem(KEY) || BUILT_TOKEN_URL;
  } catch {
    return BUILT_TOKEN_URL;
  }
}

let scriptP: Promise<void> | null = null;
function loadWebChat(): Promise<void> {
  if ((window as any).WebChat) return Promise.resolve();
  scriptP ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = WEBCHAT_URL;
    s.crossOrigin = 'anonymous';
    s.onload = () => res();
    s.onerror = () => ((scriptP = null), rej(new Error('Could not load the chat (Web Chat script).')));
    document.head.appendChild(s);
  });
  return scriptP;
}

export function initAgentPanel(deps: AgentDeps) {
  const drawer = document.getElementById('agentDrawer')!;
  let store: any = null;
  let directLine: any = null;
  let connected = false;
  let started = false; // a chat is connecting or open: never redraw the panel over it
  let lastSent = '';
  const hidden = new Set<string>(); // ids of the context messages, to hide them and the replies to them

  /** Send the site, unless the agent already has this version. Hidden from the chat. */
  const sendContext = () => {
    if (!directLine || !connected) return;
    const ctx = deps.context();
    const body = JSON.stringify(ctx);
    if (!ctx || body === lastSent) return;
    lastSent = body;
    directLine
      .postActivity({
        type: 'message',
        from: { id: userId, role: 'user' },
        text: `[Ultrahand site context] The site the user is looking at in Ultrahand, as JSON. Not a question: reply only "OK".\n\n${body}`,
        channelData: { allto: 'site-context' },
      })
      .subscribe({ next: (id: string) => hidden.add(id), error: () => {} });
    store?.dispatch({ type: 'WEB_CHAT/SEND_EVENT', payload: { name: 'allto.siteContext', value: ctx } });
  };
  let userId = 'dl_ultrahand';

  function render() {
    const url = tokenUrl();
    const ctx = deps.context();
    drawer.innerHTML = `
      <div class="ag-head"><b>Ask about this site</b><button class="ag-x" data-a="close" aria-label="Close">×</button></div>
      <p class="ag-status" id="agStatus"></p>
      ${
        url
          ? `<div id="agChat" class="ag-chat"></div>
             <div class="ag-prompts">${PROMPTS.map((p) => `<button data-prompt="${esc(p)}">${esc(p)}</button>`).join('')}</div>`
          : `<div class="ag-setup">
               <p><b>The site agent isn't connected yet.</b> Once the Copilot Studio agent and its token service are set up, it answers here with this site already in hand.</p>
               <p class="muted">Until then, copy the site summary below into any assistant.</p>
               <label class="ag-field">Agent token address<input id="agUrl" type="url" placeholder="https://allto-agent-token.….workers.dev/token"></label>
               <button class="ghost" data-a="save">Connect</button>
             </div>`
      }
      <details class="ag-ctx"${url ? '' : ' open'}>
        <summary>What the agent is told about this site</summary>
        ${ctx ? `<pre>${esc(deps.summary())}</pre>` : '<p class="muted">Analyse the site first: the agent works from the analysis.</p>'}
        <div class="row">
          <button class="ghost" data-a="copy" ${ctx ? '' : 'disabled'}>Copy summary</button>
          <button class="ghost" data-a="json" ${ctx ? '' : 'disabled'}>Download as JSON</button>
          ${url ? '<button class="ghost" data-a="resend" ' + (ctx ? '' : 'disabled') + '>Send again</button>' : ''}
        </div>
        ${url ? `<p class="muted fine">Token service: ${esc(url)} · <button class="link" data-a="forget">change</button></p>` : ''}
      </details>`;

    drawer.querySelector('[data-a=close]')!.addEventListener('click', close);
    drawer.querySelector('[data-a=copy]')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(deps.summary());
      status('Site summary copied.');
    });
    drawer.querySelector('[data-a=json]')?.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(deps.context(), null, 2)], { type: 'application/json' }));
      a.download = `${(deps.place() || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-site-context.json`;
      a.click();
    });
    drawer.querySelector('[data-a=save]')?.addEventListener('click', () => {
      const v = (drawer.querySelector('#agUrl') as HTMLInputElement).value.trim();
      if (!/^https:\/\//.test(v)) return status('Enter the https address of the token service.');
      try { localStorage.setItem(KEY, v); } catch { /* storage blocked */ }
      render();
      connect();
    });
    drawer.querySelector('[data-a=forget]')?.addEventListener('click', () => {
      try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
      connected = false;
      started = false;
      store = null;
      render();
    });
    drawer.querySelector('[data-a=resend]')?.addEventListener('click', () => ((lastSent = ''), sendContext(), status('Site sent to the agent.')));
    drawer.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!store || !connected) return status('Still connecting…');
        sendContext();
        store.dispatch({ type: 'WEB_CHAT/SEND_MESSAGE', payload: { text: b.dataset.prompt } });
      }),
    );
  }

  function status(msg: string) {
    const el = document.getElementById('agStatus');
    if (el) el.textContent = msg;
  }

  async function connect() {
    const url = tokenUrl();
    const host = document.getElementById('agChat');
    if (!url || !host) return;
    started = true;
    status('Connecting to the site agent…');
    try {
      const r = await fetch(url, { method: 'POST' });
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.token) throw new Error(t.error || `The token service answered ${r.status}.`);
      await loadWebChat();
      const WC = (window as any).WebChat;
      userId = t.userId || userId;
      store = WC.createStore({}, ({ dispatch }: any) => (next: any) => (action: any) => {
        // A question while the site has changed: the agent gets the new site first.
        if (action.type === 'WEB_CHAT/SEND_MESSAGE' && connected) sendContext();
        if (action.type === 'DIRECT_LINE/CONNECT_FULFILLED') {
          connected = true;
          const ctx = deps.context();
          if (ctx) setTimeout(sendContext, 0);
          dispatch({ type: 'WEB_CHAT/SEND_EVENT', payload: { name: 'startConversation', value: { locale: 'en-GB' } } });
          status(ctx ? 'Connected. The agent has this site.' : 'Connected. Analyse the site to give the agent its context.');
        }
        return next(action);
      });
      directLine = WC.createDirectLine({ token: t.token, domain: `${t.directLineDomain || 'https://directline.botframework.com'}/v3/directline` });
      // Hide the site context messages and the agent's replies to them.
      const isHidden = (a: any) => a?.channelData?.allto === 'site-context' || (a?.replyToId && hidden.has(a.replyToId)) || (typeof a?.text === 'string' && a.text.startsWith('[Ultrahand site context]'));
      const activityMiddleware = () => (next: any) => (...args: any[]) => (isHidden(args[0]?.activity) ? false : next(...args));
      WC.renderWebChat(
        {
          directLine,
          store,
          activityMiddleware,
          userID: t.userId,
          locale: 'en-GB',
          styleOptions: {
            primaryFont: "'Plus Jakarta Sans', Helvetica, Arial, sans-serif",
            accent: '#141414',
            bubbleBorderRadius: 0,
            bubbleFromUserBorderRadius: 0,
            bubbleFromUserBackground: '#141414',
            bubbleFromUserTextColor: '#ffffff',
            bubbleBorderColor: '#e2e1dc',
            sendBoxBorderTop: 'solid 1px #e2e1dc',
            hideUploadButton: true,
            botAvatarInitials: 'UH',
            avatarSize: 28,
            backgroundColor: '#ffffff',
          },
        },
        host,
      );
    } catch (e) {
      started = false;
      status((e as Error).message);
    }
  }

  function open() {
    drawer.hidden = false;
    if (!store) {
      render();
      connect();
    } else sendContext();
  }
  function close() {
    drawer.hidden = true;
  }

  return {
    open,
    close,
    /** Call when the analysis or selection changes: a connected agent gets the new picture. */
    contextChanged() {
      if (started) return; // a connected agent gets the new site just before the next question
      if (!drawer.hidden) render();
      // A connected agent gets the new site just before the next question (see the store middleware).
    },
  };
}
