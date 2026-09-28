import { useEffect, useRef, useState, useMemo, memo } from 'react';
import { Message, GeneratedOutput, UploadedFile } from '../types';
import MessageBubble from './MessageBubble';
import { Download, FileText } from 'lucide-react';
import { LogEntry } from '../hooks/useRealtimeLogs';
import { CirciniMark } from './Brand';

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

  // Get the latest "thinking" message
  const latestThinking = useMemo(() => {
    const thinkingLogs = realtimeLogs.filter(log => log.type === 'thinking');
    return thinkingLogs.length > 0 ? thinkingLogs[thinkingLogs.length - 1].message : null;
  }, [realtimeLogs]);

  // Accumulated partial response streamed from the model this turn
  const streamingText = useMemo(
    () => realtimeLogs.filter(log => log.type === 'delta').map(log => log.message).join(''),
    [realtimeLogs]
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, displayedThinking, streamingText]);

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
    <div className="flex-1 overflow-y-auto bg-obsidian">
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
                <div className="mb-8 ml-0 sm:ml-12 flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full border border-success/40 bg-success/10 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-4 h-4 text-success" />
                  </div>
                  <div className="flex-1 pt-1">
                    <p className="text-[15px] text-ink/90 mb-3">Files in this reply:</p>
                    <div className="flex flex-wrap gap-2">
                      {msgOutputs.map(output => (
                        <button
                          key={output.id}
                          onClick={() => onDownloadOutput(output)}
                          className="inline-flex items-center gap-2 px-4 py-2 bg-elevated hover:bg-raised border border-hairline hover:border-hairline-strong rounded-lg text-sm text-ink transition-colors"
                        >
                          <FileText className="w-4 h-4 text-brass" />
                          {output.filename}
                          <Download className="w-4 h-4 text-faint" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Live streamed response (replaced by the final message on completion) */}
        {isLoading && streamingText && (
          <MessageBubble
            message={{
              id: '__streaming__',
              sessionId: '',
              role: 'assistant',
              content: streamingText,
              createdAt: realtimeLogs.find(log => log.type === 'delta')!.timestamp,
            }}
            showFeedback={false}
          />
        )}

        {/* Thinking/Loading indicator */}
        {isLoading && !streamingText && (
          <div className="mb-8 flex items-start gap-4">
            <div className="w-8 h-8 rounded-full border border-hairline bg-elevated flex items-center justify-center flex-shrink-0 text-brass">
              <CirciniMark size={18} />
            </div>
            <div className="flex-1 pt-1">
              <div className="flex items-center gap-2 text-muted">
                <span className="text-[15px]">{displayedThinking || 'Thinking...'}</span>
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-brass animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-brass animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-brass animate-bounce" style={{ animationDelay: '300ms' }} />
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
