// Shared types for the local AI sheet-reading feature. Kept dependency-free so
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
  device: 'cuda' | 'cpu' | 'none';
}

/** Runner lifecycle state. */
export type AiState = 'off' | 'idle' | 'loading' | 'ready';

/** Region transcription: read exactly what's in a small crop, no interpretation. */
export type TranscribeMode = 'number' | 'description';
export interface TranscribeResult { text: string; confidence: number; }

/** The inference boundary. Faked in tests; real impl in runner.ts. */
export interface AiRunner {
  /** Feature usable (enabled + binary present); NEVER spawns. */
  configured(): boolean;
  /** Current lifecycle state; NEVER spawns. */
  state(): Promise<AiState>;
  /** Spawn the model if idle (non-blocking); (re)arm the idle-unload timer. */
  warmup(idleTimeoutMs?: number): void;
  info(): AiInfo;
  readSheet(input: { image: Buffer; embeddedText?: string; prompt?: string; idleTimeoutMs?: number }): Promise<SheetRead>;
  matchSheet(input: { page: SheetRead; existing: ExistingSheetRef[]; idleTimeoutMs?: number }): Promise<SheetMatch>;
  transcribeRegion(input: { image: Buffer; mode: TranscribeMode; idleTimeoutMs?: number }): Promise<TranscribeResult>;
}
