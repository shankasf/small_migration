import { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import ChatPage from './pages/ChatPage';
import FilePreviewModal from './components/FilePreviewModal';
import { Session, Message, UploadedFile, GeneratedOutput } from './types';
import * as api from './services/api';
import { useRealtimeLogs } from './hooks/useRealtimeLogs';

// Associate generated outputs with the assistant message that produced them
function buildMessageOutputMap(
  msgs: Message[],
  outs: GeneratedOutput[]
): Record<string, GeneratedOutput[]> {
  const map: Record<string, GeneratedOutput[]> = {};
  if (!outs.length) return map;

  // Assistant messages sorted chronologically
  const assistantMsgs = msgs
    .filter(m => m.role === 'assistant')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const output of outs) {
    const outputTime = new Date(output.createdAt).getTime();
    // Find the last assistant message created at or before the output
    let matched: Message | null = null;
    for (const msg of assistantMsgs) {
      if (new Date(msg.createdAt).getTime() <= outputTime) {
        matched = msg;
      } else {
        break;
      }
    }
    if (matched) {
      if (!map[matched.id]) map[matched.id] = [];
      map[matched.id].push(output);
    }
  }
  return map;
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [_outputs, setOutputs] = useState<GeneratedOutput[]>([]);
  const [messageOutputMap, setMessageOutputMap] = useState<Record<string, GeneratedOutput[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{ filename: string; content: string } | null>(null);

  // Real-time logs from WebSocket (path: /api/socket.io)
  const { logs: realtimeLogs, clearLogs } = useRealtimeLogs(activeSession?.id || null);

  // Load sessions on mount
  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.getSessions();
      setSessions(data.sessions);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const session = await api.getSession(sessionId);
      setActiveSession(session);
      setMessages(session.messages || []);
      setUploadedFiles(session.files || []);
      setOutputs(session.outputs || []);
      setMessageOutputMap(
        buildMessageOutputMap(session.messages || [], session.outputs || [])
      );
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  }, []);

  const createNewSession = useCallback(async (): Promise<Session | null> => {
    try {
      const session = await api.createSession();
      setSessions(prev => [session, ...prev]);
      setActiveSession(session);
      setMessages([]);
      setUploadedFiles([]);
      setOutputs([]);
      setMessageOutputMap({});
      return session;
    } catch (error) {
      console.error('Failed to create session:', error);
      return null;
    }
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      setActiveSession(prev => {
        if (prev?.id === sessionId) {
          setMessages([]);
          setUploadedFiles([]);
          setOutputs([]);
          setMessageOutputMap({});
          return null;
        }
        return prev;
      });
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  }, []);

  const selectSession = useCallback((session: Session) => {
    loadSession(session.id);
  }, [loadSession]);

  // Unified send handler - handles message with optional files
  const handleSend = useCallback(async (message: string, files?: File[]) => {
    console.log(`[SEND] handleSend called: message="${message.slice(0, 50)}...", files=${files?.length || 0}`);

    // Determine which session to use
    let session: Session | null = null;
    // Use functional getter for activeSession to avoid stale closure
    setActiveSession(prev => { session = prev; return prev; });

    console.log(`[SEND] Active session: ${session?.id || 'none'}`);

    // If no active session, create one
    if (!session) {
      console.log('[SEND] No active session, creating new one...');
      session = await createNewSession();
      if (!session) {
        console.error('[SEND] Failed to create session, aborting');
        return;
      }
      console.log(`[SEND] Created session: ${session.id}`);
    }

    const hasFiles = files && files.length > 0;
    const hasMessage = message.trim().length > 0;

    console.log(`[SEND] hasFiles=${hasFiles}, hasMessage=${hasMessage}`);

    // If nothing to send, return
    if (!hasFiles && !hasMessage) {
      console.log('[SEND] Nothing to send, returning');
      return;
    }

    // Upload files first if present
    if (hasFiles) {
      console.log(`[SEND] Uploading ${files.length} files to session ${session.id}...`);
      setIsUploading(true);
      setUploadStatus(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`);

      try {
        const uploadResponse = await api.uploadFiles(session.id, files);
        console.log('[SEND] Upload succeeded:', uploadResponse);
        setUploadedFiles(prev => {
          const existingIds = new Set(prev.map(f => f.id));
          const newFiles = uploadResponse.files.filter((f: UploadedFile) => !existingIds.has(f.id));
          return [...prev, ...newFiles];
        });

        const fileNames = uploadResponse.files.map((f: UploadedFile) => f.filename).join(', ');
        setUploadStatus(`Uploaded: ${fileNames}`);

        setTimeout(() => {
          setUploadStatus(null);
          setIsUploading(false);
        }, 2000);
      } catch (error) {
        console.error('[SEND] Failed to upload files:', error);
        setUploadStatus('Upload failed');
        setTimeout(() => {
          setUploadStatus(null);
          setIsUploading(false);
        }, 3000);
        return;
      }
    }

    // Prepare the message content
    let messageContent = message.trim();
    if (hasFiles && !hasMessage) {
      const fileNames = files.map(f => f.name).join(', ');
      messageContent = `[Attached: ${fileNames}]\n\nPlease analyze the uploaded files.`;
    } else if (hasFiles && hasMessage) {
      const fileNames = files.map(f => f.name).join(', ');
      messageContent = `[Attached: ${fileNames}]\n\n${message.trim()}`;
    }

    console.log(`[SEND] Sending message to AI: "${messageContent.slice(0, 100)}..."`);

    // Add user message optimistically
    const userMessage: Message = {
      id: `temp-${Date.now()}`,
      sessionId: session.id,
      role: 'user',
      content: messageContent,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    clearLogs();

    try {
      const response = await api.sendMessage(session.id, messageContent);

      // Update messages with real data
      setMessages(prev => [
        ...prev.filter(m => m.id !== userMessage.id),
        response.userMessage,
        response.assistantMessage,
      ]);

      // Use savedOutputs from response directly (no extra API call)
      const outputs = response.savedOutputs;
      if (outputs && outputs.length > 0) {
        setOutputs(prev => {
          const existingIds = new Set(prev.map(o => o.id));
          const newOuts = outputs.filter(
            (o: GeneratedOutput) => !existingIds.has(o.id)
          );
          return [...prev, ...newOuts];
        });
        setMessageOutputMap(prev => ({
          ...prev,
          [response.assistantMessage.id]: outputs,
        }));
      }

      // Update the single session in-place instead of refetching all sessions
      const updatedSession = response.updatedSession;
      if (updatedSession) {
        setSessions(prev => {
          const updated = prev.map(s =>
            s.id === updatedSession.id
              ? { ...s, name: updatedSession.name, updatedAt: updatedSession.updatedAt }
              : s
          );
          return updated.sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
        });
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      setMessages(prev => prev.filter(m => m.id !== userMessage.id));
      const errMsg = error instanceof Error ? error.message : 'Something went wrong';
      setErrorMessage(`Failed to get a response: ${errMsg}`);
      setTimeout(() => setErrorMessage(null), 8000);
    } finally {
      setIsLoading(false);
    }
  }, [createNewSession, clearLogs]);

  const downloadOutput = useCallback(async (output: GeneratedOutput) => {
    try {
      const blob = await api.downloadOutput(output.id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = output.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download output:', error);
    }
  }, []);

  const handleViewFile = useCallback(async (fileId: string) => {
    try {
      const data = await api.getUploadedFileContent(fileId);
      setPreviewFile(data);
    } catch (error) {
      console.error('Failed to get file content:', error);
    }
  }, []);

  const handleDownloadFile = useCallback(async (fileId: string) => {
    try {
      const blob = await api.downloadUploadedFile(fileId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // We don't know the filename here without reading state, but the
      // Content-Disposition header on the download endpoint handles it
      a.download = 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download file:', error);
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  return (
    <div className="flex h-screen bg-white">
      <Sidebar
        sessions={sessions}
        activeSession={activeSession}
        isOpen={sidebarOpen}
        onToggle={toggleSidebar}
        onNewChat={createNewSession}
        onSelectSession={selectSession}
        onDeleteSession={deleteSession}
      />
      <ChatPage
        session={activeSession}
        messages={messages}
        uploadedFiles={uploadedFiles}
        messageOutputMap={messageOutputMap}
        isLoading={isLoading}
        isUploading={isUploading}
        uploadStatus={uploadStatus}
        errorMessage={errorMessage}
        onSend={handleSend}
        onDownloadOutput={downloadOutput}
        onNewChat={createNewSession}
        realtimeLogs={realtimeLogs}
        onViewFile={handleViewFile}
        onDownloadFile={handleDownloadFile}
      />

      {/* File preview modal */}
      {previewFile && (
        <FilePreviewModal
          filename={previewFile.filename}
          content={previewFile.content}
          onClose={() => setPreviewFile(null)}
          onDownload={() => {
            const blob = new Blob([previewFile.content], { type: 'text/plain' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = previewFile.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
          }}
        />
      )}
    </div>
  );
}

export default App;
