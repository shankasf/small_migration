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
export function parseImpactSources(message: string): ImpactSource[] | null {
  let text = message.trim().toLowerCase().replace(/[.!]$/, '').replace(/^please\s+/, '')
    .replace(/^(?:i want to use|let's use|use|choose|select|confirm|confirmed|go with|from)\s+/, '')
    .replace(/\s+for (?:this|the) analysis$/, '').replace(/\s+(?:please|only)$/, '')
    .replace(/^(?:both|only|just)\s+/, '').replace(/\b(?:the|my)\s+/g, '');
  if (['all', 'all sources', 'all of them', 'all available sources'].includes(text)) return [...IMPACT_SOURCES];
  text = text.replace(/\buploaded (?:files|references|artifacts)\b|\bfiles i uploaded\b|\bcurrent (?:chat )?files\b|\battachments\b|\bpasted references\b/g, 'uploads')
    .replace(/\b(?:earlier|previous|past|saved) chats?(?: and files)?\b|\bchat history\b|\bfile library\b/g, 'history')
    .replace(/\bdbt cloud\b/g, 'dbt').replace(/\bsnowflake metadata\b/g, 'snowflake');
  const values = text.split(/\s*(?:,|\+|&|\band\b)\s*/).filter(Boolean);
  const sources = values.map(v => /^[1-6]$/.test(v) ? IMPACT_SOURCES[Number(v) - 1] : v);
  return sources.length && sources.every(s => IMPACT_SOURCES.includes(s as ImpactSource))
    ? [...new Set(sources)] as ImpactSource[] : null;
}

export function requestImpactSources(userId: string, request: string, startedAt: Date): ImpactState {
  return { id: randomUUID(), userId, phase: 'awaiting_sources', sources: [], request, startedAt: startedAt.toISOString() };
}
