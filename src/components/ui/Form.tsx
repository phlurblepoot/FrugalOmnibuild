// src/components/ui/Form.tsx
import React from 'react';

// Shared chrome for all text-like controls — forms stay flat (spec §5 rule 4).
const CONTROL =
  'w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink ' +
  'placeholder:text-ink-faint transition-colors ' +
  'focus:border-accent-400 focus-visible:outline-none focus:ring-2 focus:ring-accent-500/25 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export const Field: React.FC<{
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, hint, error, children }) => (
  // Screen-reader note: the error <p> gets id `${htmlFor}-error`; callers that
  // need announced errors should pass aria-invalid + aria-describedby on the
  // control themselves (Field cannot reach into opaque children safely).
  <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
      {label}
    </label>
    {children}
    {error ? (
      <p id={htmlFor ? `${htmlFor}-error` : undefined} className="text-xs text-red-600 dark:text-red-400">
        {error}
      </p>
    ) : hint ? (
      <p className="text-xs text-ink-faint">{hint}</p>
    ) : null}
  </div>
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => <input ref={ref} className={`${CONTROL} ${className}`} {...rest} />
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...rest }, ref) => <textarea ref={ref} className={`${CONTROL} ${className}`} {...rest} />
);
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className = '', children, ...rest }, ref) => (
    <select ref={ref} className={`${CONTROL} ${className}`} {...rest}>
      {children}
    </select>
  )
);
Select.displayName = 'Select';

export const Checkbox: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { label: string }
> = ({ label, className = '', ...rest }) => (
  <label className={`inline-flex items-center gap-2 text-sm text-ink cursor-pointer ${className}`}>
    <input type="checkbox" className="size-4 rounded border-edge-strong accent-accent-600" {...rest} />
    {label}
  </label>
);
