import type { CriterionState } from '@/lib/types';

const STATE_CLASS: Record<CriterionState, string> = {
  pass: 'chip--pass',
  fail: 'chip--fail',
  unverified: 'chip--unverified',
  pending: 'chip--pending',
};

const STATE_WORD: Record<CriterionState, string> = {
  pass: 'pass',
  fail: 'fail',
  unverified: 'unverified',
  pending: 'pending',
};

export function CriterionChip({
  label,
  state,
  detail,
}: {
  label: string;
  state: CriterionState;
  detail?: string;
}) {
  return (
    <span
      className={`chip ${STATE_CLASS[state]}`}
      title={detail ? `${label}: ${STATE_WORD[state]} — ${detail}` : label}
    >
      {label}
      <span className="sr-only"> {STATE_WORD[state]}</span>
    </span>
  );
}

export function Chip({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'pass' | 'fail' | 'warn';
}) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}
