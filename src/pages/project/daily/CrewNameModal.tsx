// src/pages/project/daily/CrewNameModal.tsx
// The one name prompt behind "Add crew" and "Rename crew" on the Daily
// Reports page. The name is typed in (no saved list, no suggestions); a blank
// name is caught here, and anything the server refuses (a name another crew of
// the project already has) shows under the field in the server's own words.
import React, { useState } from 'react';
import { Button, Field, Input, Modal } from '../../../components/ui';

export const CrewNameModal: React.FC<{
  title: string;
  confirmLabel: string;
  initialName?: string;
  onClose: () => void;
  /** Resolves once saved (the modal is then closed by the caller); a
   *  rejection's message is shown under the field. */
  onSubmit: (name: string) => Promise<void>;
}> = ({ title, confirmLabel, initialName = '', onClose, onSubmit }) => {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter a name for the crew.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not save the crew.');
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={title} width="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { void submit(); }} disabled={saving}>{saving ? 'Saving…' : confirmLabel}</Button>
      </>}
    >
      <Field label="Crew name" htmlFor="daily-crew-name" error={error ?? undefined}
        hint="Your own crew or a sub's — each crew keeps its own daily reports, one per day.">
        <Input
          id="daily-crew-name"
          value={name}
          autoFocus
          maxLength={80}
          placeholder="e.g. Smith Drywall"
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'daily-crew-name-error' : undefined}
        />
      </Field>
    </Modal>
  );
};
