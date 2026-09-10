import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import * as api from '../services/api';

export default function LibraryFilePreview({ id, filename, version, onClose }: {
  id: string; filename: string; version: number; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.getLibraryFileContent(id).then(data => { if (active) setContent(data.content); })
      .catch(err => { if (active) setError(api.apiErrorMessage(err)); });
    return () => { active = false; };
  }, [id]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopImmediatePropagation(); onClose(); }
      if (event.key === 'Tab') {
        event.stopImmediatePropagation();
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', close, true);
    return () => { document.removeEventListener('keydown', close, true); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-obsidian/90 p-3 backdrop-blur-sm" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Preview ${filename}`} className="flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-console">
        <header className="flex items-start gap-3 border-b border-hairline p-4">
          <div className="min-w-0 flex-1"><h2 className="break-words text-sm font-600 text-ink">{filename}</h2><p className="mt-1 text-xs text-faint">Version {version} · Exact saved content</p></div>
          <button type="button" aria-label={`Download ${filename}`} title="Download" className="rounded-lg p-2 text-muted hover:bg-elevated" onClick={() => api.downloadLibraryFile(id, filename).catch(err => setError(api.apiErrorMessage(err)))}><Download className="h-4 w-4" /></button>
          <button autoFocus type="button" aria-label="Close preview" onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
        </header>
        {error && <p role="alert" className="p-4 text-sm text-danger">{error}</p>}
        {content === null && !error ? <p role="status" className="p-6 text-sm text-muted">Loading file…</p> : <pre className="overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs leading-relaxed text-ink">{content}</pre>}
      </section>
    </div>
  );
}
