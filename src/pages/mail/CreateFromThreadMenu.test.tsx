import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MessageRow, ThreadLink } from './types';

const h = vi.hoisted(() => ({
  body: vi.fn(),
  createLink: vi.fn(async (b: unknown) => ({ id: 'link-1', ...(b as object) })),
  createTask: vi.fn(async (_input: { title: string; notes: string; projectId: string | null; customerId: string | null }) => ({ id: 'task-1' })),
  createRfi: vi.fn(async () => ({ id: 'rfi-1', number: 1 })),
  createIssue: vi.fn(async () => ({ id: 'iss-1', number: 1 })),
  createChangeOrder: vi.fn(async () => ({ id: 'co-1', version: 1 })),
  createInvoice: vi.fn(async () => ({ id: 'inv-1', version: 1 })),
  getProjectsSummary: vi.fn(async () => [
    { id: 'p1', name: 'Job One', status: 'active', contractor: null, customerId: 'c1', address: null, bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false, pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0 },
    { id: 'p2', name: 'Job Two', status: 'active', contractor: null, customerId: 'c2', address: null, bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false, pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0 },
  ]),
  toast: vi.fn(),
}));

vi.mock('../../utils/mailApi', () => ({
  mailApi: { body: h.body, createLink: h.createLink },
}));
vi.mock('../../utils/store', async orig => ({
  ...(await orig<typeof import('../../utils/store')>()),
  createTask: h.createTask,
  createRfi: h.createRfi,
  createIssue: h.createIssue,
  createChangeOrder: h.createChangeOrder,
  createInvoice: h.createInvoice,
  getProjectsSummary: h.getProjectsSummary,
}));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

import { CreateFromThreadMenu } from './CreateFromThreadMenu';

const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1', accountId: 'a1', threadKey: 'tk-1', messageIdHeader: null, inReplyTo: null, references: [],
  from: { addr: 'bob@acme.com', name: 'Bob Smith' }, to: [{ addr: 'noah@birchwoodplaster.example' }], cc: [], bcc: [],
  subject: 'Roof detail', snippet: 'first message', date: '2026-08-27T12:00:00.000Z',
  isRead: true, isStarred: false, isDraft: false, hasAttachments: false, attachments: [],
  sizeBytes: 10, folderIds: ['f-inbox'], sentFromApp: false, ...over,
});

const PROJECT_LINK: ThreadLink = {
  id: 'l1', threadKey: 'tk-1', subjectSnapshot: 'Roof detail', firstDate: null, participantsJson: null,
  itemType: 'rfi', itemId: 'r1', projectId: 'p1', customerId: 'c1', linkedByUserId: 'u1',
  createdAt: '2026-08-27T12:00:00.000Z',
};

const setup = (overrides: Partial<React.ComponentProps<typeof CreateFromThreadMenu>> = {}) => {
  const navigate = vi.fn();
  const props: React.ComponentProps<typeof CreateFromThreadMenu> = {
    threadKey: 'tk-1',
    subject: 'Roof detail',
    snippet: 'thread snippet text',
    messages: [
      msg({ id: 'm1', date: '2026-08-27T12:00:00.000Z' }),
      msg({ id: 'm2', date: '2026-08-27T13:00:00.000Z', from: { addr: 'noah@birchwoodplaster.example' } }), // outbound (own address)
    ],
    ownAddresses: ['noah@birchwoodplaster.example'],
    links: [],
    navigate,
    ...overrides,
  };
  const utils = render(<CreateFromThreadMenu {...props} />);
  return { ...utils, navigate };
};

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /create/i }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'admin' }));
  h.body.mockResolvedValue({ html: '<p>hi</p>', text: 'Body text from the latest inbound message.', blockedRemoteImages: 0, attachments: [] });
  h.createLink.mockImplementation(async (b: unknown) => ({ id: 'link-1', ...(b as object) }));
  h.createTask.mockResolvedValue({ id: 'task-1' });
  h.createRfi.mockResolvedValue({ id: 'rfi-1', number: 1 });
  h.createIssue.mockResolvedValue({ id: 'iss-1', number: 1 });
  h.createChangeOrder.mockResolvedValue({ id: 'co-1', version: 1 });
  h.createInvoice.mockResolvedValue({ id: 'inv-1', version: 1 });
});

describe('CreateFromThreadMenu', () => {
  it('creates a Task with prefill from the project link, links the thread, and navigates', async () => {
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task' }));

    await waitFor(() => expect(h.createTask).toHaveBeenCalled());
    expect(h.createTask).toHaveBeenCalledWith({
      title: 'Roof detail',
      notes: 'Body text from the latest inbound message.',
      projectId: 'p1',
      customerId: null,
    });
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'task', itemId: 'task-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks?open=task-1'));
  });

  it('still navigates to the created item and shows a distinct warning when createLink fails after a successful create', async () => {
    h.createLink.mockRejectedValue(new Error('link failed'));
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task' }));

    // The item WAS created — creation itself is not reported as a failure.
    await waitFor(() => expect(h.createTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks?open=task-1'));
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/linking.*failed/i), expect.objectContaining({ type: 'warning' }));
    // No "could not create" wording anywhere — that would be false.
    expect(h.toast).not.toHaveBeenCalledWith(expect.stringMatching(/could not create/i), expect.anything());
    // The popover resets rather than staying open on a stale state.
    expect(screen.queryByTestId('create-from-thread-menu')).toBeNull();
    // A second click on the (now-closed, reopened) menu must not re-create —
    // guards against the partial-failure path inviting a duplicate.
    expect(h.createTask).toHaveBeenCalledTimes(1);
  });

  it('reports a plain creation failure (before any link attempt) and resets the menu', async () => {
    h.createTask.mockRejectedValue(new Error('create failed'));
    setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task' }));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Could not create that task.', expect.objectContaining({ type: 'error' })));
    expect(h.createLink).not.toHaveBeenCalled();
    expect(screen.queryByTestId('create-from-thread-menu')).toBeNull();
  });

  it('creates a Task with no project/customer when the thread has no project link', async () => {
    setup({ links: [] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task' }));

    await waitFor(() => expect(h.createTask).toHaveBeenCalledWith({
      title: 'Roof detail',
      notes: 'Body text from the latest inbound message.',
      projectId: null,
      customerId: null,
    }));
  });

  it('creates an RFI directly when the thread already has a project link', async () => {
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'RFI' }));

    await waitFor(() => expect(h.createRfi).toHaveBeenCalledWith('p1', {
      title: 'Roof detail',
      question: 'Body text from the latest inbound message.',
    }));
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'rfi', itemId: 'rfi-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p1/rfis?open=rfi-1'));
  });

  it('an RFI with no project link on the thread requires picking a project first', async () => {
    const { navigate } = setup({ links: [] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'RFI' }));

    // Immediately falls to a project-select step rather than creating.
    expect(h.createRfi).not.toHaveBeenCalled();
    const select = await screen.findByLabelText('Project');
    await screen.findByText('Job One');
    fireEvent.change(select, { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: /create rfi/i }));

    await waitFor(() => expect(h.createRfi).toHaveBeenCalledWith('p2', {
      title: 'Roof detail',
      question: 'Body text from the latest inbound message.',
    }));
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'rfi', itemId: 'rfi-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p2/rfis?open=rfi-1'));
  });

  it('creates an Issue directly when the thread already has a project link', async () => {
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Issue' }));

    await waitFor(() => expect(h.createIssue).toHaveBeenCalledWith('p1', {
      title: 'Roof detail',
      description: 'Body text from the latest inbound message.',
    }));
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'issue', itemId: 'iss-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p1/issues?open=iss-1'));
  });

  it('falls back to the thread snippet when the body fetch fails', async () => {
    h.body.mockRejectedValue(new Error('network'));
    setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task' }));

    await waitFor(() => expect(h.createTask).toHaveBeenCalledWith(expect.objectContaining({ notes: 'thread snippet text' })));
  });

  it('falls back to the thread snippet when there is no inbound message', async () => {
    setup({
      links: [PROJECT_LINK],
      messages: [msg({ id: 'm1', from: { addr: 'noah@birchwoodplaster.example' } })], // outbound only
    });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task' }));

    await waitFor(() => expect(h.createTask).toHaveBeenCalledWith(expect.objectContaining({ notes: 'thread snippet text' })));
    expect(h.body).not.toHaveBeenCalled();
  });

  it('trims a long body to ~2000 characters', async () => {
    const long = 'x'.repeat(3000);
    h.body.mockResolvedValue({ html: '', text: long, blockedRemoteImages: 0, attachments: [] });
    setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task' }));

    await waitFor(() => expect(h.createTask).toHaveBeenCalled());
    expect(h.createTask.mock.calls[0][0].notes.length).toBe(2000);
  });

  it('shows Change Order and Invoice for an admin', () => {
    setup({ links: [PROJECT_LINK] });
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Change Order' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Invoice' })).toBeInTheDocument();
  });

  it('hides Change Order and Invoice for a non-admin', () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'user' }));
    setup({ links: [PROJECT_LINK] });
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Change Order' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Invoice' })).toBeNull();
    // The gated-off types still don't show up as unlabeled options either.
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('creates a Change Order directly when the thread already has a project link, prefilled as a draft', async () => {
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change Order' }));

    await waitFor(() => expect(h.createChangeOrder).toHaveBeenCalledWith('p1', {
      title: 'Roof detail',
      description: 'Body text from the latest inbound message.',
    }));
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'changeOrder', itemId: 'co-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p1/billing?tab=change-orders&open=co-1'));
  });

  it('a Change Order with no project link on the thread requires picking a project first', async () => {
    const { navigate } = setup({ links: [] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change Order' }));

    expect(h.createChangeOrder).not.toHaveBeenCalled();
    const select = await screen.findByLabelText('Project');
    await screen.findByText('Job One');
    fireEvent.change(select, { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: /create change order/i }));

    await waitFor(() => expect(h.createChangeOrder).toHaveBeenCalledWith('p2', {
      title: 'Roof detail',
      description: 'Body text from the latest inbound message.',
    }));
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'changeOrder', itemId: 'co-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p2/billing?tab=change-orders&open=co-1'));
  });

  it('still navigates and shows a distinct warning when createLink fails after a Change Order is created', async () => {
    h.createLink.mockRejectedValue(new Error('link failed'));
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change Order' }));

    await waitFor(() => expect(h.createChangeOrder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p1/billing?tab=change-orders&open=co-1'));
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/linking.*failed/i), expect.objectContaining({ type: 'warning' }));
  });

  it('creates an Invoice directly when the thread already has a project link, prefilling notes from subject + inbound text', async () => {
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invoice' }));

    // Invoice's only free-text field is `notes` (internal-only) — it carries
    // both the subject and inbound-text prefill the CO path splits across
    // title/description.
    await waitFor(() => expect(h.createInvoice).toHaveBeenCalledWith('p1', {
      lines: [],
      notes: 'Roof detail\n\nBody text from the latest inbound message.',
    }));
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'invoice', itemId: 'inv-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p1/billing?tab=invoices&open=inv-1'));
  });

  it('an Invoice with no project link on the thread requires picking a project first', async () => {
    const { navigate } = setup({ links: [] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invoice' }));

    expect(h.createInvoice).not.toHaveBeenCalled();
    const select = await screen.findByLabelText('Project');
    await screen.findByText('Job One');
    fireEvent.change(select, { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => expect(h.createInvoice).toHaveBeenCalledWith('p2', {
      lines: [],
      notes: 'Roof detail\n\nBody text from the latest inbound message.',
    }));
    await waitFor(() => expect(h.createLink).toHaveBeenCalledWith({ threadKey: 'tk-1', itemType: 'invoice', itemId: 'inv-1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p2/billing?tab=invoices&open=inv-1'));
  });

  it('still navigates and shows a distinct warning when createLink fails after an Invoice is created', async () => {
    h.createLink.mockRejectedValue(new Error('link failed'));
    const { navigate } = setup({ links: [PROJECT_LINK] });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Invoice' }));

    await waitFor(() => expect(h.createInvoice).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/project/p1/billing?tab=invoices&open=inv-1'));
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/linking.*failed/i), expect.objectContaining({ type: 'warning' }));
  });
});
