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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-800 truncate">{filename}</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={onDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-500 hover:text-gray-700 transition-colors"
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
            }}
            codeTagProps={{
              style: {
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Monaco', monospace",
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
