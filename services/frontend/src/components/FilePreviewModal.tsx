import { useEffect } from 'react';
import { X, Download } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface FilePreviewModalProps {
  filename: string;
  content: string;
  onClose: () => void;
  onDownload: () => void;
}

function getLanguage(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const langMap: Record<string, string> = {
    sql: 'sql',
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    json: 'json',
    csv: 'csv',
    xml: 'xml',
    html: 'html',
    css: 'css',
    sh: 'bash',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return langMap[ext] || 'text';
}

export default function FilePreviewModal({ filename, content, onClose, onDownload }: FilePreviewModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const language = getLanguage(filename);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-obsidian/80 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel-elevated animate-fade-up w-[90vw] max-w-4xl max-h-[85vh] flex flex-col overflow-hidden !rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-hairline bg-panel">
          <h3 className="text-sm font-600 font-display text-ink break-words min-w-0">{filename}</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={onDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted hover:text-success hover:bg-success/10 rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted hover:bg-elevated hover:text-ink transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <SyntaxHighlighter
            style={oneDark}
            language={language}
            showLineNumbers
            customStyle={{
              margin: 0,
              borderRadius: 0,
              fontSize: '13px',
              padding: '1rem',
              minHeight: '100%',
              background: '#1e1e2e',
            }}
            codeTagProps={{
              style: {
                fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
                // Restate the base text color: codeTagProps replaces the
                // theme's inline style, and the page ink color is near-black
                // in light mode — invisible on this dark panel.
                color: '#abb2bf',
              }
            }}
          >
            {content}
          </SyntaxHighlighter>
        </div>
      </div>
    </div>
  );
}
