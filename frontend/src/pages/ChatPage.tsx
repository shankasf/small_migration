import { memo } from 'react';
import { Session, Message, UploadedFile, GeneratedOutput } from '../types';
import ChatArea from '../components/ChatArea';
import ChatInput from '../components/ChatInput';
import { User, Sparkles } from 'lucide-react';
import { LogEntry } from '../hooks/useRealtimeLogs';

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
      <div className="flex-1 flex flex-col h-screen bg-white">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <div className="w-7" />
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-blue-600" />
            <h1 className="text-sm font-medium text-gray-800">CallSphere Migration Agent</h1>
          </div>
          <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center">
            <User className="w-3.5 h-3.5 text-gray-500" />
          </div>
        </header>

        {/* Center content */}
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-4 shadow-lg">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-xl font-medium text-gray-800 mb-1">
            What's on your mind today?
          </h2>
          <p className="text-xs text-gray-400 mb-6">
            Upload migration files or ask questions about your data migration
          </p>

          {/* Input */}
          <div className="w-full max-w-xl">
            <ChatInput
              onSend={onSend}
              disabled={false}
              placeholder="Ask anything..."
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-screen bg-white">
      {/* Minimal header */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <div className="w-7" />
        <div className="flex flex-col items-center">
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-blue-600" />
            <h1 className="text-sm font-medium text-gray-800">CallSphere Migration Agent</h1>
          </div>
          {uploadedFiles.length > 0 && (
            <span className="text-[10px] text-green-600 mt-0.5">
              {uploadedFiles.length} file{uploadedFiles.length > 1 ? 's' : ''} loaded
            </span>
          )}
        </div>
        <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center">
          <User className="w-3.5 h-3.5 text-gray-500" />
        </div>
      </header>

      {/* Chat area or welcome message */}
      {messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-3 shadow-md">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <h2 className="text-lg font-medium text-gray-700 mb-1">
            What's on your mind today?
          </h2>
          <p className="text-xs text-gray-400">
            Start by uploading files or asking a question
          </p>
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
        <div className={`px-4 py-2 text-center text-sm font-medium ${
          uploadStatus.includes('success') || uploadStatus.includes('Success')
            ? 'bg-green-50 text-green-700 border-t border-green-100'
            : uploadStatus.includes('error') || uploadStatus.includes('Error') || uploadStatus.includes('fail')
            ? 'bg-red-50 text-red-700 border-t border-red-100'
            : 'bg-blue-50 text-blue-700 border-t border-blue-100'
        }`}>
          {uploadStatus.includes('Uploading') && (
            <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-2 align-middle" />
          )}
          {uploadStatus}
        </div>
      )}

      {/* Error banner */}
      {errorMessage && (
        <div className="px-4 py-2 text-center text-sm font-medium bg-red-50 text-red-700 border-t border-red-100">
          {errorMessage}
        </div>
      )}

      {/* Chat input */}
      <ChatInput
        onSend={onSend}
        disabled={isLoading || isUploading}
        placeholder={isUploading ? "Please wait, uploading files..." : "Ask anything..."}
      />
    </div>
  );
});

export default ChatPage;
