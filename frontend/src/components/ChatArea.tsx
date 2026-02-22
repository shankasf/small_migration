import { useEffect, useRef, useState, useMemo, memo } from 'react';
import { Message, GeneratedOutput, UploadedFile } from '../types';
import MessageBubble from './MessageBubble';
import { Download, FileText, Sparkles } from 'lucide-react';
import { LogEntry } from '../hooks/useRealtimeLogs';

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  messageOutputMap?: Record<string, GeneratedOutput[]>;
  onDownloadOutput?: (output: GeneratedOutput) => void;
  realtimeLogs?: LogEntry[];
  uploadedFiles?: UploadedFile[];
  onViewFile?: (fileId: string) => void;
  onDownloadFile?: (fileId: string) => void;
}

const ChatArea = memo(function ChatArea({
  messages,
  isLoading,
  messageOutputMap = {},
  onDownloadOutput,
  realtimeLogs = [],
  uploadedFiles = [],
  onViewFile,
  onDownloadFile,
}: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [displayedThinking, setDisplayedThinking] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, displayedThinking]);

  // Get the latest "thinking" message
  const latestThinking = useMemo(() => {
    const thinkingLogs = realtimeLogs.filter(log => log.type === 'thinking');
    return thinkingLogs.length > 0 ? thinkingLogs[thinkingLogs.length - 1].message : null;
  }, [realtimeLogs]);

  useEffect(() => {
    if (latestThinking) {
      setDisplayedThinking(latestThinking);
    } else if (!isLoading) {
      setDisplayedThinking(null);
    }
  }, [latestThinking, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      const timer = setTimeout(() => setDisplayedThinking(null), 300);
      return () => clearTimeout(timer);
    }
  }, [isLoading]);

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {messages.map(message => {
          const msgOutputs = messageOutputMap[message.id];
          return (
            <div key={message.id}>
              <MessageBubble
                message={message}
                sessionFiles={uploadedFiles}
                onViewFile={onViewFile}
                onDownloadFile={onDownloadFile}
              />
              {/* Inline generated outputs for this message */}
              {msgOutputs && msgOutputs.length > 0 && onDownloadOutput && (
                <div className="mb-8 ml-12 flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 pt-1">
                    <p className="text-[15px] text-gray-800 mb-3">Generated files:</p>
                    <div className="flex flex-wrap gap-2">
                      {msgOutputs.map(output => (
                        <button
                          key={output.id}
                          onClick={() => onDownloadOutput(output)}
                          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-700 transition-colors"
                        >
                          <FileText className="w-4 h-4 text-gray-500" />
                          {output.filename}
                          <Download className="w-4 h-4 text-gray-400" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Thinking/Loading indicator */}
        {isLoading && (
          <div className="mb-8 flex items-start gap-4">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 pt-1">
              <div className="flex items-center gap-2 text-gray-600">
                <span className="text-[15px]">{displayedThinking || 'Thinking...'}</span>
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
});

export default ChatArea;
