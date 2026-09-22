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

export function impactBrief(previous: ImpactState | null, message: string): string {
  return previous && (parseImpactSources(message) || SOURCE_FOLLOW_UP.test(message))
    ? `${previous.request}\n\nFollow-up: ${message}` : message;
}

export function requestImpactSources(userId: string, request: string, startedAt: Date): ImpactState {
  return { id: randomUUID(), userId, phase: 'awaiting_sources', sources: [], request, startedAt: startedAt.toISOString() };
}
