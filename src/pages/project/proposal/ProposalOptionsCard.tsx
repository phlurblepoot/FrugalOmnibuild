// src/pages/project/proposal/ProposalOptionsCard.tsx
// Everything about how the proposal PRINTS rather than what it costs: the
// document title, how long the price stands, the typeface, and which optional
// sections the generator appends.
import React from 'react';
import type { Proposal } from '../../../utils/store';
import { Card, CardBody, CardHeader, Checkbox, Field, Input, Select } from '../../../components/ui';
import { HIGHLIGHT_QUALITY_PRESETS, type HighlightQuality } from './proposalGenerator';

export type ProposalOptionsValue = Pick<Proposal, 'title' | 'validUntil' | 'fontFamily' | 'includeCostDetail' | 'includeSignature' | 'highlightQuality'>;

const FONTS: { value: NonNullable<Proposal['fontFamily']>; label: string }[] = [
  { value: 'helvetica', label: 'Helvetica' },
  { value: 'times', label: 'Times' },
  { value: 'courier', label: 'Courier' },
];

export const ProposalOptionsCard: React.FC<{
  value: ProposalOptionsValue;
  includeHighlights: boolean;
  // Highlights are rendered FROM takeoff lines, so with none priced there is
  // nothing to highlight and the option is hidden rather than shown dead.
  canIncludeHighlights: boolean;
  readOnly: boolean;
  onChange: (patch: Partial<ProposalOptionsValue>) => void;
  onIncludeHighlightsChange: (v: boolean) => void;
}> = ({ value, includeHighlights, canIncludeHighlights, readOnly, onChange, onIncludeHighlightsChange }) => (
  <Card data-testid="proposal-options">
    <CardHeader title="Document options" />
    <CardBody className="space-y-4">
      <Field label="Title" htmlFor="proposal-title" hint="Printed at the top of the proposal. Leave blank for the project name.">
        <Input
          id="proposal-title"
          value={value.title ?? ''}
          placeholder="Proposal"
          // The cover clamps the title to 3 wrapped lines; this stops a title
          // being silently truncated in the PDF rather than at the keyboard.
          maxLength={120}
          disabled={readOnly}
          onChange={e => onChange({ title: e.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Valid until" htmlFor="proposal-valid-until" hint="Shown on the list as a countdown once sent.">
          <Input
            id="proposal-valid-until"
            type="date"
            value={value.validUntil ?? ''}
            disabled={readOnly}
            onChange={e => onChange({ validUntil: e.target.value || null })}
          />
        </Field>

        <Field label="Font" htmlFor="proposal-font">
          <Select
            id="proposal-font"
            value={value.fontFamily ?? 'helvetica'}
            disabled={readOnly}
            onChange={e => onChange({ fontFamily: e.target.value as NonNullable<Proposal['fontFamily']> })}
          >
            {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
        </Field>
      </div>

      <div className="space-y-2">
        <Checkbox
          label="Include cost detail"
          checked={value.includeCostDetail}
          disabled={readOnly}
          onChange={e => onChange({ includeCostDetail: e.target.checked })}
        />
        <Checkbox
          label="Include signature block"
          checked={value.includeSignature}
          disabled={readOnly}
          onChange={e => onChange({ includeSignature: e.target.checked })}
        />
        {canIncludeHighlights && (
          <Checkbox
            label="Attach highlighted plan pages"
            checked={includeHighlights}
            disabled={readOnly}
            onChange={e => onIncludeHighlightsChange(e.target.checked)}
          />
        )}
      </div>

      {/* Not gated on the highlights checkbox: quality is a stored proposal
          column, and 'email' shrinks the WHOLE generated PDF — photos and
          attachments included — not just the highlighted plan pages. */}
      <Field label="PDF quality" htmlFor="proposal-quality">
        <Select
          id="proposal-quality"
          value={value.highlightQuality}
          disabled={readOnly}
          onChange={e => onChange({ highlightQuality: e.target.value as HighlightQuality })}
        >
          {(Object.keys(HIGHLIGHT_QUALITY_PRESETS) as HighlightQuality[]).map(q => (
            <option key={q} value={q}>{HIGHLIGHT_QUALITY_PRESETS[q].label}</option>
          ))}
        </Select>
      </Field>
    </CardBody>
  </Card>
);
