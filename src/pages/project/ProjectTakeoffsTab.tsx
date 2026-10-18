// src/pages/project/ProjectTakeoffsTab.tsx
//
// Takeoffs tab content extracted verbatim from ProjectView (Phase 5g Task 3).
// Behavior-preserving controlled component: ALL state, setters, handlers, and
// computed values live in ProjectView and are passed in as props. Only the JSX
// moved here. The toolbar (highlight-quality select + Print/Excel/Proposal/
// Delete-all/New-takeoff buttons), the desktop table (batch + per-row checkboxes
// + expandable per-page/per-measurement cost-breakdown rows), the mobile cards,
// and the empty state are unchanged (same classes/testids/handlers). The pure
// math/cost-allocation utils and the HIGHLIGHT_QUALITY_PRESETS dropdown source
// are imported directly here because they have no component state.
//
// CRITICAL: the highlight-quality select + Print + Excel + Proposal buttons only
// render when selectedTakeoffIds.size > 0 — this selection gating is preserved
// exactly (export.spec asserts the buttons are absent before selection).
import React from 'react';
import { Link, NavigateFunction } from 'react-router-dom';
import {
  Plus, Trash2, ChevronRight, Edit2, Loader2, Printer, FileText, FileImage, FileSpreadsheet,
} from 'lucide-react';
import { Project, MeasurementTakeoff } from '../../types';
import { formatRealValue, calculateTakeoffTotalCost, calculateTakeoffCostDetails, roundUpTo100 } from '../../utils/math';
import { allocateSubsetCost, allocateSubsetDetails } from '../../utils/costAllocation';
import { HIGHLIGHT_QUALITY_PRESETS, HighlightQuality, TakeoffTotals, TakeoffMeasurementTotal } from './proposal/proposalGenerator';
import { takeoffPrintsUrl } from '../../utils/takeoffPrintNames';
import { multipliedText } from '../../utils/multiplier';

// A measurement row's quantity — what it counts for — with its math above it
// when it is multiplied: "1250.00 sq ft × 4 =" / "5000.00 sq ft".
function measurementQty(meas: TakeoffMeasurementTotal, format: (value: number) => string, mathClassName: string): React.ReactNode {
  const q = multipliedText(meas.baseValue, meas.multiplier, format);
  return (
    <>
      {q.math && <span data-testid="takeoff-measurement-math" className={`block ${mathClassName}`}>{q.math} </span>}
      {q.total}
    </>
  );
}

interface ProjectTakeoffsTabProps {
  // state / computed
  project: Project;
  selectedTakeoffIds: Set<string>;
  expandedTakeoffs: Record<string, boolean>;
  expandedTakeoffPages: Record<string, boolean>;
  highlightQuality: HighlightQuality;
  isPrinting: boolean;
  isExportingExcel: boolean;
  searchTerm: string;
  projectId: string | undefined;
  getTakeoffTotals: () => TakeoffTotals[];
  // setters
  setHighlightQuality: (q: HighlightQuality) => void;
  setShowTakeoffModal: (open: boolean) => void;
  setShowDeleteAllConfirm: (open: boolean) => void;
  setSelectedTakeoffIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  isAdmin: boolean;
  // handlers
  handlePrint: () => void;
  handleExportExcel: () => void;
  onCreateProposal: () => void;
  toggleTakeoffSelection: (takeoffId: string) => void;
  toggleTakeoffExpanded: (takeoffId: string) => void;
  toggleTakeoffPageExpanded: (takeoffId: string, pageId: string) => void;
  handleEditTakeoff: (takeoff: MeasurementTakeoff) => void;
  handleDeleteTakeoff: (takeoffId: string) => void;
  navigate: NavigateFunction;
}

export const ProjectTakeoffsTab: React.FC<ProjectTakeoffsTabProps> = ({
  project,
  selectedTakeoffIds,
  expandedTakeoffs,
  expandedTakeoffPages,
  highlightQuality,
  isPrinting,
  isExportingExcel,
  searchTerm,
  projectId,
  getTakeoffTotals,
  isAdmin,
  setHighlightQuality,
  setShowTakeoffModal,
  setShowDeleteAllConfirm,
  setSelectedTakeoffIds,
  handlePrint,
  handleExportExcel,
  onCreateProposal,
  toggleTakeoffSelection,
  toggleTakeoffExpanded,
  toggleTakeoffPageExpanded,
  handleEditTakeoff,
  handleDeleteTakeoff,
  navigate,
}) => {
  return (
          <div className="bg-raised rounded-xl border border-edge overflow-hidden shadow-sm">
            <div className="p-4 md:p-6 border-b border-edge flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-sunken/50">
              <h2 className="text-xl font-bold text-ink">Takeoffs Inventory</h2>
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                {selectedTakeoffIds.size > 0 && (
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <select
                      data-testid="print-quality-select"
                      value={highlightQuality}
                      onChange={e => setHighlightQuality(e.target.value as HighlightQuality)}
                      title="Blueprint print quality"
                      className="text-xs px-2 py-2 rounded-lg border border-edge-strong bg-raised text-ink focus:ring-1 focus:ring-accent-500 outline-none transition-colors"
                    >
                      {(Object.entries(HIGHLIGHT_QUALITY_PRESETS) as [HighlightQuality, { label: string }][]).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      data-testid="btn-print"
                      onClick={handlePrint}
                      disabled={isPrinting || isExportingExcel}
                      className="flex-1 sm:flex-none px-3 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isPrinting ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                      Print ({selectedTakeoffIds.size})
                    </button>
                    <button
                      data-testid="btn-export-excel"
                      onClick={handleExportExcel}
                      disabled={isPrinting || isExportingExcel}
                      className="flex-1 sm:flex-none px-3 py-2 bg-accent-600 text-white rounded-lg text-xs font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isExportingExcel ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
                      Excel ({selectedTakeoffIds.size})
                    </button>
                    {isAdmin && (
                      <button
                        data-testid="btn-proposal"
                        onClick={onCreateProposal}
                        className="flex-1 sm:flex-none px-3 py-2 bg-violet-600 text-white rounded-lg text-xs font-medium hover:bg-violet-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                      >
                        <FileText size={14} />
                        Proposal
                      </button>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <Link to={takeoffPrintsUrl(projectId ?? '')} className="text-xs text-accent-600 hover:underline whitespace-nowrap">Takeoff prints</Link>
                  {project.takeoffs.length > 0 && (
                    <button
                      onClick={() => setShowDeleteAllConfirm(true)}
                      className="p-2 text-ink-faint hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                      title="Delete All Takeoffs"
                    >
                      <Trash2 size={20} />
                    </button>
                  )}
                  <button
                    data-testid="btn-new-takeoff"
                    onClick={() => setShowTakeoffModal(true)}
                    className="flex-1 sm:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                  >
                    <Plus size={16} />
                    New Takeoff
                  </button>
                </div>
              </div>
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table data-testid="takeoffs-table" className="w-full border-collapse">
                <thead>
                  <tr className="bg-sunken text-left text-[10px] font-bold text-ink-soft uppercase tracking-widest border-b border-edge">
                    <th className="px-6 py-4 w-10">
                      <input
                        type="checkbox"
                        className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
                        checked={selectedTakeoffIds.size === project.takeoffs.length && project.takeoffs.length > 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedTakeoffIds(new Set(project.takeoffs.map(t => t.id)));
                          } else {
                            setSelectedTakeoffIds(new Set());
                          }
                        }}
                      />
                    </th>
                    <th className="px-6 py-4">Takeoff</th>
                    <th className="px-6 py-4">Type</th>
                    <th className="px-6 py-4 text-right">Qty</th>
                    <th className="px-6 py-4 text-right">Unit Cost</th>
                    <th className="px-6 py-4 text-right">Total Cost</th>
                    <th className="px-6 py-4 w-24"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {(() => {
                    const totals = getTakeoffTotals();
                    const packageOrder: string[] = [];
                    const packageMap: Record<string, typeof totals> = {};
                    const ungrouped: typeof totals = [];
                    for (const t of totals) {
                      if (t.pricePackage) {
                        if (!packageMap[t.pricePackage]) {
                          packageMap[t.pricePackage] = [];
                          packageOrder.push(t.pricePackage);
                        }
                        packageMap[t.pricePackage].push(t);
                      } else {
                        ungrouped.push(t);
                      }
                    }
                    const renderRow = (takeoff: typeof totals[0]) => {
                      const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
                      const costDetails = calculateTakeoffCostDetails(takeoff, takeoff.totalRealValue);
                      return (
                        <React.Fragment key={takeoff.id}>
                          <tr data-testid="takeoff-row" className="hover:bg-hover transition-colors group border-l-4" style={{ borderLeftColor: takeoff.color }}>
                            <td className="px-6 py-4">
                              <input
                                type="checkbox"
                                className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
                                checked={selectedTakeoffIds.has(takeoff.id)}
                                onChange={() => toggleTakeoffSelection(takeoff.id)}
                              />
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleTakeoffExpanded(takeoff.id)}>
                                <div className={`transition-transform duration-200 ${expandedTakeoffs[takeoff.id] ? 'rotate-90' : ''}`}>
                                  <ChevronRight size={16} className="text-ink-faint" />
                                </div>
                                <div className="w-4 h-4 rounded-full shadow-sm shrink-0" style={{ backgroundColor: takeoff.color }} />
                                <span className="font-semibold text-ink">{takeoff.name}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-ink-soft capitalize font-medium">
                              {takeoff.type}
                            </td>
                            <td className="px-6 py-4 text-right font-bold text-ink">
                              {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                            </td>
                            <td className="px-6 py-4 text-right text-sm text-ink-soft font-medium">
                              {takeoff.isAdvancedCost ? (
                                <div className="flex flex-col items-end">
                                  <span className="text-accent-600 dark:text-accent-400 font-bold">${(totalCost / (takeoff.totalRealValue || 1)).toFixed(2)}</span>
                                  <span className="text-[10px] text-ink-faint uppercase">Avg / Unit</span>
                                </div>
                              ) : (
                                takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                              )}
                            </td>
                            <td className="px-6 py-4 text-right font-bold text-accent-600 dark:text-accent-400">
                              <div className="flex flex-col items-end">
                                <span>{totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-'}</span>
                                {takeoff.isAdvancedCost && costDetails.map((d, i) => (
                                  d.quantity !== undefined && d.quantity > 0 && (
                                    <span key={i} className="text-[10px] text-ink-soft font-normal">
                                      {d.quantity.toFixed(2)} {d.quantityUnit || 'units'} of {d.name}
                                    </span>
                                  )
                                ))}
                              </div>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  data-testid="btn-edit-takeoff"
                                  onClick={() => handleEditTakeoff(takeoff)}
                                  className="text-ink-faint hover:text-accent-600 p-2 rounded-lg hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors"
                                  title="Edit Takeoff"
                                >
                                  <Edit2 size={16} />
                                </button>
                                <button
                                  data-testid="btn-delete-takeoff"
                                  onClick={() => handleDeleteTakeoff(takeoff.id)}
                                  className="text-ink-faint hover:text-red-600 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                                  title="Delete Takeoff"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                          {expandedTakeoffs[takeoff.id] && (
                            <tr>
                              <td colSpan={11} className="px-0 py-0 bg-sunken/30">
                                <div className="border-l-4 border-accent-500/20 ml-6 my-2 divide-y divide-edge">
                                  {(() => {
                                    return takeoff.pageBreakdown.map(pb => {
                                      const pageKey = `${takeoff.id}__${pb.pageId}`;
                                      const isPageExpanded = !!expandedTakeoffPages[pageKey];
                                      const pageTotalCost = allocateSubsetCost(takeoff, pb.realValue);
                                      const pageCostDetails = allocateSubsetDetails(takeoff, pb.realValue);
                                      return (
                                        <div key={pb.pageId}>
                                          <div className="py-3 pl-8 pr-6 grid grid-cols-[minmax(0,1fr)_140px_140px_180px] gap-4 items-start hover:bg-hover transition-colors">
                                            <div className="flex items-center gap-2 min-w-0">
                                              <button
                                                type="button"
                                                onClick={() => toggleTakeoffPageExpanded(takeoff.id, pb.pageId)}
                                                className="p-0.5 rounded hover:bg-hover"
                                                title={isPageExpanded ? 'Hide measurements' : 'Show measurements'}
                                              >
                                                <div className={`transition-transform duration-200 ${isPageExpanded ? 'rotate-90' : ''}`}>
                                                  <ChevronRight size={14} className="text-ink-faint" />
                                                </div>
                                              </button>
                                              <Link
                                                to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                                                state={{ pageIds: takeoff.pageBreakdown.map(p => p.pageId) }}
                                                className="text-sm text-accent-600 dark:text-accent-400 hover:text-accent-800 font-semibold flex items-center gap-2 min-w-0"
                                              >
                                                <FileImage size={14} className="text-ink-faint shrink-0" />
                                                <span className="truncate">{pb.pageName}</span>
                                              </Link>
                                            </div>
                                            <div className="text-right text-sm font-bold text-ink">
                                              {pb.realValue > 0 ? formatRealValue(pb.realValue, takeoff.type as 'length' | 'area' | 'count', pb.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                                            </div>
                                            <div className="text-right text-sm text-ink-soft font-medium">
                                              {takeoff.isAdvancedCost ? (
                                                <div className="flex flex-col items-end">
                                                  <span className="text-accent-600 dark:text-accent-400 font-semibold">${(pageTotalCost / (pb.realValue || 1)).toFixed(2)}</span>
                                                  <span className="text-[10px] text-ink-faint uppercase">Avg / Unit</span>
                                                </div>
                                              ) : (
                                                takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                                              )}
                                            </div>
                                            <div className="text-right">
                                              <div className="flex flex-col items-end">
                                                <span className="text-sm font-bold text-accent-600 dark:text-accent-400">
                                                  {pageTotalCost > 0 ? `$${roundUpTo100(pageTotalCost).toLocaleString()}` : '-'}
                                                </span>
                                                {takeoff.isAdvancedCost && pageCostDetails.map((d, i) => (
                                                  <span key={i} className="text-[10px] text-ink-soft font-normal">
                                                    {d.quantity !== undefined && d.quantity > 0
                                                      ? `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'} of ${d.name}`
                                                      : `${d.name}: $${(d.costValue || 0).toFixed(2)}`}
                                                  </span>
                                                ))}
                                              </div>
                                            </div>
                                          </div>
                                          {isPageExpanded && (
                                            <div className="bg-raised/60 border-t border-edge divide-y divide-edge">
                                              {pb.measurements.map(meas => {
                                                const measTotalCost = allocateSubsetCost(takeoff, meas.realValue);
                                                const measCostDetails = allocateSubsetDetails(takeoff, meas.realValue);
                                                return (
                                                  <div key={meas.id} className="py-2 pl-16 pr-6 grid grid-cols-[minmax(0,1fr)_140px_140px_180px] gap-4 items-start text-xs">
                                                    <span className="text-ink-soft truncate">{meas.name || 'Measurement'}</span>
                                                    <div data-testid="takeoff-measurement-qty" className="text-right font-semibold text-ink">
                                                      {meas.realValue > 0
                                                        ? measurementQty(meas, v => formatRealValue(v, takeoff.type as 'length' | 'area' | 'count', meas.unit?.replace('sq ', '') || 'ft', takeoff, false), 'text-[10px] font-medium text-ink-soft')
                                                        : '-'}
                                                    </div>
                                                    <div className="text-right text-ink-soft font-medium">
                                                      {takeoff.isAdvancedCost ? (
                                                        <div className="flex flex-col items-end">
                                                          <span className="text-accent-600 dark:text-accent-400 font-semibold">${(measTotalCost / (meas.realValue || 1)).toFixed(2)}</span>
                                                          <span className="text-[9px] text-ink-faint uppercase">Avg / Unit</span>
                                                        </div>
                                                      ) : (
                                                        takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                                                      )}
                                                    </div>
                                                    <div className="text-right">
                                                      <div className="flex flex-col items-end">
                                                        <span className="font-semibold text-accent-600 dark:text-accent-400">
                                                          {measTotalCost > 0 ? `$${roundUpTo100(measTotalCost).toLocaleString()}` : '-'}
                                                        </span>
                                                        {takeoff.isAdvancedCost && measCostDetails.map((d, i) => (
                                                          <span key={i} className="text-[9px] text-ink-soft font-normal">
                                                            {d.quantity !== undefined && d.quantity > 0
                                                              ? `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'} of ${d.name}`
                                                              : `${d.name}: $${(d.costValue || 0).toFixed(2)}`}
                                                          </span>
                                                        ))}
                                                      </div>
                                                    </div>
                                                  </div>
                                                );
                                              })}
                                              {pb.measurements.length === 0 && (
                                                <div className="py-2 pl-16 text-xs text-ink-faint italic">No measurements.</div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    });
                                  })()}
                                  {takeoff.pageBreakdown.length === 0 && (
                                    <div className="py-4 pl-8 text-sm text-ink-faint italic">No measurements found for this takeoff.</div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    };
                    return (
                      <>
                        {packageOrder.map(pkg => (
                          <React.Fragment key={`pkg-${pkg}`}>
                            <tr className="bg-sunken/70">
                              <td colSpan={7} className="px-6 py-2">
                                <span className="text-[10px] font-bold text-ink-soft uppercase tracking-widest">{pkg}</span>
                              </td>
                            </tr>
                            {packageMap[pkg].map(renderRow)}
                          </React.Fragment>
                        ))}
                        {ungrouped.map(renderRow)}
                      </>
                    );
                  })()}
                </tbody>
              </table>
            </div>

            {/* Mobile Takeoff Cards */}
            <div className="md:hidden divide-y divide-edge">
              {(() => {
                const totals = getTakeoffTotals();
                const packageOrder: string[] = [];
                const packageMap: Record<string, typeof totals> = {};
                const ungrouped: typeof totals = [];
                for (const t of totals) {
                  if (t.pricePackage) {
                    if (!packageMap[t.pricePackage]) {
                      packageMap[t.pricePackage] = [];
                      packageOrder.push(t.pricePackage);
                    }
                    packageMap[t.pricePackage].push(t);
                  } else {
                    ungrouped.push(t);
                  }
                }
                const renderCard = (takeoff: typeof totals[0]) => {
                  const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
                  return (
                    <div data-testid="takeoff-row" key={takeoff.id} className="p-4 bg-raised border-l-4" style={{ borderLeftColor: takeoff.color }}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
                            checked={selectedTakeoffIds.has(takeoff.id)}
                            onChange={() => toggleTakeoffSelection(takeoff.id)}
                          />
                          <div className="w-3 h-3 rounded-full shadow-sm shrink-0" style={{ backgroundColor: takeoff.color }} />
                          <span className="font-bold text-ink">{takeoff.name}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            data-testid="btn-edit-takeoff"
                            onClick={() => handleEditTakeoff(takeoff)}
                            className="p-1.5 text-ink-faint hover:text-accent-600"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            data-testid="btn-delete-takeoff"
                            onClick={() => handleDeleteTakeoff(takeoff.id)}
                            className="p-1.5 text-ink-faint hover:text-red-600"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-y-2 text-sm mb-3">
                        <div className="text-ink-soft">Type</div>
                        <div className="text-ink font-medium capitalize text-right">{takeoff.type}</div>

                        <div className="text-ink-soft">Quantity</div>
                        <div className="text-ink font-bold text-right">
                          {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                        </div>

                        <div className="text-ink-soft">Total Cost</div>
                        <div className="text-accent-600 dark:text-accent-400 font-bold text-right">
                          {totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-'}
                        </div>
                      </div>

                      <button
                        onClick={() => toggleTakeoffExpanded(takeoff.id)}
                        className="w-full py-2 bg-sunken rounded-lg text-xs font-semibold text-ink-soft flex items-center justify-center gap-2"
                      >
                        {expandedTakeoffs[takeoff.id] ? 'Hide' : 'Show'} Page Breakdown
                        <div className={`transition-transform duration-200 ${expandedTakeoffs[takeoff.id] ? 'rotate-90' : ''}`}>
                          <ChevronRight size={14} />
                        </div>
                      </button>

                      {expandedTakeoffs[takeoff.id] && (() => {
                        // meas: a measurement row, whose Qty shows its math when multiplied.
                        const renderStats = (subsetValue: number, unit: string, small: boolean, meas?: TakeoffMeasurementTotal) => {
                          const subsetCost = allocateSubsetCost(takeoff, subsetValue);
                          const subsetDetails = allocateSubsetDetails(takeoff, subsetValue);
                          const formatQty = (v: number) => formatRealValue(v, takeoff.type as 'length' | 'area' | 'count', unit?.replace('sq ', '') || 'ft', takeoff, false);
                          return (
                            <div className={`grid grid-cols-3 gap-2 ${small ? 'text-[10px]' : 'text-[11px]'}`}>
                              <div>
                                <div className="text-ink-soft uppercase tracking-wide">Qty</div>
                                <div className="font-bold text-ink">
                                  {subsetValue > 0
                                    ? (meas ? measurementQty(meas, formatQty, 'text-[9px] font-medium text-ink-soft') : formatQty(subsetValue))
                                    : '-'}
                                </div>
                              </div>
                              <div>
                                <div className="text-ink-soft uppercase tracking-wide">Unit Cost</div>
                                <div className="font-semibold text-ink">
                                  {takeoff.isAdvancedCost ? (
                                    <span className="text-accent-600 dark:text-accent-400">${(subsetCost / (subsetValue || 1)).toFixed(2)}<span className="text-[9px] text-ink-faint ml-0.5">avg</span></span>
                                  ) : (
                                    takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="text-ink-soft uppercase tracking-wide">Total</div>
                                <div className="font-bold text-accent-600 dark:text-accent-400">
                                  {subsetCost > 0 ? `$${roundUpTo100(subsetCost).toLocaleString()}` : '-'}
                                </div>
                              </div>
                              {takeoff.isAdvancedCost && subsetDetails.length > 0 && (
                                <div className="col-span-3 mt-1 pt-1 border-t border-edge space-y-0.5">
                                  {subsetDetails.map((d, i) => (
                                    <div key={i} className="flex justify-between text-[9px] text-ink-soft">
                                      <span className="truncate">{d.name}</span>
                                      <span className="shrink-0 ml-2">
                                        {d.quantity !== undefined && d.quantity > 0
                                          ? `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'} · $${(d.costValue || 0).toFixed(2)}`
                                          : `$${(d.costValue || 0).toFixed(2)}`}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        };
                        return (
                          <div className="mt-3 pt-3 border-t border-edge divide-y divide-edge">
                            {takeoff.pageBreakdown.map(pb => {
                              const pageKey = `${takeoff.id}__${pb.pageId}`;
                              const isPageExpanded = !!expandedTakeoffPages[pageKey];
                              return (
                                <div key={pb.pageId} className="py-3">
                                  <div className="flex items-center gap-2 mb-2 text-xs">
                                    <button
                                      type="button"
                                      onClick={() => toggleTakeoffPageExpanded(takeoff.id, pb.pageId)}
                                      className="p-0.5 rounded hover:bg-hover"
                                      title={isPageExpanded ? 'Hide measurements' : 'Show measurements'}
                                    >
                                      <div className={`transition-transform duration-200 ${isPageExpanded ? 'rotate-90' : ''}`}>
                                        <ChevronRight size={12} className="text-ink-faint" />
                                      </div>
                                    </button>
                                    <Link
                                      to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                                      className="text-accent-600 dark:text-accent-400 font-semibold truncate"
                                    >
                                      {pb.pageName}
                                    </Link>
                                  </div>
                                  {renderStats(pb.realValue, pb.unit, false)}
                                  {isPageExpanded && (
                                    <div className="mt-2 ml-5 pl-3 border-l border-edge space-y-2">
                                      {pb.measurements.map(meas => (
                                        <div key={meas.id}>
                                          <div className="text-[11px] text-ink-soft font-medium truncate mb-1">
                                            {meas.name || 'Measurement'}
                                          </div>
                                          {renderStats(meas.realValue, meas.unit, true, meas)}
                                        </div>
                                      ))}
                                      {pb.measurements.length === 0 && (
                                        <div className="text-[11px] text-ink-faint italic">No measurements.</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  );
                };
                return (
                  <>
                    {packageOrder.map(pkg => (
                      <React.Fragment key={`pkg-${pkg}`}>
                        <div className="px-4 py-2 bg-sunken/70">
                          <span className="text-[10px] font-bold text-ink-soft uppercase tracking-widest">{pkg}</span>
                        </div>
                        {packageMap[pkg].map(renderCard)}
                      </React.Fragment>
                    ))}
                    {ungrouped.map(renderCard)}
                  </>
                );
              })()}
            </div>

            {project.takeoffs.length === 0 && (
              <div className="px-6 py-12 text-center text-ink-soft">
                No takeoffs created yet. <button onClick={() => setShowTakeoffModal(true)} className="text-accent-600 dark:text-accent-400 font-bold hover:underline">Create one</button> to start estimating.
              </div>
            )}
          </div>
  );
};
