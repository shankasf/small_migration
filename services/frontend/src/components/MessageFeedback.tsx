import { useEffect, useRef, useState } from 'react';
import { ThumbsUp, ThumbsDown, MessageSquarePlus, Check, Loader2 } from 'lucide-react';
import type { FeedbackRating, MessageFeedback as Feedback } from '../types';
import { rateMessage, clearMessageRating, apiErrorMessage } from '../services/api';
import { cx } from './ui';

const MAX_NOTE_CHARS = 2000;

interface MessageFeedbackProps {
  messageId: string;
  initial?: Feedback | null;
}

const RATING_LABELS: Record<FeedbackRating, string> = {
  up: 'Helpful response',
  down: 'Unhelpful response',
};

/**
 * Per-response rating: two thumbs and, only if the reader wants to say more,
 * a note. The thumb saves on click and stands on its own — the note is never
 * required, never blocks the rating, and can be added, edited or removed later.
 */
export default function MessageFeedback({ messageId, initial }: MessageFeedbackProps) {
  const [rating, setRating] = useState<FeedbackRating | null>(initial?.rating ?? null);
  const [note, setNote] = useState<string | null>(initial?.note ?? null);
  const [draft, setDraft] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // A thumbs down is the one case worth asking "why?" unprompted — and only
  // the first time, so dismissing the box is respected.
  const invited = useRef(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteFieldId = `feedback-note-${messageId}`;

  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const flashConfirmation = () => {
    setConfirmed(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmed(false), 2600);
  };

  const choose = async (next: FeedbackRating) => {
    if (saving) return;
    const previous = { rating, note };
    const clearing = rating === next;
    setError(null);
    setSaving(true);
    setRating(clearing ? null : next);
    if (clearing) {
      setNote(null);
      setComposerOpen(false);
    }
    try {
      if (clearing) {
        await clearMessageRating(messageId);
      } else {
        const saved = await rateMessage(messageId, next);
        setNote(saved.note);
        flashConfirmation();
        if (next === 'down' && !saved.note && !invited.current) {
          invited.current = true;
          setDraft('');
          setComposerOpen(true);
        }
      }
    } catch (err) {
      setRating(previous.rating);
      setNote(previous.note);
      setError(apiErrorMessage(err, 'Could not save your rating'));
    } finally {
      setSaving(false);
    }
  };

  const openComposer = () => {
    setDraft(note ?? '');
    setError(null);
    setComposerOpen(true);
  };

  const saveNote = async (value: string) => {
    if (!rating) return;
    setNoteSaving(true);
    setError(null);
    try {
      const saved = await rateMessage(messageId, rating, value);
      setNote(saved.note);
      setComposerOpen(false);
      flashConfirmation();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save your note'));
    } finally {
      setNoteSaving(false);
    }
  };

  const thumbCls = (value: FeedbackRating) =>
    cx(
      'flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
      'disabled:opacity-60',
      rating === value
        ? value === 'up'
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-warn/40 bg-warn/10 text-warn'
        : 'border-transparent text-faint hover:border-hairline hover:bg-elevated hover:text-ink',
    );

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {(['up', 'down'] as const).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            disabled={saving}
            aria-pressed={rating === value}
            aria-label={RATING_LABELS[value]}
            title={rating === value ? 'Undo this rating' : RATING_LABELS[value]}
            className={thumbCls(value)}
          >
            {value === 'up' ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
          </button>
        ))}

        {rating && !composerOpen && (
          <button
            type="button"
            onClick={openComposer}
            className="ml-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-faint transition-colors hover:bg-elevated hover:text-ink"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {note ? 'Edit note' : 'Add a note'}
            <span className="text-faint/70">(optional)</span>
          </button>
        )}

        {confirmed && !composerOpen && (
          <span className="inline-flex items-center gap-1 text-xs text-success animate-fade-in">
            <Check className="h-3.5 w-3.5" /> Thanks for the feedback
          </span>
        )}
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-faint" />}
      </div>

      {note && !composerOpen && (
        <p className="mt-2 max-w-xl border-l-2 border-hairline pl-3 text-xs italic text-muted">
          “{note}”
        </p>
      )}

      {composerOpen && (
        <div className="mt-2 max-w-xl rounded-xl border border-hairline bg-panel p-3 animate-fade-in">
          <label htmlFor={noteFieldId} className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-500 text-ink/90">
              {rating === 'down' ? 'What went wrong?' : 'What worked well?'}
            </span>
            <span className="text-[11px] text-faint">Optional</span>
          </label>
          <textarea
            id={noteFieldId}
            className="field min-h-[72px] text-[13px]"
            autoFocus
            rows={3}
            maxLength={MAX_NOTE_CHARS}
            value={draft}
            placeholder="Add any detail that would help us improve this…"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') setComposerOpen(false);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveNote(draft.trim());
            }}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[11px] tabular-nums text-faint">
              {draft.length}/{MAX_NOTE_CHARS}
            </span>
            <div className="flex items-center gap-2">
              {note && (
                <button
                  type="button"
                  onClick={() => void saveNote('')}
                  disabled={noteSaving}
                  className="rounded-md px-2 py-1 text-xs text-faint transition-colors hover:bg-elevated hover:text-danger"
                >
                  Remove note
                </button>
              )}
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                className="rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveNote(draft.trim())}
                disabled={noteSaving || !draft.trim()}
                className="btn-subtle btn-sm !text-xs"
              >
                {noteSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Send note
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
