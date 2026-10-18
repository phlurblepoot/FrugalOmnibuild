// src/pages/mail/AttachmentChips.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AttachmentMeta } from './types';

const h = vi.hoisted(() => ({ attachmentUrl: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: h }));

import { AttachmentChips } from './AttachmentChips';

const att = (over: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  attId: 'a1', name: 'detail.pdf', mime: 'application/pdf', size: 2 * 1048576, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.attachmentUrl.mockImplementation((m: string, a: string, o?: { inline?: boolean }) =>
    `/api/mail/messages/${m}/attachments/${a}?token=t${o?.inline ? '&inline=1' : ''}`);
});

describe('AttachmentChips', () => {
  it('renders nothing when the message has no attachments', () => {
    const { container } = render(<AttachmentChips messageId="m1" attachments={[]} onSave={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each attachment with its name and size', () => {
    render(
      <AttachmentChips
        messageId="m1"
        attachments={[att(), att({ attId: 'a2', name: 'notes.txt', mime: 'text/plain', size: 4096 })]}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('detail.pdf')).toBeInTheDocument();
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('4 KB')).toBeInTheDocument();
  });

  it('opens a pdf inline in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AttachmentChips messageId="m1" attachments={[att()]} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /detail\.pdf/ }));
    expect(open).toHaveBeenCalledWith('/api/mail/messages/m1/attachments/a1?token=t&inline=1', '_blank', 'noopener');
    open.mockRestore();
  });

  it('opens an image inline in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AttachmentChips messageId="m1" attachments={[att({ attId: 'a3', name: 'site.jpg', mime: 'image/jpeg', size: 1024 })]} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /site\.jpg/ }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('inline=1'), '_blank', 'noopener');
    open.mockRestore();
  });

  it('opens Word, Excel and PowerPoint files in the document viewer in a new tab, old formats too', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <AttachmentChips
        messageId="m 1"
        attachments={[
          att({ attId: 'a5', name: 'Scope.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
          // Mail clients often send old formats as a generic type: the name decides.
          att({ attId: 'a6', name: 'Budget.xls', mime: 'application/octet-stream' }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Scope\.docx/ }));
    expect(open).toHaveBeenLastCalledWith('/tools/view?message=m%201&att=a5&name=Scope.docx', '_blank', 'noopener');
    fireEvent.click(screen.getByRole('button', { name: /Budget\.xls/ }));
    expect(open).toHaveBeenLastCalledWith('/tools/view?message=m%201&att=a6&name=Budget.xls', '_blank', 'noopener');
    open.mockRestore();
  });

  it('downloads anything else through a download link', () => {
    render(<AttachmentChips messageId="m1" attachments={[att({ attId: 'a4', name: 'plans.dwg', mime: 'application/acad', size: 1048576 })]} onSave={vi.fn()} />);
    const link = screen.getByRole('link', { name: /plans\.dwg/ }) as HTMLAnchorElement;
    expect(link).toHaveAttribute('href', '/api/mail/messages/m1/attachments/a4?token=t');
    expect(link).toHaveAttribute('download', 'plans.dwg');
  });

  it('leaves the Save button out until a caller can handle it', () => {
    render(<AttachmentChips messageId="m1" attachments={[att()]} />);
    expect(screen.queryByRole('button', { name: /Save to Documents/i })).toBeNull();
  });

  it('offers Save to Documents and hands the click back to the caller', () => {
    const onSave = vi.fn();
    render(<AttachmentChips messageId="m1" attachments={[att()]} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
