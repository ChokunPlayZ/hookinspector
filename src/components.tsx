import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { HeaderPair } from '../shared/types';

export function CopyButton({ value, label = 'Copy', className = '', onError }: {
  value: string;
  label?: string;
  className?: string;
  onError?: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { onError?.('Clipboard access needs HTTPS or localhost. Select and copy the text manually.'); }
  }

  return <button className={`copy-button ${className}`} onClick={() => void copy()} aria-label={copied ? 'Copied to clipboard' : label}>
    {copied ? <Check size={15} /> : <Copy size={15} />}<span>{copied ? 'Copied!' : label}</span>
  </button>;
}

export function Method({ method }: { method: string }) {
  const style = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method.toLowerCase() : 'other';
  return <span className={`method method-${style}`}>{method}</span>;
}

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} aria-labelledby={titleId} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={onClose} onClick={(event) => {
    if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }
  }}>
    <div className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>
    <div className="modal-content">{children}</div>
  </dialog>;
}

export function PairTable({ pairs, empty }: { pairs: HeaderPair[]; empty: string }) {
  if (!pairs.length) return <div className="small-empty">{empty}</div>;
  return <div className="table-scroll"><table className="pair-table"><thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
    <tbody>{pairs.map(([key, value], index) => <tr key={`${key}-${index}`}><td>{key}</td><td>{value || <span className="muted">(empty)</span>}</td></tr>)}</tbody>
  </table></div>;
}

export function JsonCode({ value }: { value: string }) {
  // Render tokens as React text, never HTML: webhook payloads are untrusted.
  const lines = value.split('\n');
  return <div className="code-view" role="region" aria-label="Request body" tabIndex={0}>{lines.map((line, index) =>
    <div className="code-line" key={index}><span className="line-number" aria-hidden="true">{index + 1}</span><code>{line.split(/("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g).map((part, token) => {
      let type = '';
      if (part.startsWith('"')) type = part.trimEnd().endsWith(':') ? 'token-key' : 'token-string';
      else if (/^(true|false|null)$/.test(part)) type = 'token-boolean';
      else if (/^-?\d/.test(part)) type = 'token-number';
      return <span className={type} key={token}>{part}</span>;
    })}</code></div>,
  )}</div>;
}
