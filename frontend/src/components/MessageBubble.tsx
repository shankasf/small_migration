import { Message, UploadedFile } from '../types';
import { Sparkles, Copy, Check, Terminal, Download, Eye, FileSpreadsheet, FileCode, FileText, File } from 'lucide-react';
import { useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MessageBubbleProps {
  message: Message;
  sessionFiles?: UploadedFile[];
  onViewFile?: (fileId: string) => void;
  onDownloadFile?: (fileId: string) => void;
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

const MessageBubble = memo(function MessageBubble({ message, sessionFiles = [], onViewFile, onDownloadFile }: MessageBubbleProps) {
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
        <div className="max-w-[70%]">
          {/* File attachment cards */}
          {hasFileCards && (
            <div className="mb-2 space-y-1.5">
              {matchedFiles.map(file => (
                <div
                  key={file.id}
                  className="flex items-center gap-3 px-4 py-2.5 bg-white border border-gray-200 rounded-xl shadow-sm"
                >
                  <div className="text-gray-500">
                    {getFileIcon(file.filename)}
                  </div>
                  <span className="flex-1 text-sm text-gray-700 truncate min-w-0">
                    {file.filename}
                  </span>
                  <button
                    onClick={() => onViewFile!(file.id)}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-600 transition-colors"
                    title="View file"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onDownloadFile!(file.id)}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-green-600 transition-colors"
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
            <div className="bg-gray-100 rounded-3xl px-5 py-3 text-[15px] text-gray-900">
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

  // Assistant message - ChatGPT style full width
  return (
    <div className="mb-8">
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-4 h-4 text-white" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pt-1">
          <div className="prose prose-gray max-w-none">
            <ReactMarkdown
              components={{
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const codeString = String(children).replace(/\n$/, '');
                  const isInline = !match && !className;
                  const language = match ? match[1] : 'text';
                  const langLabel = languageIcons[language.toLowerCase()] || language.toUpperCase();

                  if (isInline) {
                    return (
                      <code className="bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-[13px] font-mono" {...props}>
                        {children}
                      </code>
                    );
                  }

                  // Bug 8 fix: Each code block gets its own index for copy state
                  const blockIndex = blockIndexRef.current++;
                  const isCopied = copiedBlocks.has(blockIndex);

                  return (
                    <div className="my-4 rounded-xl overflow-hidden bg-[#1e1e2e] border border-gray-800">
                      <div className="flex items-center justify-between px-4 py-2 bg-[#252535] border-b border-gray-800">
                        <div className="flex items-center gap-2 text-xs text-gray-400">
                          <Terminal className="w-3.5 h-3.5" />
                          <span className="font-medium">{langLabel}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => copyToClipboard(codeString, blockIndex)}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                          >
                            {isCopied ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
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
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
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
                            fontFamily: "'JetBrains Mono', 'Fira Code', 'Monaco', monospace",
                          }
                        }}
                      >
                        {codeString}
                      </SyntaxHighlighter>
                    </div>
                  );
                },
                p: ({ children }) => (
                  <p className="text-[15px] leading-7 text-gray-800 mb-4 last:mb-0">{children}</p>
                ),
                ul: ({ children }) => (
                  <ul className="my-4 space-y-2 list-none">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="my-4 space-y-2 list-none counter-reset-item">{children}</ol>
                ),
                li: ({ children }) => (
                  <li className="flex items-start gap-3 text-[15px] leading-7 text-gray-800">
                    <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-gray-400 mt-3" />
                    <span className="flex-1">{children}</span>
                  </li>
                ),
                h1: ({ children }) => (
                  <h1 className="text-xl font-semibold text-gray-900 mt-6 mb-4">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-lg font-semibold text-gray-900 mt-5 mb-3">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-base font-semibold text-gray-900 mt-4 mb-2">{children}</h3>
                ),
                strong: ({ children }) => (
                  <strong className="font-semibold text-gray-900">{children}</strong>
                ),
                em: ({ children }) => (
                  <em className="italic text-gray-700">{children}</em>
                ),
                a: ({ href, children }) => (
                  <a
                    href={href}
                    className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="my-4 pl-4 border-l-2 border-gray-300 text-gray-600 italic">
                    {children}
                  </blockquote>
                ),
                hr: () => <hr className="my-6 border-gray-200" />,
                table({ children }) {
                  return (
                    <div className="my-4 overflow-x-auto rounded-lg border border-gray-200">
                      <table className="min-w-full divide-y divide-gray-200">{children}</table>
                    </div>
                  );
                },
                thead: ({ children }) => (
                  <thead className="bg-gray-50">{children}</thead>
                ),
                tbody: ({ children }) => (
                  <tbody className="divide-y divide-gray-200 bg-white">{children}</tbody>
                ),
                tr: ({ children }) => <tr>{children}</tr>,
                th: ({ children }) => (
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                    {children}
                  </td>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
});

export default MessageBubble;
