import { useState } from 'react';
import { Measurement, ProjectPage } from '../types';

export type HistoryAction =
  | { type: 'add'; measurement: Measurement }
  | { type: 'delete'; measurement: Measurement }
  | { type: 'update'; measurementId: string; before: Partial<Measurement>; after: Partial<Measurement> };

interface UseMeasurementHistoryArgs {
  page: ProjectPage | null;
  selectedMeasurementId: string | null;
  setSelectedMeasurementId: (id: string | null) => void;
  // Replaces the page's measurements array in LOCAL state only (no project
  // PUT) — Task 5 routes undo/redo through the same realtime op path as every
  // other measurement mutation, so durable persistence + the version bump
  // come from sendMeasurementOp below, not from this callback.
  applyMeasurements: (measurements: Measurement[]) => void;
  toast: (message: string, options?: { type?: 'info' | 'success' | 'warning' | 'error'; duration?: number }) => void;
  sendMeasurementOp: (op: { projectId: string; pageId: string; action: 'add' | 'update' | 'delete';
    measurement: Record<string, unknown> & { id: string } }) =>
    Promise<{ ok: true; version: number } | { ok: false; error: string }>;
  onMeasurementOpResult: (res: { ok: true; version: number } | { ok: false; error: string }) => void;
  projectId: string | undefined;
}

export function useMeasurementHistory({
  page,
  selectedMeasurementId,
  setSelectedMeasurementId,
  applyMeasurements,
  toast,
  sendMeasurementOp,
  onMeasurementOpResult,
  projectId,
}: UseMeasurementHistoryArgs) {
  const [history, setHistory] = useState<HistoryAction[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryAction[]>([]);

  const pushToHistory = (action: HistoryAction) => {
    setHistory(prev => [...prev, action].slice(-50));
    setRedoStack([]);
  };

  // Fire-and-forget, same pattern as every other measurement call site in
  // CanvasView — the ack adopts the version (or surfaces a toast) via
  // onMeasurementOpResult.
  const sendOp = (opAction: 'add' | 'update' | 'delete', measurement: Measurement) => {
    if (!page || !projectId) return;
    void sendMeasurementOp({
      projectId,
      pageId: page.id,
      action: opAction,
      measurement: measurement as unknown as Record<string, unknown> & { id: string },
    }).then(onMeasurementOpResult);
  };

  const applyAction = (action: HistoryAction, direction: 'undo' | 'redo') => {
    if (!page) return;
    if (action.type === 'add') {
      if (direction === 'undo') {
        applyMeasurements(page.measurements.filter(m => m.id !== action.measurement.id));
        sendOp('delete', action.measurement);
        if (selectedMeasurementId === action.measurement.id) setSelectedMeasurementId(null);
      } else {
        applyMeasurements([...page.measurements, action.measurement]);
        sendOp('add', action.measurement);
      }
    } else if (action.type === 'delete') {
      if (direction === 'undo') {
        applyMeasurements([...page.measurements, action.measurement]);
        sendOp('add', action.measurement);
      } else {
        applyMeasurements(page.measurements.filter(m => m.id !== action.measurement.id));
        sendOp('delete', action.measurement);
      }
    } else if (action.type === 'update') {
      const patch = direction === 'undo' ? action.before : action.after;
      const existing = page.measurements.find(m => m.id === action.measurementId);
      applyMeasurements(page.measurements.map(m => m.id === action.measurementId ? { ...m, ...patch } : m));
      if (existing) sendOp('update', { ...existing, ...patch });
    }
  };

  const undo = () => {
    if (history.length === 0 || !page) return;
    const lastAction = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, lastAction]);
    applyAction(lastAction, 'undo');
    toast('Undone', { type: 'info', duration: 1500 });
  };

  const redo = () => {
    if (redoStack.length === 0 || !page) return;
    const action = redoStack[redoStack.length - 1];
    setRedoStack(prev => prev.slice(0, -1));
    setHistory(prev => [...prev, action]);
    applyAction(action, 'redo');
    toast('Redone', { type: 'info', duration: 1500 });
  };

  const reset = () => {
    setHistory([]);
  };

  return { history, redoStack, pushToHistory, undo, redo, reset };
}
