// Shared types for the AI sheet-reading feature (Claude reads plan sheets). Kept dependency-free so
// both the pure logic (prompt/handlers) and the real runner import them.

/** Result of reading one plan sheet. */
export interface SheetRead {
  /** Sheet identifier, normalized upper-case (e.g. "A-201", "S1.1"). '' if unknown. */
  sheetNumber: string;
  /** Sheet title/description (e.g. "SECOND FLOOR PLAN"). '' if unknown. */
  sheetTitle: string;
  /** Discipline label if the model inferred one (e.g. "Architectural"). Optional. */
  discipline?: string;
  /** Model confidence, clamped to 0..1. */
  confidence: number;
}

/** An existing logical sheet a new page can be matched against. */
export interface ExistingSheetRef {
  sheetId: string;
  number: string;
  title: string;
}

/** Result of matching a new page against existing sheets. */
export interface SheetMatch {
  /** A sheetId from the provided list, or null for "new sheet". */
  matchSheetId: string | null;
  confidence: number;
  reason?: string;
}

/** Capability/info for the status endpoint. */
export interface AiInfo {
  model: string;
  /** 'cloud' = Claude (Anthropic); 'none' = no AI configured. */
  device: 'cloud' | 'none';
}

/** Why the last AI call failed, in words for the person using the app. */
export type AiErrorCode = 'auth' | 'rate_limit' | 'billing' | 'model' | 'timeout' | 'other';
export interface AiLastError { code: AiErrorCode; message: string; at: string; }

/** Runner lifecycle state. */
export type AiState = 'off' | 'idle' | 'loading' | 'ready';

/** Region transcription: read exactly what's in a small crop, no interpretation. */
export type TranscribeMode = 'number' | 'description';
export interface TranscribeResult { text: string; confidence: number; }

/** The inference boundary. Faked in tests; real impl in claudeRunner.ts. */
export interface AiRunner {
  /** Feature usable (credentials present); never calls out. */
  configured(): boolean;
  /** Current lifecycle state; never calls out. */
  state(): Promise<AiState>;
  /** Kept for the client contract; a no-op for Claude (nothing to load). */
  warmup(idleTimeoutMs?: number): void;
  info(): AiInfo;
  /** The last call's failure, cleared by the next success. */
  lastError?(): AiLastError | null;
  /** `titleBlock` is a higher-resolution crop of the title-block corner. */
  readSheet(input: { image: Buffer; titleBlock?: Buffer; embeddedText?: string; prompt?: string; idleTimeoutMs?: number }): Promise<SheetRead>;
  matchSheet(input: { page: SheetRead; existing: ExistingSheetRef[]; idleTimeoutMs?: number }): Promise<SheetMatch>;
  transcribeRegion(input: { image: Buffer; mode: TranscribeMode; idleTimeoutMs?: number }): Promise<TranscribeResult>;
}
