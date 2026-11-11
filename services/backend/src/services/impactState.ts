import { randomUUID } from 'crypto';

export const IMPACT_SOURCES = ['uploads', 'history', 'github', 'gitlab', 'dbt', 'snowflake'] as const;
export type ImpactSource = typeof IMPACT_SOURCES[number];
export interface ImpactState {
  id: string;
  userId: string;
  phase: 'awaiting_sources' | 'confirmed';
  sources: ImpactSource[];
  request: string;
  startedAt: string;
  confirmedAt?: string;
}
export function impactState(value: unknown, userId: string): ImpactState | null {
  const state = value as ImpactState | null;
  return state && state.userId === userId && typeof state.id === 'string' &&
    typeof state.request === 'string' && typeof state.startedAt === 'string' &&
    ['awaiting_sources', 'confirmed'].includes(state.phase) && Array.isArray(state.sources) &&
    state.sources.every(s => IMPACT_SOURCES.includes(s)) ? state : null;
}

// Only an explicit source-list reply to a pending question grants access.
// Negations, ambiguous acknowledgements and arbitrary prose never expand scope.
// Each listed item must name one source: its menu number (1, #3, 3., option 3),
// its label as shown in the question, or both when they agree ("#3 GitHub repositories").
const SOURCE_LABELS: Array<[RegExp, ImpactSource]> = [
  [/^(?:uploads?|uploaded (?:files|references|artifacts)|files i uploaded|current (?:chat )?files|attachments|pasted references)$/, 'uploads'],
  [/^(?:history|chat history|file library|(?:earlier|previous|past|saved) chats?)$/, 'history'],
  [/^github(?: (?:repositories|repository|repos|repo))?$/, 'github'],
  [/^gitlab(?: (?:repositories|repository|repos|repo|projects?))?$/, 'gitlab'],
  [/^dbt(?: cloud)?(?: (?:run artifacts|artifacts|runs?))?$/, 'dbt'],
  [/^snowflake(?: (?:metadata|schema))?$/, 'snowflake'],
];

function labelSource(label: string): ImpactSource | null {
  return SOURCE_LABELS.find(([pattern]) => pattern.test(label.trim()))?.[1] ?? null;
}

function itemSource(item: string): ImpactSource | null {
  const numbered = item.match(/^(?:#\s*|no\.?\s*|number\s+|option\s+|source\s+)?\(?([1-9])\)?[.):]?(?:\s*[-–:]?\s*(.+))?$/);
  if (!numbered) return labelSource(item);
  const byNumber = IMPACT_SOURCES[Number(numbered[1]) - 1];
  if (!byNumber) return null;
  // "#3 GitHub repositories" is accepted only when the number and label agree.
  return !numbered[2] || labelSource(numbered[2]) === byNumber ? byNumber : null;
}

export function parseImpactSources(message: string): ImpactSource[] | null {
  let text = message.trim().toLowerCase().replace(/[.!]$/, '').replace(/^please\s+/, '')
    .replace(/^(?:i want to use|let's use|use|choose|select|confirm|confirmed|go with|from)\s+/, '')
    .replace(/\s+for (?:this|the) analysis$/, '').replace(/\s+(?:please|only)$/, '')
    .replace(/^(?:both|only|just)\s+/, '').replace(/\b(?:the|my)\s+/g, '');
  if (['all', 'all sources', 'all of them', 'all available sources'].includes(text)) return [...IMPACT_SOURCES];
  // The menu marks sources "(connected)", so "the connected GitHub repository" names GitHub.
  // Stripped after the "all" check so "all connected sources" stays ambiguous.
  text = text.replace(/\b(?:connected|integrated|linked)\s+/g, '');
  // Menu labels that contain "and" are folded before the list is split on "and".
  text = text.replace(/\buploaded files and references(?: pasted in this analysis)?\b/g, 'uploads')
    .replace(/\b(?:earlier|previous|past|saved) chats? and (?:saved )?(?:file versions|files)\b/g, 'history')
    .replace(/\bsnowflake schema and dependency metadata\b/g, 'snowflake');
  const items = text.split(/\s*(?:,|\+|&|\band\b)\s*/).filter(Boolean);
  const sources = items.map(itemSource);
  return sources.length && sources.every(Boolean) ? [...new Set(sources)] as ImpactSource[] : null;
}

// A reply that switches or names evidence sources ("use the integrated dbt repository in github")
// refines the pending analysis rather than replacing it, so the original question stays in the
// brief. A new question starts a new brief. Earlier consent is never carried either way.
const SOURCE_FOLLOW_UP = /\b(?:sources?|instead|switch|github|gitlab|dbt cloud|snowflake|uploads?|uploaded|repo|repos|repository|repositories)\b/i;

// A complaint or question about the assistant itself ("are you not able to read the file?",
// "why can't you trace it?") is never an analysis request, even when it names an action.
const ASSISTANT_COMPLAINT = /\b(?:(?:can't|cannot|won't)\s+you|(?:are|were|can|could|do|did|will|would|have|has)(?:n't|\s+not)\s+you|(?:are|were|can|could|do|did|will|would)\s+you\s+not|why\s+(?:can't|cannot|won't|(?:can|could|did|do|does|is|are|were|was|will|would|have|has)(?:n't|\s+not)|won't|not))\b|\byou(?:'re|\s+are|\s+were)?\s+(?:not|unable|didn't|did\s+not|don't|do\s+not|can't|cannot|couldn't|still|never|failed|keep)\b|\b(?:not\s+able|unable)\s+to\b|\b(?:not\s+working|doesn't\s+work|didn't\s+work|that's\s+wrong|try\s+again)\b/i;
// A new analysis names what to analyse: a what-if question, a change to a named object, or an
// impact/lineage word together with an identifier (stg_orders, mart.customers, `col`).
// Topic words alone ("just do the impact analysis") are not a new request.
const WHAT_IF = /\bwhat\s+(?:if|breaks|happens|would\s+(?:break|happen|change))\b/i;
const CHANGE = /\b(?:drop|dropping|rename|renaming|remove|removing|delete|deleting|alter|altering|change|changing|add|adding|replace|replacing|migrate|migrating|deprecate|deprecating|retire|retiring)\s+(?!(?:it|this|that|them|your|the\s+answer|more|some|anything|something)\b)(?:the\s+|a\s+|an\s+|column\s+|table\s+|model\s+)?[\w$`"'.]+/i;
const TOPIC = /\b(?:impact|trace|lineage|downstream|upstream|depend(?:s|encies|ency|ent|ents)?|affect(?:s|ed|ing)?|uses?|reads?|references?)\b/i;
const IDENTIFIER = /(?:\b[A-Za-z][\w$]*(?:[._][\w$]+)+\b|`[^`\n]+`|"[^"\n]+")/;

const normalise = (message: string) => message.trim().replace(/[‘’ʼ]/g, "'");

/** True when a message reads as a fresh analysis request rather than a complaint or aside. */
export function isNewAnalysisRequest(message: string): boolean {
  const text = normalise(message);
  return !ASSISTANT_COMPLAINT.test(text) &&
    (WHAT_IF.test(text) || CHANGE.test(text) || (TOPIC.test(text) && IDENTIFIER.test(text)));
}

/**
 * The analysis request stored when the source question is (re-)asked.
 * - A source reply or follow-up refines the pending request.
 * - A genuinely new analysis request replaces it.
 * - A complaint about the assistant ("are you not able to read the file?") keeps the original
 *   request exactly, so it never becomes the analysis brief.
 * - Anything else unclassified while sources are pending is kept as a follow-up to the
 *   original request, so neither the original nor the new message is silently dropped.
 */
export function impactBrief(previous: ImpactState | null, message: string): string {
  if (!previous) return message;
  if (parseImpactSources(message) || SOURCE_FOLLOW_UP.test(message)) return `${previous.request}\n\nFollow-up: ${message}`;
  if (isNewAnalysisRequest(message)) return message;
  if (ASSISTANT_COMPLAINT.test(normalise(message))) return previous.request;
  // A confirmed analysis has already answered; any other new question starts over.
  if (previous.phase === 'confirmed') return message;
  return `${previous.request}\n\nFollow-up: ${message}`;
}

export function requestImpactSources(userId: string, request: string, startedAt: Date): ImpactState {
  return { id: randomUUID(), userId, phase: 'awaiting_sources', sources: [], request, startedAt: startedAt.toISOString() };
}
