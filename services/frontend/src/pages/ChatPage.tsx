import { memo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Session, Message, UploadedFile, GeneratedOutput, Integration, IntegrationProvider, LibraryFile } from '../types';
import ChatArea from '../components/ChatArea';
import ChatInput from '../components/ChatInput';
import { LogEntry } from '../hooks/useRealtimeLogs';
import { CirciniMark } from '../components/Brand';

// Domain starters — one tap drops a real prompt into the composer, so a first
// run is a click away instead of a blank page.
const STARTERS: { label: string; hint: string; prompt: string }[] = [
  {
    label: 'Validate a mapping',
    hint: 'find gaps and type mismatches',
    prompt: 'Review my source-to-target mapping and flag any gaps or type mismatches.',
  },
  {
    label: 'Generate SQL',
    hint: 'from an agreed mapping',
    prompt: 'Generate a SQL migration script from the attached mapping. Ask me about any missing requirements before generating it.',
  },
  {
    label: 'Review and refine SQL',
    hint: 'explain and improve the draft',
    prompt: 'Review the generated SQL, explain its logic, and suggest any corrections before I test it.',
  },
];

interface ChatPageProps {
  session: Session | null;
  messages: Message[];
  uploadedFiles: UploadedFile[];
  messageOutputMap: Record<string, GeneratedOutput[]>;
  isLoading: boolean;
  isUploading?: boolean;
  uploadStatus?: string | null;
  errorMessage?: string | null;
  onSend: (message: string, files?: File[], fileRefs?: LibraryFile[]) => Promise<void>;
  onDownloadOutput: (output: GeneratedOutput) => void;
  onNewChat: () => void;
  realtimeLogs?: LogEntry[];
  onViewFile?: (fileId: string) => void;
  onDownloadFile?: (fileId: string) => void;
  integrations?: Integration[];
  onOpenIntegrations?: (provider?: IntegrationProvider) => void;
}

function WelcomeHero({
  subtitle,
  onPick,
  onSample,
  sampleLoading,
  sampleError,
}: {
  subtitle: string;
  onPick?: (prompt: string) => void;
  onSample?: () => void;
  sampleLoading?: boolean;
  sampleError?: string;
}) {
  return (
    <div className="flex w-full flex-col items-center text-center animate-fade-up">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-hairline bg-elevated text-brass shadow-console">
        <CirciniMark size={30} />
      </div>
      <h2 className="mb-2 font-display text-[1.7rem] font-700 tracking-tight text-ink text-balance">
        Where should we start?
      </h2>
      <p className="mb-8 max-w-sm text-sm text-muted">{subtitle}</p>

      {onPick && (
        <>
        <div className="grid w-full max-w-xl gap-2.5 sm:grid-cols-3">
          {STARTERS.map(s => (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s.prompt)}
              className="group flex flex-col rounded-xl border border-hairline bg-panel/70 p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-brass/40 hover:bg-elevated"
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <span className="text-[13.5px] font-500 leading-snug text-ink">{s.label}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-faint transition-colors group-hover:text-brass" />
              </div>
              <span className="text-xs text-faint">{s.hint}</span>
            </button>
          ))}
        </div>
        {onSample && (
          <button type="button" onClick={onSample} disabled={sampleLoading} className="mt-4 text-sm font-500 text-brass hover:text-brass-bright disabled:opacity-60">
            {sampleLoading ? 'Loading sample mapping…' : 'Try a sample mapping →'}
          </button>
        )}
        {sampleError && <p role="alert" className="mt-2 text-xs text-danger">{sampleError}</p>}
        </>
      )}
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
  integrations = [],
  onOpenIntegrations,
}: ChatPageProps) {
  const [prefill, setPrefill] = useState<{ text: string; nonce: number; file?: File }>({ text: '', nonce: 0 });
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState('');
  const pick = (prompt: string) => setPrefill({ text: prompt, nonce: Date.now() });
  const loadSample = async () => {
    setSampleLoading(true);
    setSampleError('');
    try {
      const response = await fetch('/samples/sample-mapping.csv');
      if (!response.ok) throw new Error('Sample mapping is unavailable. Please try again.');
      const content = await response.text();
      const file = new File([content], 'sample-mapping.csv', { type: 'text/csv' });
      setPrefill({ text: STARTERS[0].prompt, nonce: Date.now(), file });
    } catch {
      setSampleError('Could not load the sample mapping. Please try again.');
    } finally {
      setSampleLoading(false);
    }
  };

  // Welcome screen when no session
  if (!session) {
    return (
      <div className="relative flex-1 flex flex-col min-h-0 min-w-0 bg-obsidian">
        <div className="console-grid pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex-1 flex flex-col items-center justify-center gap-8 px-4">
          <WelcomeHero
            subtitle="Attach mapping spreadsheets, schemas/DDL, or SQL scripts, or ask a question. Spreadsheet layouts can vary."
            onPick={pick}
            onSample={loadSample}
            sampleLoading={sampleLoading}
            sampleError={sampleError}
          />
          <div className="w-full max-w-xl">
            <ChatInput onSend={onSend} disabled={false} placeholder="Ask anything..." prefill={prefill} integrations={integrations} onOpenIntegrations={onOpenIntegrations} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-obsidian">
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
          <div className="relative w-full max-w-xl">
            <WelcomeHero subtitle="Attach mapping spreadsheets, schemas/DDL, or SQL scripts, or ask a question. Spreadsheet layouts can vary." onPick={pick} onSample={loadSample} sampleLoading={sampleLoading} sampleError={sampleError} />
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
        prefill={prefill}
        integrations={integrations}
        onOpenIntegrations={onOpenIntegrations}
      />
    </div>
  );
});

export default ChatPage;
