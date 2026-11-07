import { useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Braces, ChevronRight, Clock3, FileJson, Globe2, Network, Radio, Terminal, Timer, WrapText } from 'lucide-react';
import type { CapturedRequest, HeaderPair } from '../shared/types';
import { CopyButton, JsonCode, Method, PairTable } from './components';
import { bodyBytes, bodyText, bytes, download, requestPath, time } from './lib';

type Tab = 'body' | 'headers' | 'query' | 'overview';

export default function RequestDetail({ request, onError }: { request: CapturedRequest; onError: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>('body');
  const [format, setFormat] = useState<'pretty' | 'raw' | 'base64'>('pretty');
  const [wrap, setWrap] = useState(false);
  const text = useMemo(() => bodyText(request.bodyBase64), [request.bodyBase64]);
  const pretty = useMemo(() => {
    if (text === null) return null;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return null; }
  }, [text]);
  const query: HeaderPair[] = [...new URL(request.url, 'http://internal').searchParams.entries()];
  const displayed = format === 'base64' ? request.bodyBase64 : format === 'pretty' && pretty !== null ? pretty : text;
  const preview = useMemo(() => {
    if (displayed === null) return null;
    return displayed.slice(0, 65_536).split('\n').slice(0, 1000).join('\n');
  }, [displayed]);
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'body', label: 'Body' },
    { key: 'headers', label: 'Headers', count: request.headers.length },
    { key: 'query', label: 'Query params', count: query.length },
    { key: 'overview', label: 'Overview' },
  ];

  function exportRequest() {
    download(`request-${request.id}.json`, JSON.stringify(request, null, 2), 'application/json');
  }

  return <div className="detail-content">
    <div className="detail-heading">
      <div className="detail-eyebrow"><span className="received-dot" /> REQUEST RECEIVED <span className="detail-request-id">#{request.id.slice(0, 8)}</span></div>
      <div className="detail-title"><div><Method method={request.method} /><h2 title={request.url}>{requestPath(request.url)}</h2></div>
        <button className="icon-button export-button" title="Export full request as JSON" aria-label="Export full request as JSON" onClick={exportRequest}><ArrowDownToLine size={18} /></button>
      </div>
      <div className="request-metadata"><span><Clock3 size={13} />{time(request.receivedAt)}</span><i /><span><Globe2 size={13} />{request.clientAddress}</span><i /><span>{bytes(request.bodySize)}</span><i /><span>HTTP/{request.httpVersion}</span></div>
    </div>
    <div className="detail-tabs" role="tablist" aria-label="Request details" onKeyDown={(event) => {
      const index = tabs.findIndex((item) => item.key === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); setTab(tabs[next].key); document.getElementById(`tab-${tabs[next].key}`)?.focus(); }
    }}>{tabs.map(({ key, label, count }) => <button key={key} id={`tab-${key}`} role="tab" tabIndex={tab === key ? 0 : -1} aria-selected={tab === key} aria-controls={`panel-${key}`} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}{count !== undefined && <span>{count}</span>}</button>)}</div>
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="detail-panel">
      {tab === 'body' && <>
        <div className="body-toolbar"><div className="format-switch" aria-label="Body format">{(['pretty', 'raw', 'base64'] as const).map((value) => <button key={value} className={format === value ? 'active' : ''} aria-pressed={format === value} onClick={() => setFormat(value)}>{value === 'pretty' ? <><Braces size={13} /> Pretty</> : value === 'raw' ? 'Raw' : 'Base64'}</button>)}</div>
          <div className="body-tools"><span className="content-type" title={request.contentType}>{request.contentType.split(';')[0] || 'No content type'}</span><button className={`icon-button ${wrap ? 'selected' : ''}`} aria-label="Toggle line wrapping" aria-pressed={wrap} onClick={() => setWrap(!wrap)} title="Toggle line wrapping"><WrapText size={16} /></button><CopyButton value={displayed ?? request.bodyBase64} label="Copy body" className="icon-copy" onError={onError} /><button className="icon-button" aria-label="Download original body" title="Download original body" onClick={() => download(`body-${request.id}.bin`, bodyBytes(request.bodyBase64))}><ArrowDownToLine size={16} /></button></div>
        </div>
        {!request.bodySize ? <div className="body-empty"><FileJson size={30} strokeWidth={1.3} /><h3>No body attached</h3><p>This {request.method} request arrived without a payload.<br />You can still inspect its headers and query parameters.</p></div>
          : displayed === null ? <div className="body-empty"><Network size={30} strokeWidth={1.3} /><h3>This is a binary payload</h3><p>The original {bytes(request.bodySize)} are preserved. View the Base64<br />representation or download the body to inspect it.</p><button className="button secondary" onClick={() => setFormat('base64')}>View Base64 <ArrowUpRight size={14} /></button></div>
            : <><div className={`body-code ${wrap ? 'wrap-code' : ''}`}>{format === 'pretty' && pretty !== null ? <JsonCode value={preview!} /> : <pre className="raw-code">{preview}</pre>}</div>{preview !== displayed && <div className="preview-notice">Preview limited to 64K characters / 1,000 lines. Copy or download to get the complete body.</div>}</>}
        <div className="panel-footnote"><span><CheckIcon />Original payload preserved, byte for byte</span><span>{bytes(request.bodySize)}</span></div>
      </>}
      {tab === 'headers' && <div className="table-panel"><div className="table-caption"><span>Request headers</span><span>Original casing & duplicates preserved</span></div><PairTable pairs={request.headers} empty="No headers were sent." />{request.trailers.length > 0 && <><div className="table-caption"><span>HTTP trailers</span></div><PairTable pairs={request.trailers} empty="No trailers." /></>}</div>}
      {tab === 'query' && <div className="table-panel"><div className="table-caption"><span>Query parameters</span><span>Decoded values · duplicates preserved</span></div><PairTable pairs={query} empty="No query parameters. Try appending ?hello=world to your endpoint." /></div>}
      {tab === 'overview' && <div className="overview-panel">
        <div className="overview-label"><Radio size={15} /> Connection details</div>
        <PairTable pairs={[
          ['Method', request.method], ['Request target', request.url],
          ['Received at', new Date(request.receivedAt).toISOString()],
          ['Client IP', request.clientAddress], ['Socket peer IP', request.remoteAddress],
          ['Socket peer port', String(request.remotePort ?? 'Unknown')],
          ['HTTP version', request.httpVersion], ['Protocol', request.protocol.toUpperCase()],
          ['Response status', String(request.responseStatus)],
          ['Body size', `${request.bodySize.toLocaleString()} bytes`],
          ['Body read time', `${request.durationMs} ms`],
          ['Content type', request.contentType || 'Not specified'], ['Request ID', request.id],
        ]} empty="" />
        <div className="info-note"><Network size={16} /><p>The socket peer is the server’s direct connection. Client IP uses forwarded headers <strong>only</strong> when the operator configures trusted proxy hops. All original forwarding headers appear in the Headers tab.</p></div>
        <div className="info-note"><Timer size={16} /><p>Body read time measures how long this server took to receive the payload—not the webhook provider’s end-to-end latency.</p></div>
      </div>}
    </div>
    <div className="detail-bottom"><span><Terminal size={13} /> Nothing transformed. Nothing left to guess.</span><span>HTTP request <ChevronRight size={12} /> {tab === 'query' ? 'Query params' : tab[0].toUpperCase() + tab.slice(1)}</span></div>
  </div>;
}

function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 8 2.5 2.5L12 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="8" r="6.3" stroke="currentColor" /></svg>;
}
