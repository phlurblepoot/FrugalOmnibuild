import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PricingLinesCard } from './PricingLinesCard';
import { ConfirmProvider } from '../../../components/ConfirmDialog';

const t = (id: string, name: string) => ({ id, name, type: 'area', color: '#fff', unit: 'sqft', costPerUnit: 1, totalRealValue: 10000, pageBreakdown: [] } as any);
const takeoffLine = { id: 'l1', sortOrder: 0, kind: 'takeoff' as const, takeoffId: 't1', description: 'Stucco', amountCents: 1000000, derivedAmountCents: 1000000, measurementSummary: '10,000.00 sq ft', isAlternate: false };
const wrap = (ui: React.ReactElement) => render(<ConfirmProvider>{ui}</ConfirmProvider>);

describe('PricingLinesCard', () => {
  it('shows takeoff lines with measurement summary and derived amount', () => {
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={() => {}} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText('10,000.00 sq ft')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10000.00')).toBeInTheDocument();
  });

  it('overriding a takeoff amount asks for confirmation, then marks the line overridden with a reset', async () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    const amt = screen.getByDisplayValue('10000.00');
    fireEvent.change(amt, { target: { value: '9500' } });
    fireEvent.blur(amt);
    expect(await screen.findByText(/Override/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Override/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ amountCents: 950000, derivedAmountCents: 1000000 })]));
  });

  it('cancelling the confirmation restores the derived amount', async () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    const amt = screen.getByDisplayValue('10000.00');
    fireEvent.change(amt, { target: { value: '1' } });
    fireEvent.blur(amt);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(screen.getByDisplayValue('10000.00')).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an overridden line shows "was $X" and Reset restores it', () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[{ ...takeoffLine, amountCents: 950000 }]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText(/overridden \(was \$10,000\.00\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ amountCents: 1000000 })]);
  });

  it('adds a manual line, toggles alternate, and totals exclude alternates', () => {
    const onChange = vi.fn();
    const { rerender } = wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[{ description: 'Scaffolding', amountCents: 350000 }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Add manual line/ }));
    expect(onChange).toHaveBeenLastCalledWith([takeoffLine, expect.objectContaining({ kind: 'manual', amountCents: 0 })]);
    const manual = { id: 'm1', sortOrder: 1, kind: 'manual' as const, takeoffId: null, description: 'Scaffolding', amountCents: 350000, derivedAmountCents: null, measurementSummary: null, isAlternate: false };
    rerender(<ConfirmProvider><PricingLinesCard lines={[takeoffLine, manual]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} /></ConfirmProvider>);
    expect(screen.getByTestId('pricing-total')).toHaveTextContent('$13,500.00');
    fireEvent.click(screen.getAllByLabelText('Alternate')[1]);
    expect(onChange).toHaveBeenLastCalledWith([takeoffLine, expect.objectContaining({ id: 'm1', isAlternate: true })]);
  });

  it('clearing an amount restores the previous one instead of pricing the line at $0', async () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    const amt = screen.getByDisplayValue('10000.00');
    fireEvent.change(amt, { target: { value: '' } });
    fireEvent.blur(amt);
    await waitFor(() => expect(screen.getByDisplayValue('10000.00')).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  // Takeoff picking is a checklist, not a <select>: proposals routinely pull
  // in several takeoffs at once.
  describe('add-takeoffs checklist', () => {
    const totals = [t('t1', 'Stucco'), t('t2', 'Lath'), t('t3', 'Trim')];
    const openPanel = (onChange = vi.fn(), lines: any[] = []) => {
      wrap(<PricingLinesCard lines={lines} onChange={onChange} readOnly={false} takeoffTotals={totals} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
      fireEvent.click(screen.getByLabelText('Add takeoff'));
      return onChange;
    };

    it('the toggle opens a panel listing every available takeoff with its measurement summary', () => {
      openPanel();
      const panel = screen.getByTestId('add-takeoffs-panel');
      expect(panel).toBeInTheDocument();
      for (const name of ['Stucco', 'Lath', 'Trim']) {
        expect(screen.getByLabelText(name)).toBeInTheDocument();
      }
      expect(within(panel).getAllByText('10,000.00 sq ft')).toHaveLength(3);
      // The toggle itself is replaced by the panel, so "Add takeoff" is
      // unambiguous while it is open.
      expect(screen.queryByLabelText('Add takeoff')).toBeNull();
    });

    it('checking two and confirming fires ONE onChange with both lines appended', () => {
      // Seeded with an existing t1 line, so t1 is not offered and the two new
      // lines must land AFTER it.
      const onChange = openPanel(vi.fn(), [takeoffLine]);
      expect(screen.queryByLabelText('Stucco')).toBeNull();

      fireEvent.click(screen.getByLabelText('Lath'));
      fireEvent.click(screen.getByLabelText('Trim'));
      fireEvent.click(screen.getByRole('button', { name: 'Add 2 takeoffs' }));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'l1', sortOrder: 0 }),
        expect.objectContaining({ kind: 'takeoff', takeoffId: 't2', description: 'Lath', sortOrder: 1 }),
        expect.objectContaining({ kind: 'takeoff', takeoffId: 't3', description: 'Trim', sortOrder: 2 }),
      ]);
      // ...and the panel closes.
      expect(screen.queryByTestId('add-takeoffs-panel')).toBeNull();
    });

    it('the confirm button counts the selection and is disabled with none picked', () => {
      openPanel();
      expect(screen.getByRole('button', { name: 'Add 0 takeoffs' })).toBeDisabled();
      fireEvent.click(screen.getByLabelText('Stucco'));
      expect(screen.getByRole('button', { name: 'Add 1 takeoff' })).toBeEnabled();
    });

    it('Select all picks every row and Clear empties the selection', () => {
      openPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
      expect(screen.getByRole('button', { name: 'Add 3 takeoffs' })).toBeEnabled();
      expect(screen.getByLabelText('Trim')).toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.getByLabelText('Trim')).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Add 0 takeoffs' })).toBeDisabled();
    });

    it('Cancel closes the panel without adding, and forgets the selection', () => {
      const onChange = openPanel();
      fireEvent.click(screen.getByLabelText('Stucco'));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByTestId('add-takeoffs-panel')).toBeNull();

      fireEvent.click(screen.getByLabelText('Add takeoff'));
      expect(screen.getByLabelText('Stucco')).not.toBeChecked();
    });

    it('read-only hides the toggle entirely', () => {
      wrap(<PricingLinesCard lines={[]} onChange={() => {}} readOnly takeoffTotals={totals} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
      expect(screen.queryByLabelText('Add takeoff')).toBeNull();
    });
  });

  it('flags a missing takeoff and offers removal', () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={['t1']} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText(/takeoff no longer exists/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove line/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
