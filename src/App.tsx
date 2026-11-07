import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, CircleHelp, Clock3, Code2, Fingerprint, Inbox as InboxIcon, Loader2, LockKeyhole, Moon, Plus, Radio, Search, Send, ShieldCheck, Sparkles, Sun, Terminal, Trash2, Unplug, X, Zap } from 'lucide-react';
import type { CapturedRequest, CapturedRequestSummary, Inbox, LiveEvent } from '../shared/types';
import { CopyButton, Method, Modal } from './components';
import RequestDetail from './RequestDetail';
import { api, ApiError, bytes, remaining, requestPath, savedInbox, saveInbox, time } from './lib';
import { useTheme } from './useTheme';

type Dialog = 'docs' | 'privacy' | 'new' | 'clear' | null;
type Connection = 'connecting' | 'live' | 'reconnecting' | 'expired';
type InitialData = { inbox: Inbox; requests: CapturedRequestSummary[] };

const TEST_BODY = {
  event: 'hello.webhook',
  message: 'Looking good! Your endpoint is ready.',
  data: { order_id: 'ord_8f29a', amount: 4900, currency: 'USD', paid: true },
};

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [requests, setRequests] = useState<CapturedRequestSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CapturedRequest | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [ttl, setTtl] = useState(24);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('ALL');
  const [follow, setFollow] = useState(true);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const initial = useRef<Promise<InitialData> | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  const notify = useCallback((message: string, error = true) => setToast({ message, error }), []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!initial.current) {
      initial.current = (async () => {
        const previous = savedInbox();
        if (previous && /^[\w-]{16}$/.test(previous)) {
          try { return await api<InitialData>(`/api/inboxes/${previous}`); }
          catch (error) { if (!(error instanceof ApiError) || ![404, 410].includes(error.status)) throw error; }
        }
        const result = await api<{ inbox: Inbox }>('/api/inboxes', { method: 'POST', body: '{}' });
        saveInbox(result.inbox.id);
        return { inbox: result.inbox, requests: [] };
      })();
    }
    void initial.current.then((data) => {
      if (cancelled) return;
      setInbox(data.inbox);
      setRequests(data.requests);
      setSelectedId(data.requests[0]?.id ?? null);
      setLoading(false);
    }).catch((error: unknown) => {
      if (!cancelled) { setLoading(false); setInitialError(error instanceof Error ? error.message : 'Could not connect to the server.'); }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!inbox) return;
    setConnection('connecting');
    const events = new EventSource(`/api/inboxes/${inbox.id}/events`);
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const ready = (message: MessageEvent<string>) => {
      const data = JSON.parse(message.data) as { requests: CapturedRequestSummary[] };
      setConnection('live');
      setRequests(data.requests);
      setSelectedId((current) => data.requests.some((request) => request.id === current) ? current : data.requests[0]?.id ?? null);
    };
    const update = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as LiveEvent;
      if (event.type === 'request') {
        setRequests((current) => [event.request, ...current.filter((request) => request.id !== event.request.id)].slice(0, inbox.requestLimit));
        setSelectedId((current) => followRef.current || !current ? event.request.id : current);
      } else if (event.type === 'cleared') {
        setRequests([]);
        setSelectedId(null);
      } else {
        setConnection('expired');
        events.close();
      }
    };
    events.addEventListener('ready', ready);
    events.addEventListener('update', update);
    events.onerror = () => {
      if (stopped) return;
      setConnection((current) => current === 'expired' ? current : 'reconnecting');
      // EventSource retries dropped connections itself, but HTTP errors can
      // permanently close it. Retry those too, unless ownership/expiry is gone.
      if (events.readyState === EventSource.CLOSED) retry = setTimeout(() => setStreamAttempt((attempt) => attempt + 1), 3000);
      void api(`/api/inboxes/${inbox.id}`, { signal: controller.signal }).catch((error: unknown) => {
        if (!stopped && error instanceof ApiError && [404, 410].includes(error.status)) {
          setConnection('expired');
          clearTimeout(retry);
          events.close();
        }
      });
    };
    const timer = setInterval(() => {
      if (Date.now() >= new Date(inbox.expiresAt).getTime()) { setConnection('expired'); clearTimeout(retry); events.close(); }
    }, 1000);
    return () => { stopped = true; clearTimeout(retry); clearInterval(timer); controller.abort(); events.close(); };
  }, [inbox, streamAttempt]);

  useEffect(() => {
    if (!selectedId || !inbox) { setDetail(null); setDetailLoading(false); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    void api<{ request: CapturedRequest }>(`/api/inboxes/${inbox.id}/requests/${selectedId}`, { signal: controller.signal })
      .then(({ request }) => { if (!controller.signal.aborted) { setDetail(request); setDetailLoading(false); } })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) { setDetailLoading(false); setDetail(null); setDetailError(error instanceof Error ? error.message : 'Could not load this request.'); }
      });
    return () => controller.abort();
  }, [selectedId, inbox]);

  useEffect(() => {
    if (selectedId && !requests.some((request) => request.id === selectedId)) setSelectedId(requests[0]?.id ?? null);
  }, [requests, selectedId]);

  const expired = connection === 'expired' || (inbox !== null && now >= new Date(inbox.expiresAt).getTime());
  const filtered = useMemo(() => requests.filter((request) =>
    (methodFilter === 'ALL' || request.method === methodFilter) &&
    `${request.method} ${request.url} ${request.clientAddress} ${request.contentType}`.toLowerCase().includes(search.toLowerCase()),
  ), [requests, methodFilter, search]);
  const methods = useMemo(() => [...new Set(requests.map((request) => request.method))].sort(), [requests]);
  const command = [
    `curl -X POST '${inbox?.url ?? 'YOUR_ENDPOINT_URL'}' \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"event":"hello.webhook","message":"Hello, world!"}'`,
  ].join('\n');

  async function sendTest() {
    if (!inbox || expired) return;
    setTesting(true);
    try {
      const response = await fetch(`/h/${inbox.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hook-Inspector': 'test-request' },
        body: JSON.stringify({ ...TEST_BODY, timestamp: new Date().toISOString() }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? 'Could not send the test request.');
      }
      notify('Test request sent. That’s a real HTTP request, by the way.', false);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not send the test request.'); }
    finally { setTesting(false); }
  }

  async function newEndpoint() {
    setBusy(true);
    try {
      const result = await api<{ inbox: Inbox }>('/api/inboxes', { method: 'POST', body: JSON.stringify({ ttlHours: ttl }) });
      const previous = inbox;
      saveInbox(result.inbox.id);
      setInbox(result.inbox);
      setInitialError(null);
      setRequests([]);
      setSelectedId(null);
      setDetail(null);
      setSearch('');
      setMethodFilter('ALL');
      setConnection('connecting');
      setDialog(null);
      if (previous && !expired) {
        try { await api(`/api/inboxes/${previous.id}`, { method: 'DELETE' }); }
        catch { notify('Your new endpoint is ready, but the previous one could not be revoked. It will still expire automatically.'); return; }
      }
      notify('Fresh endpoint, clean slate. You’re ready to go.', false);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not create an endpoint.'); }
    finally { setBusy(false); }
  }

  async function clearRequests() {
    if (!inbox) return;
    setBusy(true);
    try {
      await api(`/api/inboxes/${inbox.id}/requests`, { method: 'DELETE' });
      // A live `cleared` event is ordered with subsequent arrivals. Don't
      // overwrite requests that arrived after it with an optimistic empty list.
      if (connection !== 'live') { setRequests([]); setSelectedId(null); }
      setDialog(null);
      notify('Requests cleared. Your endpoint is still listening.', false);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not clear requests.'); }
    finally { setBusy(false); }
  }

  return <div className="app-shell">
    <header className="site-header"><div className="header-inner">
      <a href="/" className="brand" aria-label="Hook Inspector home"><span className="brand-symbol"><svg width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M7 5v13a6 6 0 0 0 12 0v-5m-4 4 4-4 4 4M4 5h6" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>hook<span className="brand-light">inspector</span><span className="brand-period">.</span></span></a>
      <div className="header-right"><span className="header-tag">Less guessing. More shipping.</span><div className="header-divider" /><button className="docs-link" onClick={() => setDialog('docs')}><BookOpen size={15} /> Quick guide <ArrowUpRight size={14} /></button><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button></div>
    </div></header>

    <main className="main">
      <section className="intro"><div><div className="eyebrow"><span /> YOUR WEBHOOK’S NEW FAVORITE PIT STOP</div><h1>A little clarity for your webhooks<span>.</span></h1><p>Catch requests in real time. Inspect every detail. Get back to building.</p></div><div className="no-signup"><ShieldCheck size={17} /><div>No signup. No setup.<span>Just point, send, and inspect.</span></div></div></section>

      <section className={`endpoint-card ${expired ? 'endpoint-expired' : ''}`} aria-label="Your temporary webhook endpoint">
        <div className="endpoint-top"><div className="endpoint-label"><span className="endpoint-icon"><Radio size={15} /></span> YOUR UNIQUE ENDPOINT <span className="temporary-label">TEMPORARY</span></div><span className={`expiry-badge ${expired ? 'is-expired' : ''}`}><Clock3 size={13} />{inbox ? remaining(inbox.expiresAt, now) : 'Up to 24 hours'}</span></div>
        <div className="endpoint-main"><div className="endpoint-url">{loading ? <span className="endpoint-loading"><Loader2 size={18} className="spin" /> Creating your endpoint…</span> : inbox ? <><span className="url-prefix">{inbox.url.slice(0, inbox.url.lastIndexOf('/') + 1)}</span><span>{inbox.id}</span></> : <span className="endpoint-loading">Your endpoint will appear here</span>}</div>{inbox && <CopyButton value={inbox.url} label="Copy URL" className="primary-copy" onError={notify} />}</div>
        <div className="endpoint-bottom"><span><LockKeyhole size={12} />{expired ? 'This endpoint is no longer receiving requests.' : 'Anyone can send. Only this browser can inspect.'}</span><button onClick={() => setDialog('new')} disabled={loading}><Plus size={13} />{expired ? 'Create a new endpoint' : 'New endpoint'}<ArrowRight size={13} /></button></div>
      </section>

      {initialError && <div className="error-banner" role="alert"><Unplug size={18} /><span>{initialError}</span><button onClick={() => window.location.reload()}>Try again <ArrowRight size={14} /></button></div>}
      {expired && <div className="expired-banner"><Clock3 size={17} /><span>This endpoint has expired or been revoked. Create a new one to keep inspecting.</span><button onClick={() => setDialog('new')}>Start fresh <ArrowRight size={14} /></button></div>}

      <section className="workspace" aria-label="Request inspector">
        <aside className="request-sidebar">
          <div className="sidebar-heading"><h2>Incoming requests <span className="count-badge">{requests.length}</span></h2><div className="sidebar-actions"><span className={`connection-status ${connection}`} title={connection === 'live' ? 'Connected. New requests appear automatically.' : connection === 'reconnecting' ? 'Reconnecting automatically. Requests are still being captured.' : connection === 'expired' ? 'Endpoint is no longer active' : 'Connecting to the live feed'}><span />{expired ? 'Expired' : connection === 'live' ? 'Live' : connection === 'reconnecting' ? 'Retrying' : 'Connecting'}</span><button className="icon-button" onClick={() => setDialog('clear')} disabled={!requests.length || expired} title="Clear all requests" aria-label="Clear all requests"><Trash2 size={15} /></button></div></div>
          <div className="request-filters"><div className="search-field"><Search size={14} /><input aria-label="Search requests" placeholder="Search requests…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={12} /></button>}</div><div className="method-select"><select aria-label="Filter by method" value={methodFilter} onChange={(event) => setMethodFilter(event.target.value)}><option value="ALL">All methods</option>{methods.map((method) => <option key={method} value={method}>{method}</option>)}</select><ChevronDown size={12} /></div></div>
          <div className="requests-scroll" aria-live="polite" aria-relevant="additions removals">
            {filtered.length ? filtered.map((request) => <button className={`request-row ${selectedId === request.id ? 'active' : ''}`} key={request.id} onClick={() => { setSelectedId(request.id); setFollow(false); }} aria-pressed={selectedId === request.id}>
              <div className="request-row-top"><Method method={request.method} /><span>{time(request.receivedAt)}</span></div>
              <div className="request-row-path" title={request.url}>{requestPath(request.url)}<ArrowDownLeft size={13} /></div>
              <div className="request-row-meta"><span>{request.clientAddress}</span><span>{bytes(request.bodySize)}<i />{request.responseStatus === 204 ? '204 No Content' : '200 OK'}</span></div>
            </button>) : <div className="sidebar-empty"><span className="sidebar-empty-icon"><InboxIcon size={23} strokeWidth={1.4} /></span><h3>{search || methodFilter !== 'ALL' ? 'No matching requests' : 'A clean slate'}</h3><p>{search || methodFilter !== 'ALL' ? 'Try another search or method.' : <>Your incoming requests will<br />make themselves at home here.</>}</p>{(search || methodFilter !== 'ALL') && <button className="text-button" onClick={() => { setSearch(''); setMethodFilter('ALL'); }}>Reset filters</button>}</div>}
          </div>
          <div className="sidebar-footer"><label><input type="checkbox" checked={follow} onChange={(event) => { setFollow(event.target.checked); if (event.target.checked && requests[0]) setSelectedId(requests[0].id); }} /><span className="checkbox-visual">{follow && <Check size={10} strokeWidth={3} />}</span>Follow latest</label><span>{inbox ? `Latest ${inbox.requestLimit} kept` : 'Auto-updating'}<Activity size={12} /></span></div>
        </aside>

        <div className="request-detail">
          {detailLoading ? <div className="detail-loading"><Loader2 size={24} className="spin" /><p>Getting every little detail…</p></div>
            : detailError ? <div className="detail-loading"><Unplug size={26} /><p>{detailError}</p></div>
              : detail && selectedId ? <RequestDetail request={detail} onError={notify} />
                : <div className="waiting-state">
                  <div className="waiting-illustration" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit-dot dot-one" /><div className="orbit-dot dot-two" /><span className="float-chip chip-braces"><Code2 size={16} /></span><span className="float-chip chip-zap"><Zap size={15} /></span><div className="waiting-icon"><ArrowDownLeft size={31} strokeWidth={1.65} /></div><span className="illustration-status"><span /> {expired ? 'offline' : 'listening'}</span></div>
                  <span className="waiting-eyebrow">ALL EARS. ZERO GUESSWORK.</span><h2>{expired ? 'Good things have a time limit.' : 'Ready when you are.'}</h2><p>{expired ? <>Your temporary endpoint has reached the end of its run.<br />A fresh one is just a click away.</> : <>Send a webhook to your unique URL above.<br />We’ll catch it and unpack all the details, instantly.</>}</p>
                  {expired ? <button className="button primary" onClick={() => setDialog('new')}><Plus size={15} /> Create new endpoint</button> : <button className="button primary" disabled={!inbox || testing} onClick={() => void sendTest()}>{testing ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Send a test request <ArrowRight size={14} /></button>}
                  {!expired && <span className="test-caption">Take it for a spin. We’ll send a real request.</span>}
                  <div className="empty-features"><span><Fingerprint size={15} /> Source IP</span><span><Code2 size={15} /> Every header</span><span><Terminal size={15} /> Raw body</span></div>
                </div>}
        </div>
      </section>

      <section className="bottom-grid"><div className="curl-card"><div className="curl-card-header"><span><Terminal size={15} /> More of a terminal person?</span><CopyButton value={command} label="Copy cURL" onError={notify} /></div><pre><code><span className="curl-orange">curl</span> -X <span className="curl-green">POST</span> <span className="curl-string">'{inbox?.url ?? 'YOUR_ENDPOINT_URL'}'</span> <span className="curl-comment">\</span>{'\n'}  -H <span className="curl-string">'Content-Type: application/json'</span> <span className="curl-comment">\</span>{'\n'}  -d <span className="curl-string">'{`{"event":"hello.webhook","message":"Hello, world!"}`}'</span></code></pre></div><div className="good-to-know"><span className="good-icon"><Sparkles size={17} /></span><div><h3>Here for a good time, not a long time.</h3><p>Endpoints expire automatically. Requests are private to this browser and deleted when the endpoint expires. Keep your production secrets out of test payloads.</p><button onClick={() => setDialog('privacy')}>A note on privacy <ArrowUpRight size={12} /></button></div></div></section>
      <footer className="site-footer"><span><span className="footer-status-dot" /> A small tool for the things between your services.</span><div><button onClick={() => setDialog('docs')}><CircleHelp size={13} /> How it works</button><span className="footer-dot">·</span><button onClick={() => setDialog('privacy')}><ShieldCheck size={13} /> Privacy first</button><span className="version">v1.0</span></div></footer>
    </main>

    {detail && !expired && <button className="floating-test" onClick={() => void sendTest()} disabled={testing} title="Send another real test request">{testing ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send test</button>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={17} /> : <Check size={17} />}<span>{toast.message}</span><button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button></div>}

    {dialog === 'docs' && <Modal title="A webhook debugging pit stop" onClose={() => setDialog(null)} wide><div className="guide-steps"><GuideStep number="01" title="Copy your temporary URL">Every browser gets a unique endpoint. Paste it into the webhook settings of the service you’re debugging. You can append paths and query parameters, too.</GuideStep><GuideStep number="02" title="Send something its way">Trigger an event in your service, run the cURL command below, or send a test request here. GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS are all welcome.</GuideStep><GuideStep number="03" title="Get the whole picture">Requests appear live. Select one to see its original headers, query parameters, source IP, connection details, and exact body. Download the body or export the full request as JSON.</GuideStep></div><div className="guide-code"><div><Terminal size={14} /> Try it from your terminal <CopyButton value={command} onError={notify} /></div><pre>{command}</pre></div><div className="info-note"><ShieldCheck size={17} /><p>Your endpoint URL lets anyone <strong>send</strong> requests, not read them. Inspection requires an HttpOnly credential kept in the browser that created it. Opening this site in another browser starts a separate inbox.</p></div><div className="guide-limits"><span>Up to 24-hour lifetime</span><span>{inbox ? bytes(inbox.bodyLimit) : '1 MB'} per request</span><span>Latest {inbox?.requestLimit ?? 100} requests</span></div></Modal>}
    {dialog === 'privacy' && <Modal title="A little transparency, too." onClose={() => setDialog(null)}><div className="privacy-hero"><ShieldCheck size={28} /><h3>Private to your browser.<br />Temporary by design.</h3></div><div className="privacy-copy"><h4>What gets stored?</h4><p>The request method, original URL, headers (including authorization and cookies if sent), body bytes, trailers, source IP, and connection metadata. Payloads are stored in the operator’s SQLite database, not just in browser memory.</p><h4>Who can see it?</h4><p>Only this browser can inspect your inbox through the app. The service operator can access its database, so don’t send passwords, personal data, or production secrets. This is a debugging tool, not a secrets vault.</p><h4>When is it deleted?</h4><p>Expired endpoints and their requests are removed within 30 seconds of expiry while the server is running, or on its next startup. You can clear requests or replace your endpoint sooner. Only the latest {inbox?.requestLimit ?? 100} requests are retained. Operator backups, if any, have separate retention.</p><h4>Any trackers?</h4><p>No analytics, advertising, or third-party requests are included. One essential HttpOnly cookie protects your inbox, and local browser storage remembers its ID.</p></div></Modal>}
    {dialog === 'new' && <Modal title="A fresh start?" onClose={() => { if (!busy) setDialog(null); }}><div className="dialog-icon"><Plus size={25} /></div><p className="dialog-description">Create a brand-new URL for your next test.{inbox && !expired && <> Your current endpoint will be <strong>revoked</strong> and its captured requests deleted.</>}</p><label className="expiry-select-label" htmlFor="expiry">Keep this endpoint alive for</label><div className="expiry-select"><select id="expiry" value={ttl} onChange={(event) => setTtl(Number(event.target.value))}><option value={1}>1 hour · a quick test</option><option value={6}>6 hours · a little debugging</option><option value={24}>24 hours · a full day</option></select><ChevronDown size={16} /></div><div className="dialog-actions"><button className="button secondary" onClick={() => setDialog(null)} disabled={busy}>Keep this one</button><button className="button primary" onClick={() => void newEndpoint()} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} Create endpoint</button></div></Modal>}
    {dialog === 'clear' && <Modal title="Clear the slate?" onClose={() => { if (!busy) setDialog(null); }}><div className="dialog-icon"><Trash2 size={23} /></div><p className="dialog-description">This permanently deletes all {requests.length} captured requests in this inbox. Your endpoint URL stays the same and will keep receiving new requests.</p><div className="dialog-actions"><button className="button secondary" onClick={() => setDialog(null)} disabled={busy}>Keep requests</button><button className="button danger" onClick={() => void clearRequests()} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} Clear all requests</button></div></Modal>}
  </div>;
}

function GuideStep({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <div className="guide-step"><span>{number}</span><div><h3>{title}</h3><p>{children}</p></div></div>;
}
