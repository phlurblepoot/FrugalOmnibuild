// src/pages/project/proposal/InclusionsExclusionsCard.tsx
// "What's in / what's out" — the two bullet lists the proposal PDF prints
// under the price. Each list is edited as free text (one bullet per line) but
// stored as a string[], so the card keeps the raw text locally and hands the
// parsed array up on every keystroke.
import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Textarea } from '../../../components/ui';
import { HistoryMenu } from './HistoryMenu';

export const parseBullets = (text: string): string[] =>
  text.split('\n').map(s => s.trim()).filter(Boolean);

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const BulletField: React.FC<{
  label: string;
  testId: string;
  value: string[];
  history: string[];
  readOnly: boolean;
  placeholder: string;
  onChange: (next: string[]) => void;
}> = ({ label, testId, value, history, readOnly, placeholder, onChange }) => {
  // Local text so a half-typed line — an empty new line after Enter, a
  // trailing space — survives; parsing on every change would delete the
  // newline the moment it was typed.
  const [text, setText] = useState(() => value.join('\n'));
  useEffect(() => {
    setText(prev => (sameList(parseBullets(prev), value) ? prev : value.join('\n')));
  }, [value]);

  const set = (next: string) => { setText(next); onChange(parseBullets(next)); };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={testId} className="block text-sm font-medium text-ink">{label}</label>
        {!readOnly && <HistoryMenu history={history} testId={`${testId}-history`} onSelect={set} />}
      </div>
      <Textarea
        id={testId}
        data-testid={testId}
        rows={6}
        value={text}
        placeholder={placeholder}
        disabled={readOnly}
        onChange={e => set(e.target.value)}
      />
      <p className="text-xs text-ink-faint">One per line.</p>
    </div>
  );
};

export const InclusionsExclusionsCard: React.FC<{
  inclusions: string[];
  exclusions: string[];
  inclusionsHistory: string[];
  exclusionsHistory: string[];
  readOnly: boolean;
  onChange: (inclusions: string[], exclusions: string[]) => void;
}> = ({ inclusions, exclusions, inclusionsHistory, exclusionsHistory, readOnly, onChange }) => (
  <Card data-testid="inclusions-exclusions">
    <CardHeader title="Inclusions & exclusions" />
    <CardBody className="grid gap-5 md:grid-cols-2">
      <BulletField
        label="Inclusions"
        testId="proposal-inclusions"
        value={inclusions}
        history={inclusionsHistory}
        readOnly={readOnly}
        placeholder={'Scaffolding\nClean-up'}
        onChange={next => onChange(next, exclusions)}
      />
      <BulletField
        label="Exclusions"
        testId="proposal-exclusions"
        value={exclusions}
        history={exclusionsHistory}
        readOnly={readOnly}
        placeholder={'Painting\nPermits'}
        onChange={next => onChange(inclusions, next)}
      />
    </CardBody>
  </Card>
);
