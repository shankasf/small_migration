/**
 * The 1-5 rubric that grades a thumbs up. Every level names the amount of work
 * the reader still had to do, so two people giving a "4" mean the same thing
 * and the admin average is comparable across users and weeks.
 */
export type RubricScore = 1 | 2 | 3 | 4 | 5;

export interface RubricLevel {
  score: RubricScore;
  label: string;
  description: string;
}

export const RUBRIC: readonly RubricLevel[] = [
  { score: 1, label: 'Barely usable', description: 'Pointed the right way, but most of it had to be redone.' },
  { score: 2, label: 'Partly useful', description: 'Some parts usable; significant corrections were needed.' },
  { score: 3, label: 'Useful', description: 'Mostly right; moderate edits before it could be used.' },
  { score: 4, label: 'Strong', description: 'Correct and complete apart from minor tweaks.' },
  { score: 5, label: 'Excellent', description: 'Correct, complete and ready to use as-is.' },
];

export const rubricLevel = (score: number | null | undefined): RubricLevel | undefined =>
  RUBRIC.find(level => level.score === score);
