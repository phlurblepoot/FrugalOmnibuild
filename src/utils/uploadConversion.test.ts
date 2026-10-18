import { describe, it, expect, vi } from 'vitest';
import { reportConversions } from './uploadConversion';

describe('reportConversions', () => {
  it('says what was converted, once, and each file that could not be', () => {
    const toast = vi.fn();
    reportConversions(toast, [
      { name: 'Budget.xls', conversion: { status: 'converted', from: 'xls', to: 'xlsx', name: 'Budget.xlsx' } },
      { name: 'Photo.jpg' },
    ]);
    expect(toast).toHaveBeenCalledWith('"Budget.xls" was converted to .xlsx so it can be edited. The original is kept as version 1.', { type: 'info' });

    toast.mockClear();
    reportConversions(toast, [
      { name: 'A.doc', conversion: { status: 'converted', from: 'doc', to: 'docx', name: 'A.docx' } },
      { name: 'B.odt', conversion: { status: 'converted', from: 'odt', to: 'docx', name: 'B.docx' } },
      { name: 'C.pages', conversion: { status: 'failed', from: 'pages', to: 'docx', message: 'Kept as .pages: The file is password-protected.' } },
    ]);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^2 files were converted/), { type: 'info' });
    expect(toast).toHaveBeenCalledWith('"C.pages": Kept as .pages: The file is password-protected.', { type: 'warning' });
  });

  it('stays quiet when nothing needed converting', () => {
    const toast = vi.fn();
    reportConversions(toast, [{ name: 'a.docx' }]);
    expect(toast).not.toHaveBeenCalled();
  });
});
