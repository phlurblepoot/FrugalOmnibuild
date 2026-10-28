// src/components/ui/Form.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Field, Input, Select, Textarea, Checkbox } from './Form';

describe('Form controls', () => {
  it('Field associates its label with the control via htmlFor', () => {
    render(
      <Field label="Contractor" htmlFor="contractor">
        <Input id="contractor" defaultValue="GC Co" />
      </Field>
    );
    expect(screen.getByLabelText('Contractor')).toHaveValue('GC Co');
  });

  it('Field shows error text instead of hint when both given', () => {
    render(
      <Field label="Amount" hint="Dollars" error="Required">
        <Input />
      </Field>
    );
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.queryByText('Dollars')).not.toBeInTheDocument();
  });

  it('Input forwards value and onChange', () => {
    const onChange = vi.fn();
    render(<Input value="a" onChange={onChange} aria-label="name" />);
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'ab' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('Select renders options; Textarea renders; Checkbox toggles', () => {
    const onChange = vi.fn();
    render(
      <>
        <Select aria-label="kind" defaultValue="b">
          <option value="a">A</option>
          <option value="b">B</option>
        </Select>
        <Textarea aria-label="desc" defaultValue="text" />
        <Checkbox label="Include photos" onChange={onChange} />
      </>
    );
    expect(screen.getByLabelText('kind')).toHaveValue('b');
    expect(screen.getByLabelText('desc')).toHaveValue('text');
    fireEvent.click(screen.getByLabelText('Include photos'));
    expect(onChange).toHaveBeenCalled();
  });

  it('controls are full width unless the caller sets its own width', () => {
    render(
      <>
        <Select aria-label="full"><option>a</option></Select>
        <Select aria-label="narrow" className="w-40"><option>a</option></Select>
        <Input aria-label="auto" className="h-9 w-auto" />
        <Input aria-label="responsive" className="sm:w-56" />
        <Textarea aria-label="min" className="min-w-0" />
      </>
    );
    expect(screen.getByLabelText('full')).toHaveClass('w-full');
    expect(screen.getByLabelText('narrow')).toHaveClass('w-40');
    expect(screen.getByLabelText('narrow')).not.toHaveClass('w-full');
    expect(screen.getByLabelText('auto')).not.toHaveClass('w-full');
    // A width only from sm: up still needs the full-width base below it.
    expect(screen.getByLabelText('responsive')).toHaveClass('w-full', 'sm:w-56');
    expect(screen.getByLabelText('min')).toHaveClass('w-full', 'min-w-0');
  });
});
