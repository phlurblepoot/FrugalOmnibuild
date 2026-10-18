// src/pages/mail/compose/RecipientsField.test.tsx
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Addr } from '../types';

const h = vi.hoisted(() => ({ recipients: vi.fn() }));
vi.mock('../../../utils/mailApi', () => ({ mailApi: { recipients: h.recipients } }));

import { RecipientsField, type RecipientsFieldHandle } from './RecipientsField';

const Harness: React.FC<{
  initial?: Addr[];
  onChange?: (v: Addr[]) => void;
  onPendingChange?: (t: string) => void;
  fieldRef?: React.Ref<RecipientsFieldHandle>;
}> = ({ initial = [], onChange, onPendingChange, fieldRef }) => {
  const [value, setValue] = useState<Addr[]>(initial);
  return (
    <RecipientsField
      ref={fieldRef}
      label="To"
      value={value}
      onChange={v => { setValue(v); onChange?.(v); }}
      onPendingChange={onPendingChange}
    />
  );
};

const input = () => screen.getByLabelText('To') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  h.recipients.mockResolvedValue([]);
});

describe('RecipientsField', () => {
  it('commits a typed address when the user types a comma', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'a@b.com,' } });
    expect(onChange).toHaveBeenCalledWith([{ addr: 'a@b.com' }]);
    expect(screen.getByText(/a@b\.com/)).toBeInTheDocument();
    expect(input().value).toBe('');
  });

  it('commits on Enter and parses a "Name <addr>" form', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'Bob Smith <bob@acme.com>' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([{ addr: 'bob@acme.com', name: 'Bob Smith' }]);
  });

  it('does not commit text that is not an address and marks the input invalid', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'nope' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('nope');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
  });

  it('commits on blur', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'c@d.com' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith([{ addr: 'c@d.com' }]);
  });

  it('splits a pasted comma list into pills', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.paste(input(), { clipboardData: { getData: () => 'a@b.com, Bob <bob@acme.com>; c@d.com' } });
    expect(onChange).toHaveBeenCalledWith([
      { addr: 'a@b.com' },
      { addr: 'bob@acme.com', name: 'Bob' },
      { addr: 'c@d.com' },
    ]);
  });

  it('removes the last pill on backspace in an empty input', () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ addr: 'a@b.com' }, { addr: 'c@d.com' }]} onChange={onChange} />);
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith([{ addr: 'a@b.com' }]);
  });

  it('removes a pill from its remove button', () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ addr: 'a@b.com' }]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove a@b.com'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('suggests recipients from the server and picks the highlighted one with Enter', async () => {
    h.recipients.mockResolvedValue([
      { addr: 'bob@acme.com', name: 'Bob Smith', source: 'customer', customerId: 'c1' },
      { addr: 'bobby@acme.com', name: 'Bobby', source: 'recent' },
    ]);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'bo' } });

    await waitFor(() => expect(h.recipients).toHaveBeenCalledWith('bo'));
    const option = await screen.findByRole('option', { name: /Bob Smith/ });
    expect(option).toBeInTheDocument();

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([{ addr: 'bob@acme.com', name: 'Bob Smith' }]);
  });

  it('does not query the server for an empty query', async () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '' } });
    await new Promise(r => setTimeout(r, 250));
    expect(h.recipients).not.toHaveBeenCalled();
  });

  it('reports uncommitted input text to the parent', () => {
    const onPendingChange = vi.fn();
    render(<Harness onPendingChange={onPendingChange} />);
    fireEvent.change(input(), { target: { value: 'cli' } });
    expect(onPendingChange).toHaveBeenLastCalledWith('cli');

    fireEvent.change(input(), { target: { value: 'client@acme.com' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onPendingChange).toHaveBeenLastCalledWith('');
  });

  it('commitPending flushes a parseable input and reports what it committed', () => {
    const onChange = vi.fn();
    const ref = React.createRef<RecipientsFieldHandle>();
    render(<Harness onChange={onChange} fieldRef={ref} />);

    expect(ref.current!.commitPending()).toEqual([]);   // nothing typed

    fireEvent.change(input(), { target: { value: 'client@acme.com' } });
    let committed: Addr[] = [];
    act(() => { committed = ref.current!.commitPending(); });
    expect(committed).toEqual([{ addr: 'client@acme.com' }]);
    expect(onChange).toHaveBeenCalledWith([{ addr: 'client@acme.com' }]);
    expect(input().value).toBe('');
  });

  it('commitPending leaves text that is not an address alone', () => {
    const onChange = vi.fn();
    const ref = React.createRef<RecipientsFieldHandle>();
    render(<Harness onChange={onChange} fieldRef={ref} />);
    fireEvent.change(input(), { target: { value: 'not an address' } });
    expect(ref.current!.commitPending()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('not an address');
  });
});
