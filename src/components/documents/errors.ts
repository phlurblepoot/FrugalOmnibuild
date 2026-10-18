// src/components/documents/errors.ts
// Shared sentinel so a mid-send cancel can be told apart from a real send
// failure. Lives in its own module because both DocumentActionsBar (which
// throws it when the pre-send save fails and has already been reported) and
// MailComposer
// (which must not toast an error for it) need it.
export class DocumentGenerationCancelled extends Error {
  constructor() {
    super('document-generation-cancelled');
    this.name = 'DocumentGenerationCancelled';
  }
}
