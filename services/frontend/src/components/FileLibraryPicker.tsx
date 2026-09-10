import { useEffect, useRef, useState } from 'react';
import { AtSign, Check, Download, Eye, FileCode, Search, X } from 'lucide-react';
import { LibraryFile } from '../types';
import * as api from '../services/api';
import LibraryFilePreview from './LibraryFilePreview';

export default function FileLibraryPicker({ selected, onToggle, onClose, initialQuery = '' }: {
  selected: LibraryFile[]; onToggle: (file: LibraryFile) => void; onClose: () => void; initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState('');
  const [date, setDate] = useState('all');
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<LibraryFile | null>(null);
  const [semanticAvailable, setSemanticAvailable] = useState(true);
  const [appliedFilters, setAppliedFilters] = useState<string[]>([]);
  const dialogRef = useRef<HTMLElement>(null);
  const selectedIds = new Set(selected.map(file => file.id));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') || []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError('');
      const params: { q: string; kind?: string; from?: string; to?: string; offset: number } = { q: query, offset };
      if (kind) params.kind = kind;
      if (date !== 'all') {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        if (date === 'yesterday') {
          params.to = start.toISOString();
          start.setDate(start.getDate() - 1);
        } else if (date === 'week') start.setDate(start.getDate() - 6);
        params.from = start.toISOString();
      }
      api.searchFileLibrary(params, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        setFiles(previous => offset ? [...previous, ...result.files.filter(file => !previous.some(existing => existing.id === file.id))] : result.files);
        setHasMore(result.hasMore);
        setSemanticAvailable(result.semanticAvailable);
        const filters = result.filters;
        setAppliedFilters(filters ? [
          filters.kind === 'output' ? 'Generated' : filters.kind === 'upload' ? 'Uploaded' : '',
          filters.extension ? filters.extension.replace(/^\./, '').toUpperCase() : '',
          filters.from ? `From ${new Date(filters.from).toLocaleString(undefined, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC` : '',
          filters.to ? `Before ${new Date(filters.to).toLocaleString(undefined, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC` : '',
        ].filter(Boolean) : []);
      }).catch(err => {
        if (!controller.signal.aborted) setError(api.apiErrorMessage(err));
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, kind, date, offset]);

  const resetResults = () => { setOffset(0); setFiles([]); setLoading(true); setAppliedFilters([]); };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-obsidian/85 p-3 backdrop-blur-sm" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="file-library-title" className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-console">
        <header className="flex items-start gap-3 border-b border-hairline p-4 sm:p-5">
          <span className="rounded-xl bg-brass/10 p-2.5 text-brass"><AtSign className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h2 id="file-library-title" className="font-display text-lg font-600 text-ink">My Files</h2><p className="mt-1 text-xs text-muted">Find uploads and generated files across your chats. Choose the exact version to use.</p></div>
          <button type="button" aria-label="Close My Files" onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-elevated"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-3 border-b border-hairline p-4">
          <div className="flex items-center gap-2 rounded-xl border border-hairline bg-obsidian px-3 focus-within:border-brass/60"><Search className="h-4 w-4 shrink-0 text-faint" /><input autoFocus style={{ boxShadow: 'none', border: 0 }} value={query} onChange={event => { setQuery(event.target.value); resetResults(); }} aria-label="Search my files" placeholder="Search by filename, meaning, or SQL detail…" className="min-w-0 flex-1 bg-transparent py-3 text-sm text-ink outline-none placeholder:text-faint" /></div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="library-kind">File source</label><select id="library-kind" value={kind} onChange={event => { setKind(event.target.value); resetResults(); }} className="rounded-lg border border-hairline bg-elevated px-3 py-2 text-xs text-ink"><option value="">All files</option><option value="upload">Uploaded</option><option value="output">Generated</option></select>
            <label className="sr-only" htmlFor="library-date">File date</label><select id="library-date" value={date} onChange={event => { setDate(event.target.value); resetResults(); }} className="rounded-lg border border-hairline bg-elevated px-3 py-2 text-xs text-ink"><option value="all">Any date</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">Past 7 days</option></select>
            <span className="ml-auto text-[11px] text-faint">All versions · Your files only</span>
          </div>
        </div>
        {appliedFilters.length > 0 && <p className="border-b border-hairline px-4 py-2 text-xs text-muted" aria-label="Applied search filters">Filters: {appliedFilters.join(' · ')}</p>}
        <div className="min-h-[160px] flex-1 overflow-y-auto p-4" aria-busy={loading}>
          {error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p>}
          {!semanticAvailable && !loading && <p role="status" className="mb-3 text-xs text-muted">Showing filename and keyword matches. Meaning search is temporarily unavailable.</p>}
          {!loading && !error && files.length === 0 && <div className="py-10 text-center"><FileCode className="mx-auto mb-3 h-8 w-8 text-faint" /><p className="text-sm text-ink">{query || kind || date !== 'all' ? 'No matching files' : 'Your file library is empty'}</p><p className="mt-2 text-xs text-muted">{query || kind || date !== 'all' ? 'Try another phrase or broaden the filters.' : 'Upload a file or generate one in a chat to find it here.'}</p></div>}
          <div className="space-y-3">
            {files.map(file => {
              const attached = selectedIds.has(file.id);
              return (
                <article key={file.id} className={`rounded-xl border p-3 sm:p-4 ${attached ? 'border-brass/60 bg-brass/5' : 'border-hairline bg-obsidian/40'}`}>
                  <div className="flex items-start gap-2"><FileCode className="mt-0.5 h-4 w-4 shrink-0 text-brass" /><h3 className="min-w-0 flex-1 break-words text-sm font-600 text-ink">{file.filename}</h3><span className="shrink-0 rounded bg-elevated px-2 py-0.5 font-mono text-[11px] text-muted">v{file.version}</span></div>
                  <p className="mt-2 break-words text-xs text-muted">{file.kind === 'upload' ? 'Uploaded' : 'Generated'} · {new Date(file.createdAt).toLocaleString()} · {file.sourceSessionName || 'Untitled chat'}</p>
                  {file.summary && <p className="mt-2 break-words text-xs leading-relaxed text-ink">{file.summary}</p>}
                  {file.excerpt && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-panel p-2.5 font-mono text-[11px] leading-relaxed text-muted" aria-label="Matching excerpt">{file.excerpt}</pre>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => setPreview(file)} className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-2.5 py-2 text-xs text-ink hover:bg-elevated"><Eye className="h-3.5 w-3.5" />Preview</button>
                    <button type="button" onClick={() => api.downloadLibraryFile(file.id, file.filename).catch(err => setError(api.apiErrorMessage(err)))} className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-2.5 py-2 text-xs text-ink hover:bg-elevated"><Download className="h-3.5 w-3.5" />Download</button>
                    <button type="button" aria-pressed={attached} disabled={!attached && selected.length >= 10} onClick={() => onToggle(file)} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-600 disabled:opacity-40 ${attached ? 'border border-brass/40 text-brass' : 'bg-brass text-obsidian hover:bg-brass-bright'}`}>{attached ? <><Check className="h-3.5 w-3.5" />Selected</> : 'Use in this chat'}</button>
                  </div>
                </article>
              );
            })}
          </div>
          {loading && <p role="status" className="py-6 text-center text-sm text-muted">Searching your files…</p>}
          {hasMore && !loading && !error && <button type="button" onClick={() => setOffset(files.length)} className="mt-4 w-full rounded-xl border border-hairline py-2.5 text-sm text-ink hover:bg-elevated">Load more files</button>}
        </div>
        <footer className="flex items-center gap-3 border-t border-hairline p-4"><p className="flex-1 text-xs text-muted">{selected.length}/10 selected · Preview files to check a match.</p><button type="button" onClick={onClose} className="rounded-xl bg-brass px-4 py-2.5 text-sm font-600 text-obsidian hover:bg-brass-bright">{selected.length ? 'Done' : 'Close'}</button></footer>
      </section>
      {preview && <LibraryFilePreview id={preview.id} filename={preview.filename} version={preview.version} onClose={() => setPreview(null)} />}
    </div>
  );
}
