import { memo } from 'react';
import { Session, Message, UploadedFile, GeneratedOutput } from '../types';
import ChatArea from '../components/ChatArea';
import ChatInput from '../components/ChatInput';
import { LogEntry } from '../hooks/useRealtimeLogs';
import { CirciniMark } from '../components/Brand';

interface ChatPageProps {
  session: Session | null;
  messages: Message[];
  uploadedFiles: UploadedFile[];
  messageOutputMap: Record<string, GeneratedOutput[]>;
  isLoading: boolean;
  isUploading?: boolean;
  uploadStatus?: string | null;
  errorMessage?: string | null;
  onSend: (message: string, files?: File[]) => void;
  onDownloadOutput: (output: GeneratedOutput) => void;
  onNewChat: () => void;
  realtimeLogs?: LogEntry[];
  onViewFile?: (fileId: string) => void;
  onDownloadFile?: (fileId: string) => void;
}

function WelcomeHero({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex flex-col items-center text-center animate-fade-up">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-hairline bg-elevated text-brass shadow-console">
        <CirciniMark size={30} />
      </div>
      <h2 className="font-display text-2xl font-700 tracking-tight text-ink mb-2 text-balance">
        What&rsquo;s on your mind today?
      </h2>
      <p className="text-sm text-muted mb-8 max-w-sm">{subtitle}</p>
    </div>
  );
}

const ChatPage = memo(function ChatPage({
  session,
  messages,
  uploadedFiles,
  messageOutputMap,
  isLoading,
  isUploading = false,
  uploadStatus = null,
  errorMessage = null,
  onSend,
  onDownloadOutput,
  onNewChat: _onNewChat,
  realtimeLogs = [],
  onViewFile,
  onDownloadFile,
}: ChatPageProps) {
  // Welcome screen when no session
  if (!session) {
    return (
      <div className="relative flex-1 flex flex-col min-h-0 bg-obsidian">
        <div className="console-grid pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex-1 flex flex-col items-center justify-center px-4">
          <WelcomeHero subtitle="Upload migration files or ask questions about your data migration" />
          <div className="w-full max-w-xl">
            <ChatInput onSend={onSend} disabled={false} placeholder="Ask anything..." />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-obsidian">
      {/* Minimal header */}
      <header className="flex items-center justify-center px-4 py-2 border-b border-hairline bg-panel/60">
        <div className="flex flex-col items-center">
          <span className="eyebrow">{session.name && !session.name.startsWith('[Attached') ? 'Session' : 'Session'}</span>
          {uploadedFiles.length > 0 && (
            <span className="text-[10px] font-mono text-success mt-0.5">
              {uploadedFiles.length} file{uploadedFiles.length > 1 ? 's' : ''} loaded
            </span>
          )}
        </div>
      </header>

      {/* Chat area or welcome message */}
      {messages.length === 0 ? (
        <div className="relative flex-1 flex flex-col items-center justify-center px-4">
          <div className="console-grid pointer-events-none absolute inset-0 opacity-60" />
          <div className="relative">
            <WelcomeHero subtitle="Start by uploading files or asking a question" />
          </div>
        </div>
      ) : (
        <ChatArea
          messages={messages}
          isLoading={isLoading}
          messageOutputMap={messageOutputMap}
          onDownloadOutput={onDownloadOutput}
          realtimeLogs={realtimeLogs}
          uploadedFiles={uploadedFiles}
          onViewFile={onViewFile}
          onDownloadFile={onDownloadFile}
        />
      )}

      {/* Upload status banner */}
      {uploadStatus && (
        <div
          className={`px-4 py-2 text-center text-sm font-medium border-t ${
            uploadStatus.includes('success') || uploadStatus.includes('Success') || uploadStatus.includes('Uploaded')
              ? 'bg-success/10 text-success border-success/20'
              : uploadStatus.includes('error') || uploadStatus.includes('Error') || uploadStatus.includes('fail')
                ? 'bg-danger/10 text-danger border-danger/20'
                : 'bg-signal/10 text-signal border-signal/20'
          }`}
        >
          {uploadStatus.includes('Uploading') && (
            <span className="inline-block w-4 h-4 border-2 border-signal border-t-transparent rounded-full animate-spin mr-2 align-middle" />
          )}
          {uploadStatus}
        </div>
      )}

      {/* Error banner */}
      {errorMessage && (
        <div className="px-4 py-2 text-center text-sm font-medium bg-danger/10 text-danger border-t border-danger/20">
          {errorMessage}
        </div>
      )}

      {/* Chat input */}
      <ChatInput
        onSend={onSend}
        disabled={isLoading || isUploading}
        placeholder={isUploading ? 'Please wait, uploading files...' : 'Ask anything...'}
      />
    </div>
  );
});

export default ChatPage;
