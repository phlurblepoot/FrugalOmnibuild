// src/components/CustomCostRow.test.tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CustomCostRow, costFieldText, costLineForEditing } from './CustomCostRow';

// Holds the row's item in state, like the takeoff editors do.
const Harness: React.FC<{ initial: any }> = ({ initial }) => {
  const [item, setItem] = React.useState(initial);
  return (
    <CustomCostRow item={item} index={0} unitLabel="sq ft" onChange={(_, updated) => setItem(updated)} onRemove={() => {}} />
  );
};

const costBox = () => screen.getAllByRole('textbox').find(el => el.getAttribute('placeholder') === '0') as HTMLInputElement;

describe('costFieldText', () => {
  it('shows a saved 0 or nothing as an empty box', () => {
    expect(costFieldText(0)).toBe('');
    expect(costFieldText(undefined)).toBe('');
    expect(costFieldText(null)).toBe('');
    expect(costFieldText('')).toBe('');
  });

  it('keeps real values and what the user typed', () => {
    expect(costFieldText(2.5)).toBe('2.5');
    expect(costFieldText('0')).toBe('0');
    expect(costFieldText('0.')).toBe('0.');
    expect(costFieldText('=95*40%')).toBe('=95*40%');
  });
});

describe('costLineForEditing', () => {
  it('turns saved numbers into box text, zeros blank', () => {
    const line = costLineForEditing({ id: 'a', name: 'Labor', type: 'yield', cost: 0, yield: 12.5, costPerUnit: 0, amount: undefined, perUnits: 3 });
    expect(line).toMatchObject({ id: 'a', name: 'Labor', cost: '', yield: '12.5', costPerUnit: '', amount: '', perUnits: '3' });
  });
});

describe('CustomCostRow', () => {
  it('shows a saved 0 as a faded placeholder, so typing 5 gives 5', () => {
    render(<Harness initial={{ id: 'a', name: '', type: 'unit', costPerUnit: 0 }} />);
    const box = costBox();
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: '5' } });
    expect(costBox().value).toBe('5');
  });

  it('a cleared box stays empty instead of filling back in with 0', () => {
    render(<Harness initial={{ id: 'a', name: '', type: 'flat', cost: '12' }} />);
    fireEvent.change(costBox(), { target: { value: '' } });
    expect(costBox().value).toBe('');
    fireEvent.change(costBox(), { target: { value: '7' } });
    expect(costBox().value).toBe('7');
  });
});
