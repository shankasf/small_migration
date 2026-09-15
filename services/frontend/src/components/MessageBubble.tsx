import { Message, UploadedFile } from '../types';
import { Copy, Check, Terminal, Download, Eye, FileSpreadsheet, FileCode, FileText, File } from 'lucide-react';
import { useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import FileReferenceChips from './FileReferenceChips';
import MessageFeedback from './MessageFeedback';
import { CirciniMark } from './Brand';

interface MessageBubbleProps {
  message: Message;
  sessionFiles?: UploadedFile[];
  onViewFile?: (fileId: string) => void;
  onDownloadFile?: (fileId: string) => void;
  /** Off for the streaming placeholder, which has no persisted message to rate. */
  showFeedback?: boolean;
}

const languageIcons: Record<string, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  sql: 'SQL',
  json: 'JSON',
  bash: 'BASH',
  shell: 'SH',
  css: 'CSS',
  html: 'HTML',
};

function getFileIcon(filename: string) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    return <FileSpreadsheet className="w-4 h-4" />;
  }
  if (ext === 'sql') {
    return <FileCode className="w-4 h-4" />;
  }
  if (ext === 'txt' || ext === 'md') {
    return <FileText className="w-4 h-4" />;
  }
  return <File className="w-4 h-4" />;
}

function parseAttachedFiles(content: string): { filenames: string[]; restContent: string } {
  // Use greedy match (.+) to handle filenames containing ']' (e.g. data[1].csv)
  const match = content.match(/^\[Attached:\s*(.+)\]\s*/);
  if (!match) return { filenames: [], restContent: content };
  const filenames = match[1].split(',').map(f => f.trim());
  const restContent = content.slice(match[0].length).trim();
  return { filenames, restContent };
}

const MessageBubble = memo(function MessageBubble({ message, sessionFiles = [], onViewFile, onDownloadFile, showFeedback = true }: MessageBubbleProps) {
  const [copiedBlocks, setCopiedBlocks] = useState<Set<number>>(new Set());
  const blockIndexRef = { current: 0 };
  const isUser = message.role === 'user';

  const copyToClipboard = async (text: string, blockIndex: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedBlocks(prev => new Set(prev).add(blockIndex));
    setTimeout(() => {
      setCopiedBlocks(prev => {
        const next = new Set(prev);
        next.delete(blockIndex);
        return next;
      });
    }, 2000);
  };

  const downloadAsFile = (text: string, language: string) => {
    const extMap: Record<string, string> = {
      sql: 'sql', javascript: 'js', typescript: 'ts', python: 'py',
      json: 'json', bash: 'sh', shell: 'sh', css: 'css', html: 'html',
    };
    const ext = extMap[language.toLowerCase()] || 'txt';
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `generated.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // User message - small pill on right, with optional file cards
  if (isUser) {
    const { filenames, restContent } = parseAttachedFiles(message.content);
    // Match filenames to session files
    const matchedFiles = filenames
      .map(name => {
        const match = sessionFiles.find(f => f.filename === name);
        return match ? { ...match, displayName: name } : null;
      })
      .filter(Boolean) as (UploadedFile & { displayName: string })[];

    const hasFileCards = matchedFiles.length > 0 && onViewFile && onDownloadFile;

    return (
      <div className="flex justify-end mb-6">
        <div className="max-w-[85%] sm:max-w-[70%]">
          <FileReferenceChips files={message.fileRefs || []} label="Attached files" />
          {/* File attachment cards */}
          {hasFileCards && (
            <div className="mb-2 space-y-1.5">
              {matchedFiles.map(file => (
                <div
                  key={file.id}
                  className="flex items-center gap-3 px-4 py-2.5 bg-panel border border-hairline rounded-xl"
                >
                  <div className="text-brass">
                    {getFileIcon(file.filename)}
                  </div>
                  <span className="flex-1 text-sm text-ink break-words min-w-0">
                    {file.filename}
                  </span>
                  <button
                    onClick={() => onViewFile!(file.id)}
                    className="p-1.5 rounded-lg text-faint hover:bg-elevated hover:text-signal transition-colors"
                    title="View file"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onDownloadFile!(file.id)}
                    className="p-1.5 rounded-lg text-faint hover:bg-elevated hover:text-success transition-colors"
                    title="Download file"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Show remaining message text (or full content if no file cards) */}
          {(hasFileCards ? restContent : message.content) && (
            <div className="bg-elevated border border-hairline rounded-3xl px-5 py-3 text-[15px] text-ink">
              <p className="whitespace-pre-wrap">
                {hasFileCards ? restContent : message.content}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Reset block index counter for each render
  blockIndexRef.current = 0;

  // Assistant message - full width on the console canvas
  return (
    <div className="mb-8">
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className="w-8 h-8 rounded-full border border-hairline bg-elevated flex items-center justify-center flex-shrink-0 text-brass">
          <CirciniMark size={18} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pt-1">
          <FileReferenceChips files={message.fileRefs || []} label="Used files" />
          <div className="prose-console max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                table({ children }) {
                  return (
                    <div className="markdown-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
                      <table>{children}</table>
                    </div>
                  );
                },
                a({ href, children }) {
                  // The model must not emit file links, but if one slips
                  // through (a server path or invented URL), a relative href
                  // would navigate the SPA and look like a page refresh.
                  // Render non-http(s) links inert; open real links safely.
                  if (!href || !/^https?:\/\//i.test(href)) {
                    return <span>{children}</span>;
                  }
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  );
                },
                // Unwrap the default <pre>: block code renders its own panel,
                // and the outer prose <pre> styling (theme ink color, second
                // border) must not cascade into it — in light mode that made
                // untokenized code near-black on the dark panel.
                pre({ children }) {
                  return <>{children}</>;
                },
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const codeString = String(children).replace(/\n$/, '');
                  // A fenced block without a language tag has no className —
                  // treat anything multiline as a block, not inline code
                  const isInline = !match && !className && !codeString.includes('\n');
                  const language = match ? match[1] : 'text';
                  const langLabel = languageIcons[language.toLowerCase()] || language.toUpperCase();

                  if (isInline) {
                    return (
                      <code {...props}>
                        {children}
                      </code>
                    );
                  }

                  // Each code block gets its own index for copy state
                  const blockIndex = blockIndexRef.current++;
                  const isCopied = copiedBlocks.has(blockIndex);

                  return (
                    <div className="my-4 rounded-xl overflow-hidden bg-[#1e1e2e] border border-hairline">
                      <div className="flex items-center justify-between px-4 py-2 bg-raised border-b border-hairline">
                        <div className="flex items-center gap-2 text-xs text-muted">
                          <Terminal className="w-3.5 h-3.5 text-brass" />
                          <span className="font-mono font-medium">{langLabel}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => copyToClipboard(codeString, blockIndex)}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted hover:text-ink hover:bg-elevated rounded transition-colors"
                          >
                            {isCopied ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-success" />
                                <span>Copied!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => downloadAsFile(codeString, language)}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted hover:text-ink hover:bg-elevated rounded transition-colors"
                            title="Download as file"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download</span>
                          </button>
                        </div>
                      </div>
                      <SyntaxHighlighter
                        style={oneDark}
                        language={language}
                        PreTag="div"
                        customStyle={{
                          margin: 0,
                          borderRadius: 0,
                          fontSize: '13px',
                          padding: '1rem',
                          background: '#1e1e2e',
                        }}
                        codeTagProps={{
                          style: {
                            fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
                            // codeTagProps REPLACES the theme's inline style on
                            // the <code> tag, so restate the base text color:
                            // without it, untokenized text inherits the page
                            // ink color — invisible on this dark panel in
                            // light mode.
                            color: '#abb2bf',
                          }
                        }}
                      >
                        {codeString}
                      </SyntaxHighlighter>
                    </div>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
          {showFeedback && (
            <MessageFeedback messageId={message.id} initial={message.feedback} />
          )}
        </div>
      </div>
    </div>
  );
});

export default MessageBubble;
