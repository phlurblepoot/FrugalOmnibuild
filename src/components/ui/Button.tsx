// src/components/ui/Button.tsx
import React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

// Glow is reserved for primary actions (spec §5 rule 2). Everything else
// stays flat per the hybrid design language.
const VARIANTS: Record<Variant, string> = {
  primary:
    'glow-accent text-white hover:brightness-110 active:brightness-95 ' +
    'disabled:opacity-50 disabled:hover:brightness-100',
  secondary:
    'bg-raised text-ink border border-edge hover:bg-hover active:bg-hover disabled:opacity-50',
  ghost:
    'text-ink-soft hover:bg-hover hover:text-ink active:bg-hover disabled:opacity-50',
  danger:
    'bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:opacity-50',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={
        'inline-flex items-center justify-center font-medium rounded-lg ' +
        // Touch-only min tap height (>=40px); reset at md: so desktop density
        // (h-8/h-9) and existing layouts are unchanged.
        'min-h-[40px] md:min-h-0 ' +
        `transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`
      }
      {...rest}
    />
  )
);
Button.displayName = 'Button';
