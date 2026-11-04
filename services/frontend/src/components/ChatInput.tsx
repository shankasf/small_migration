import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import { ArrowUp, AtSign, Check, ChevronRight, FilePlus2, Mic, Plus, Square, X } from 'lucide-react';
import * as api from '../services/api';
import { Integration, IntegrationProvider, LibraryFile } from '../types';
import FileLibraryPicker from './FileLibraryPicker';
import FileReferenceChips from './FileReferenceChips';
import { INTEGRATION_PROVIDERS } from '../integrationCatalog';

const MAX_FILES = 10;

interface ChatInputProps {
  onSend: (message: string, files?: File[], fileRefs?: LibraryFile[]) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  /** Prefill the composer from an external action (e.g. a starter card).
   *  nonce forces re-application even when the same text is picked twice. */
  prefill?: { text: string; nonce: number; file?: File };
  integrations?: Integration[];
  onOpenIntegrations?: (provider?: IntegrationProvider) => void;
}

export default function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Ask anything',
  prefill,
  integrations = [],
  onOpenIntegrations,
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedRefs, setSelectedRefs] = useState<LibraryFile[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const mentionPosition = useRef<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // Ref mirrors selectedFiles to avoid stale closures during rapid re-renders
  const filesRef = useRef<File[]>([]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!plusMenuRef.current?.contains(event.target as Node)) setPlusMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPlusMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [plusMenuOpen]);

  const closeLibrary = useCallback(() => {
    setLibraryOpen(false);
    textareaRef.current?.focus();
  }, []);

  const toggleReference = (file: LibraryFile) => {
    setSelectedRefs(previous => previous.some(item => item.id === file.id)
      ? previous.filter(item => item.id !== file.id)
      : previous.length < MAX_FILES ? [...previous, file] : previous);
    const position = mentionPosition.current;
    if (position !== null) {
      setMessage(previous => previous[position] === '@' ? previous.slice(0, position) + previous.slice(position + 1) : previous);
      mentionPosition.current = null;
    }
  };

  const handleSend = async () => {
    const files = [...filesRef.current];
    if (disabled || sendingRef.current || !(message.trim() || files.length || selectedRefs.length)) return;
    const draft = message;
    const references = [...selectedRefs];
    sendingRef.current = true;
    setSending(true);
    setSendError('');
    setMessage('');
    filesRef.current = [];
    setSelectedFiles([]);
    setSelectedRefs([]);
    try {
      await onSend(draft.trim(), files.length ? files : undefined, references);
    } catch (error) {
      setMessage(draft);
      filesRef.current = files;
      setSelectedFiles(files);
      setSelectedRefs(references);
      setSendError(api.apiErrorMessage(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  // Apply an external prefill and focus the composer so the user can edit,
  // attach a file, or press Enter to send.
  useEffect(() => {
    if (!prefill || !prefill.text) return;
    setMessage(prefill.text);
    if (prefill.file) {
      const sampleFile = prefill.file;
      const existing = filesRef.current.filter(file => file.name !== sampleFile.name);
      const updated = [...existing.slice(0, MAX_FILES - 1), sampleFile];
      filesRef.current = updated;
      setSelectedFiles(updated);
    }
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      const end = prefill.text.length;
      ta.setSelectionRange(end, end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
    const cursor = e.target.selectionStart;
    if (e.target.value[cursor - 1] === '@' && (cursor === 1 || /\s/.test(e.target.value[cursor - 2]))) {
      mentionPosition.current = cursor - 1;
      setLibraryOpen(true);
    }
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

  const canSend = (message.trim() || selectedFiles.length > 0 || selectedRefs.length > 0) && !disabled && !sending;

  return (
    <div className="relative z-30 bg-obsidian px-4 py-3">
      <div className="max-w-3xl mx-auto">
        {sendError && <p role="alert" className="mb-2 text-sm text-danger">{sendError} Your draft and selected files have been restored.</p>}
        <FileReferenceChips files={selectedRefs.map(file => ({ ...file, assetId: file.id }))} onRemove={id => setSelectedRefs(previous => previous.filter(file => file.id !== id))} label="Selected files · exact versions" />
        {libraryOpen && <FileLibraryPicker selected={selectedRefs} onToggle={toggleReference} onClose={closeLibrary} />}
        {/* Selected files */}
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3 px-2">
            {selectedFiles.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${index}`}
                className="chip !text-ink max-w-full"
              >
                <span className="w-2 h-2 rounded-full bg-brass"></span>
                <span className="min-w-0 break-words">{file.name}</span>
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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,.tsv,.xlsx,.xls,.txt,.sql,.ddl,.json,.xml,.md,.py,.js,.ts,.yaml,.yml,.log"
            onChange={handleFileSelect}
            className="hidden"
            disabled={disabled || sending}
          />

          {/* Add menu — files and connected data tools live in one predictable place. */}
          <div className="relative shrink-0" ref={plusMenuRef}>
            <button
              type="button"
              onClick={() => !disabled && !sending && setPlusMenuOpen(open => !open)}
              disabled={disabled || sending}
              className={`flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-600 transition-all ${
                disabled
                  ? 'cursor-not-allowed border-hairline bg-elevated text-faint'
                  : plusMenuOpen
                    ? 'border-brass/50 bg-brass/10 text-brass'
                    : 'border-hairline bg-elevated text-ink hover:border-brass/50 hover:text-brass'
              }`}
              title="Attach metadata or connect a service"
              aria-label="Attach metadata or connect a service"
              aria-expanded={plusMenuOpen}
            >
              <Plus className={`h-4 w-4 transition-transform ${plusMenuOpen ? 'rotate-45' : ''}`} />
              <span>Attach Metadata</span>
            </button>

            {plusMenuOpen && (
              <div className="absolute bottom-full left-0 z-40 mb-3 w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-hairline bg-panel shadow-console animate-fade-up">
                <div className="border-b border-hairline px-4 py-3">
                  <p className="text-sm font-600 text-ink">Add context</p>
                  <p className="mt-0.5 text-xs text-faint">Find existing files, upload, or connect a workspace</p>
                </div>

                <div className="p-2">
                  <button type="button" onClick={() => { setPlusMenuOpen(false); mentionPosition.current = null; setLibraryOpen(true); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-elevated">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brass/10 text-brass"><AtSign className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-500 text-ink">My Files</span><span className="block text-[11px] text-faint">Reuse uploads and generated files from any chat</span></span>
                    <span className="font-mono text-xs text-faint">@</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-elevated"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brass/10 text-brass"><FilePlus2 className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-500 text-ink">Upload metadata</span><span className="block text-[11px] text-faint">Mappings (CSV/Excel), schemas/DDL, SQL and more</span></span>
                    <span className="font-mono text-[10px] text-faint">{selectedFiles.length}/{MAX_FILES}</span>
                  </button>
                </div>

                <div className="border-t border-hairline px-3 pb-2 pt-3">
                  <div className="mb-1 flex items-center justify-between px-2">
                    <span className="eyebrow">Integrations</span>
                    <button type="button" onClick={() => { setPlusMenuOpen(false); onOpenIntegrations?.(); }} className="text-[11px] font-500 text-brass hover:text-brass-bright">Manage</button>
                  </div>
                  {INTEGRATION_PROVIDERS.map(provider => {
                    const connection = integrations.find(item => item.provider === provider.id);
                    const connected = connection?.status === 'connected';
                    const Icon = provider.icon;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => { setPlusMenuOpen(false); onOpenIntegrations?.(provider.id); }}
                        className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-elevated"
                      >
                        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${provider.surface} ${provider.accent}`}><Icon className="h-4 w-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-500 text-ink">{provider.name}</span>
                          <span className={`flex items-center gap-1.5 text-[10px] ${connected ? 'text-success' : 'text-faint'}`}>
                            {connected && <Check className="h-3 w-3" />}{connected ? (connection?.displayName || 'Connected') : 'Not connected'}
                          </span>
                        </span>
                        {connected ? (
                          <span className="rounded-md border border-success/20 bg-success/10 px-2 py-1 text-[10px] font-600 text-success">Connected</span>
                        ) : (
                          <span className="flex items-center gap-0.5 text-[11px] font-600 text-brass transition-colors group-hover:text-brass-bright">Connect <ChevronRight className="h-3 w-3" /></span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Text input */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={isTranscribing ? 'Transcribing...' : isRecording ? 'Listening...' : placeholder}
            disabled={disabled || sending || isRecording}
            rows={1}
            className="max-h-40 min-h-[40px] min-w-0 flex-1 resize-none self-center bg-transparent px-2 py-2 text-[15px] text-ink placeholder:text-faint focus:outline-none"
            style={{ boxShadow: 'none' }}
          />

          {/* Mic button */}
          <button
            onClick={handleMicClick}
            disabled={true}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${
              isTranscribing
                ? 'bg-raised text-faint cursor-not-allowed'
                : isRecording
                  ? 'bg-danger text-white animate-pulse hover:bg-danger/80'
                  : disabled
                    ? 'bg-raised text-faint cursor-not-allowed'
                    : 'bg-raised text-muted hover:text-ink'
            }`}
            title="Voice is unavailable until an approved transcription service is configured" aria-label="Voice input unavailable"
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
          Type @ to reuse a file from any chat. Use metadata and synthetic examples only. Do not upload personal or patient data. Generated SQL is a draft and requires review and testing.
        </p>
      </div>
    </div>
  );
}
