import { useState, useRef, useCallback, KeyboardEvent } from 'react';
import { ArrowUp, Paperclip, X, Mic, Square } from 'lucide-react';
import * as api from '../services/api';

const MAX_FILES = 10;

interface ChatInputProps {
  onSend: (message: string, files?: File[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export default function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Ask anything',
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // Ref mirrors selectedFiles to avoid stale closures during rapid re-renders
  const filesRef = useRef<File[]>([]);

  const handleSend = () => {
    const files = filesRef.current;
    if (!disabled && (message.trim() || files.length > 0)) {
      onSend(message.trim(), files.length > 0 ? [...files] : undefined);
      setMessage('');
      filesRef.current = [];
      setSelectedFiles([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const newFiles = Array.from(fileList);
    const current = filesRef.current;
    const remaining = MAX_FILES - current.length;

    if (remaining <= 0) {
      alert(`Maximum ${MAX_FILES} files allowed. Remove some files first.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const filesToAdd = newFiles.slice(0, remaining);
    if (filesToAdd.length < newFiles.length) {
      alert(`Only ${remaining} more file(s) can be added (max ${MAX_FILES}).`);
    }

    // Update ref first (synchronous, immediate), then sync to state
    const updated = [...current, ...filesToAdd];
    filesRef.current = updated;
    setSelectedFiles(updated);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (index: number) => {
    const updated = filesRef.current.filter((_, i) => i !== index);
    filesRef.current = updated;
    setSelectedFiles(updated);
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(t => t.stop());

        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size < 100) return; // Too short, ignore

        setIsTranscribing(true);
        try {
          const result = await api.transcribeAudio(audioBlob);
          if (result.text) {
            setMessage(prev => {
              const separator = prev && !prev.endsWith(' ') ? ' ' : '';
              return prev + separator + result.text;
            });
            // Auto-resize textarea
            setTimeout(() => {
              if (textareaRef.current) {
                textareaRef.current.style.height = 'auto';
                textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
              }
            }, 0);
          }
        } catch (error) {
          console.error('Transcription failed:', error);
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  const handleMicClick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const canSend = (message.trim() || selectedFiles.length > 0) && !disabled;

  return (
    <div className="bg-obsidian px-4 py-3">
      <div className="max-w-3xl mx-auto">
        {/* Selected files */}
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3 px-2">
            {selectedFiles.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${index}`}
                className="chip !text-ink"
              >
                <span className="w-2 h-2 rounded-full bg-brass"></span>
                {file.name.length > 25 ? file.name.slice(0, 25) + '...' : file.name}
                <button
                  onClick={() => removeFile(index)}
                  className="p-0.5 hover:bg-raised rounded-full transition-colors"
                >
                  <X className="w-3.5 h-3.5 text-faint" />
                </button>
              </span>
            ))}
            <span className="text-xs font-mono text-faint self-center">
              {selectedFiles.length}/{MAX_FILES}
            </span>
          </div>
        )}

        {/* Input container — flat pill, focus shown via border (matches circini) */}
        <div
          className={`flex items-end gap-1.5 rounded-[26px] border border-hairline bg-panel px-2 py-2 shadow-console transition-colors focus-within:border-brass/50 ${
            disabled ? 'opacity-60' : ''
          }`}
        >
          {/* Attach button */}
          <button
            onClick={() => !disabled && fileInputRef.current?.click()}
            disabled={disabled}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-hairline bg-elevated transition-colors ${
              disabled
                ? 'text-faint cursor-not-allowed'
                : 'text-ink hover:border-brass/50 hover:text-brass'
            }`}
            title={`Attach files (${selectedFiles.length}/${MAX_FILES})`}
          >
            <Paperclip className="h-5 w-5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,.xlsx,.xls,.txt,.sql,.json,.xml,.md,.py,.js,.ts,.yaml,.yml,.log"
            onChange={handleFileSelect}
            className="hidden"
            disabled={disabled}
          />

          {/* Text input */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={isTranscribing ? 'Transcribing...' : isRecording ? 'Listening...' : placeholder}
            disabled={disabled || isRecording}
            rows={1}
            className="max-h-40 min-h-[40px] flex-1 resize-none self-center bg-transparent px-2 py-2 text-[15px] text-ink placeholder:text-faint focus:outline-none"
            style={{ boxShadow: 'none' }}
          />

          {/* Mic button */}
          <button
            onClick={handleMicClick}
            disabled={disabled || isTranscribing}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${
              isTranscribing
                ? 'bg-raised text-faint cursor-not-allowed'
                : isRecording
                  ? 'bg-danger text-white animate-pulse hover:bg-danger/80'
                  : disabled
                    ? 'bg-raised text-faint cursor-not-allowed'
                    : 'bg-raised text-muted hover:text-ink'
            }`}
            title={isRecording ? 'Stop recording' : 'Voice input'}
          >
            {isRecording ? (
              <Square className="h-4 w-4" fill="currentColor" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brass text-obsidian transition-all hover:bg-brass-bright disabled:opacity-40"
            title="Send message"
          >
            <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>

        {/* Helper text */}
        <p className="text-[11px] text-faint text-center mt-3 tracking-wide">
          Circini migration agent can make mistakes, please verify responses manually. Powered by{' '}
          <a
            href="https://callsphere.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brass-bright underline underline-offset-2 hover:text-brass transition-colors"
          >
            Callsphere LLC
          </a>
          .
        </p>
      </div>
    </div>
  );
}
