// src/test/sanity.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('ui test infrastructure', () => {
  it('renders JSX into jsdom with jest-dom matchers', () => {
    render(<button>hello</button>);
    expect(screen.getByRole('button')).toHaveTextContent('hello');
  });
});
