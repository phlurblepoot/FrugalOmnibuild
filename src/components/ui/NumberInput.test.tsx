// src/components/ui/NumberInput.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NumberInput } from './NumberInput';

describe('NumberInput', () => {
  it('shows a faded 0 placeholder by default', () => {
    render(<NumberInput value="" onChange={() => {}} aria-label="n" />);
    expect(screen.getByLabelText('n')).toHaveAttribute('placeholder', '0');
  });

  it('does not report an empty value and restores the previous value on blur', () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} aria-label="n" />);
    const el = screen.getByLabelText('n') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '' } });
    expect(el.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(el);
    expect(el.value).toBe('5');
  });

  it('reports typed values', () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} aria-label="n" />);
    const el = screen.getByLabelText('n');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows a stored 0 as an empty box, also when focused, so typing 5 gives 5', () => {
    const onChange = vi.fn();
    render(<NumberInput value={0} onChange={onChange} aria-label="n" />);
    const el = screen.getByLabelText('n') as HTMLInputElement;
    expect(el.value).toBe('');
    fireEvent.focus(el);
    expect(el.value).toBe('');
    fireEvent.change(el, { target: { value: '5' } });
    expect(el.value).toBe('5');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('allowEmpty with a custom placeholder still shows a real 0', () => {
    render(<NumberInput value={0} allowEmpty placeholder="base 10%" onChange={() => {}} aria-label="n" />);
    const el = screen.getByLabelText('n') as HTMLInputElement;
    expect(el.value).toBe('0');
    fireEvent.focus(el);
    expect(el.value).toBe('0');
  });

  it('allowEmpty with a 0.00 placeholder shows a stored 0 as blank and typing 5 gives 5', () => {
    render(<NumberInput value={0} allowEmpty placeholder="0.00" onChange={() => {}} aria-label="n" />);
    const el = screen.getByLabelText('n') as HTMLInputElement;
    expect(el.value).toBe('');
    fireEvent.focus(el);
    expect(el.value).toBe('');
    fireEvent.change(el, { target: { value: '5' } });
    expect(el.value).toBe('5');
  });

  it('a non-zero placeholder shows a real stored 0', () => {
    render(<NumberInput value={0} placeholder="2" onChange={() => {}} aria-label="n" />);
    const el = screen.getByLabelText('n') as HTMLInputElement;
    expect(el.value).toBe('0');
    fireEvent.focus(el);
    expect(el.value).toBe('0');
  });

  it('allowEmpty reports clearing', () => {
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} allowEmpty aria-label="n" />);
    const el = screen.getByLabelText('n');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
