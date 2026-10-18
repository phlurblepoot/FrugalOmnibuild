// src/components/documents/ReplyFlagChip.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { REPLY_FLAG_TITLE, ReplyFlagChip } from './ReplyFlagChip';

describe('ReplyFlagChip', () => {
  it('renders the amber Reply chip with the reply-state title', () => {
    render(<ReplyFlagChip data-testid="reply-flag" />);
    const chip = screen.getByTestId('reply-flag');
    expect(chip).toHaveTextContent('Reply');
    expect(chip).toHaveAttribute('title', REPLY_FLAG_TITLE);
  });
});
