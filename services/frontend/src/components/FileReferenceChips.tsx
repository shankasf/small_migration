import { useState } from 'react';
import { AtSign, X } from 'lucide-react';
import { FileReference } from '../types';
import LibraryFilePreview from './LibraryFilePreview';

export default function FileReferenceChips({ files, onRemove, label = 'Attached files' }: {
  files: FileReference[]; onRemove?: (id: string) => void; label?: string;
}) {
  const [preview, setPreview] = useState<FileReference | null>(null);
  if (!files.length) return null;
  return (
    <div className="mb-3 min-w-0" aria-label={label}>
      <p className="mb-1.5 text-[11px] text-faint">{label}</p>
      <div className="flex flex-wrap gap-2">
        {files.map(file => (
          <span key={file.assetId} className="inline-flex max-w-full items-start gap-1 rounded-xl border border-brass/25 bg-brass/5 px-2.5 py-2 text-xs text-ink">
            <button type="button" onClick={() => setPreview(file)} className="flex min-w-0 items-start gap-1.5 text-left hover:text-brass" title="Preview selected version">
              <AtSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brass" /><span className="min-w-0 break-words">{file.filename} <span className="whitespace-nowrap text-faint">· v{file.version}</span></span>
            </button>
            {onRemove && <button type="button" aria-label={`Remove ${file.filename}`} onClick={() => onRemove(file.assetId)} className="shrink-0 rounded p-0.5 text-faint hover:text-danger"><X className="h-3.5 w-3.5" /></button>}
          </span>
        ))}
      </div>
      {preview && <LibraryFilePreview id={preview.assetId} filename={preview.filename} version={preview.version} onClose={() => setPreview(null)} />}
    </div>
  );
}
