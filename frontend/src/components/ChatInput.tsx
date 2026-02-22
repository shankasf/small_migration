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
  placeholder = "Ask anything",
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isFocused, setIsFocused] = useState(false);
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
    <div className="bg-gradient-to-t from-gray-50 to-white px-4 py-3">
      <div className="max-w-3xl mx-auto">
        {/* Selected files */}
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3 px-2">
            {selectedFiles.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${index}`}
                className="inline-flex items-center gap-2 px-3 py-2 bg-white text-gray-700 text-sm rounded-xl border border-gray-200 shadow-sm"
              >
                <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                {file.name.length > 25 ? file.name.slice(0, 25) + '...' : file.name}
                <button
                  onClick={() => removeFile(index)}
                  className="p-0.5 hover:bg-gray-100 rounded-full transition-colors"
                >
                  <X className="w-3.5 h-3.5 text-gray-400" />
                </button>
              </span>
            ))}
            <span className="text-xs text-gray-400 self-center">
              {selectedFiles.length}/{MAX_FILES}
            </span>
          </div>
        )}

        {/* Input container */}
        <div
          className={`
            relative flex items-end rounded-2xl border-2 transition-all duration-200
            ${disabled
              ? 'bg-gray-100 border-gray-200 opacity-60'
              : isFocused
                ? 'bg-white border-gray-300 shadow-lg shadow-gray-200/50'
                : 'bg-white border-gray-200 shadow-md shadow-gray-100/50 hover:border-gray-300 hover:shadow-lg'
            }
          `}
        >
          {/* Attach button */}
          <button
            onClick={() => !disabled && fileInputRef.current?.click()}
            disabled={disabled}
            className={`p-2.5 rounded-lg m-1 transition-all duration-200 ${
              disabled
                ? 'text-gray-300 cursor-not-allowed'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 active:scale-95'
            }`}
            title={`Attach files (${selectedFiles.length}/${MAX_FILES})`}
          >
            <Paperclip className="w-5 h-5" />
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
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={isTranscribing ? 'Transcribing...' : isRecording ? 'Listening...' : placeholder}
            disabled={disabled || isRecording}
            rows={1}
            className="flex-1 bg-transparent border-none outline-none resize-none text-[15px] text-gray-800 placeholder-gray-400 py-2.5 pr-2 min-h-[44px] max-h-[200px] leading-6"
          />

          {/* Right side buttons */}
          <div className="flex items-center gap-1 p-1">
            {/* Mic button */}
            <button
              onClick={handleMicClick}
              disabled={disabled || isTranscribing}
              className={`p-2 rounded-lg transition-all duration-200 ${
                isTranscribing
                  ? 'text-gray-300 cursor-not-allowed'
                  : isRecording
                    ? 'bg-red-500 text-white shadow-md animate-pulse hover:bg-red-600 active:scale-95'
                    : disabled
                      ? 'text-gray-300 cursor-not-allowed'
                      : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 active:scale-95'
              }`}
              title={isRecording ? 'Stop recording' : 'Voice input'}
            >
              {isRecording ? (
                <Square className="w-5 h-5" fill="currentColor" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
            </button>

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={`p-2 rounded-lg transition-all duration-200 ${
                canSend
                  ? 'bg-gradient-to-r from-gray-800 to-gray-900 text-white shadow-md hover:shadow-lg hover:from-gray-700 hover:to-gray-800 active:scale-95'
                  : 'bg-gray-100 text-gray-300 cursor-not-allowed'
              }`}
              title="Send message"
            >
              <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        {/* Helper text */}
        <p className="text-[11px] text-gray-400 text-center mt-3 tracking-wide">
          Callsphere migration agent can make mistakes, please verify responses manually.
        </p>
      </div>
    </div>
  );
}
