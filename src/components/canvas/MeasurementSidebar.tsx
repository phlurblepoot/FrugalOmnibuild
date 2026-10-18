import React from 'react';
import { Link } from 'react-router-dom';
import { Plus, Edit2, Trash2, ChevronLeft, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, Search, GitMerge } from 'lucide-react';
import { Measurement, ScaleConfig, Tool, Project, ProjectPage, MeasurementTakeoff } from '../../types';
import { formatRealValue } from '../../utils/math';
import { MeasurementItem } from './MeasurementItem';
import { multipliersMatch } from '../../utils/multiplier';

type TakeoffTotal = MeasurementTakeoff & { totalRealValue: number; measurementsCount: number };

interface MeasurementSidebarProps {
  project: Project;
  page: ProjectPage;
  // Pages backing the rendered takeoff/measurement list. Already resolved by the
  // caller to reflect the intended revision(s): the current revision per sheet
  // (viewed revision for the sheet being browsed) by default, or the single
  // viewed page when "Current page only" is on. NEVER superseded revisions of
  // sheets you're not viewing.
  sidebarPages: ProjectPage[];
  takeoffTotals: TakeoffTotal[];

  isRightSidebarOpen: boolean;
  setIsRightSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  showCurrentPageOnly: boolean;
  setShowCurrentPageOnly: React.Dispatch<React.SetStateAction<boolean>>;
  measurementFilter: string;
  setMeasurementFilter: React.Dispatch<React.SetStateAction<string>>;
  expandedTakeoffs: Record<string, boolean>;
  setExpandedTakeoffs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;

  selectedTakeoffId: string | undefined;
  setSelectedTakeoffId: React.Dispatch<React.SetStateAction<string | undefined>>;
  selectedMeasurementId: string | null;
  multiSelectedIds: Set<string>;
  setMultiSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setIsMultiSelectMode: React.Dispatch<React.SetStateAction<boolean>>;

  setSelectedColor: React.Dispatch<React.SetStateAction<string>>;
  setCurrentTool: React.Dispatch<React.SetStateAction<Tool>>;
  setShowTakeoffModal: React.Dispatch<React.SetStateAction<boolean>>;
  setTakeoffToDelete: React.Dispatch<React.SetStateAction<MeasurementTakeoff | null>>;
  setHeightsModalMeasurementId: React.Dispatch<React.SetStateAction<string | null>>;
  /** Opens the multiplier editor for a length/area measurement. */
  onEditMultiplier: (measurementId: string) => void;

  selectMeasurement: (m: Measurement) => void;
  updateMeasurement: (id: string, updates: Partial<Measurement>, targetPageId?: string) => void;
  deleteMeasurement: (id: string, targetPageId?: string) => void;
  handleEditTakeoff: (takeoff: MeasurementTakeoff) => void;
  handleMergeSelected: () => void;
  openNewMeasurementModal: (takeoffId: string) => void;

  toast: (message: string, options?: { type?: 'info' | 'success' | 'warning' | 'error' }) => void;
}

export function MeasurementSidebar({
  project,
  page,
  sidebarPages,
  takeoffTotals,
  isRightSidebarOpen,
  setIsRightSidebarOpen,
  showCurrentPageOnly,
  setShowCurrentPageOnly,
  measurementFilter,
  setMeasurementFilter,
  expandedTakeoffs,
  setExpandedTakeoffs,
  selectedTakeoffId,
  setSelectedTakeoffId,
  selectedMeasurementId,
  multiSelectedIds,
  setMultiSelectedIds,
  setIsMultiSelectMode,
  setSelectedColor,
  setCurrentTool,
  setShowTakeoffModal,
  setTakeoffToDelete,
  setHeightsModalMeasurementId,
  onEditMultiplier,
  selectMeasurement,
  updateMeasurement,
  deleteMeasurement,
  handleEditTakeoff,
  handleMergeSelected,
  openNewMeasurementModal,
  toast,
}: MeasurementSidebarProps) {
  return (
    <>
      {/* Right Sidebar Wrapper */}
      {isRightSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-[1px] z-40 md:hidden"
          onClick={() => setIsRightSidebarOpen(false)}
        />
      )}
      <div className={`fixed inset-0 z-50 md:relative md:inset-auto md:z-20 flex h-full transition-all duration-300 ${isRightSidebarOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}`}>
        <button
          onClick={() => setIsRightSidebarOpen(!isRightSidebarOpen)}
          className={`absolute left-0 -translate-x-full top-1/2 -translate-y-1/2 z-30 bg-raised border border-edge border-r-0 rounded-l-md p-1 shadow-sm hover:bg-hover text-ink-soft ${isRightSidebarOpen ? 'hidden md:block' : 'block'}`}
        >
          {isRightSidebarOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
        <div data-testid="measurement-sidebar" className={`bg-raised border-l border-edge flex flex-col h-full shadow-2xl md:shadow-none transition-all duration-300 overflow-hidden ${isRightSidebarOpen ? 'w-full md:w-96' : 'w-0'}`}>
          <div className="w-full md:w-96 flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 pb-20 scroll-fade">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsRightSidebarOpen(false)}
                  className="md:hidden p-2 text-ink-faint hover:text-ink-soft hover:bg-hover rounded-lg"
                >
                  <ChevronRight size={20} />
                </button>
                <h2 className="text-xs font-semibold text-ink-faint uppercase tracking-wider">Takeoffs & Measurements</h2>
              </div>
              <div className="flex items-center gap-3">
                {(() => {
                  const anyExpanded = project.takeoffs.some(t => expandedTakeoffs[t.id] !== false);
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        const next: Record<string, boolean> = {};
                        project.takeoffs.forEach(t => { next[t.id] = !anyExpanded; });
                        setExpandedTakeoffs(next);
                      }}
                      title={anyExpanded ? 'Collapse all takeoffs' : 'Expand all takeoffs'}
                      className="p-1.5 text-ink-soft hover:text-ink hover:bg-hover rounded transition-colors"
                    >
                      {anyExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                    </button>
                  );
                })()}
                <label className="flex items-center gap-1.5 text-xs text-ink-soft cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="toggle-current-page-only"
                    checked={showCurrentPageOnly}
                    onChange={(e) => setShowCurrentPageOnly(e.target.checked)}
                    className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
                  />
                  <span className="hidden sm:inline">Current page only</span>
                  <span className="sm:hidden">Page only</span>
                </label>
                {page.scaleConfig && (
                  <button
                    onClick={() => setShowTakeoffModal(true)}
                    className="text-xs flex items-center gap-1 text-accent-600 dark:text-accent-400 hover:text-accent-700 font-medium bg-accent-50 dark:bg-accent-900/30 hover:bg-accent-100 dark:hover:bg-accent-900/50 px-2 py-1 rounded transition-colors"
                  >
                    <Plus size={12} />
                    New
                  </button>
                )}
              </div>
            </div>

            {/* Measurement filter */}
            <div className="mb-3 flex-shrink-0 relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
              <input
                type="text"
                data-testid="measurement-filter"
                value={measurementFilter}
                onChange={(e) => setMeasurementFilter(e.target.value)}
                placeholder="Filter takeoffs & measurements..."
                className="w-full text-xs border border-edge rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-sunken text-ink placeholder-ink-faint"
              />
            </div>

            {!page.scaleConfig && (
              <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-lg text-sm text-amber-700 dark:text-amber-400">
                Please set the scale on the left sidebar.
              </div>
            )}

            {/* Multi-select merge banner */}
            {multiSelectedIds.size > 0 && (
              <div className="mb-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-xl p-3 flex-shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                      {multiSelectedIds.size} selected
                    </p>
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                      {(() => {
                        const types = [...multiSelectedIds].map(id => page.measurements.find(m => m.id === id)?.type).filter(Boolean);
                        const allSame = types.every(t => t === types[0]);
                        if (!allSame) return 'Mixed types — cannot merge';
                        // Merge folds them into one measurement, which has one multiplier.
                        const picked = page.measurements.filter(m => multiSelectedIds.has(m.id));
                        const target = page.measurements.find(m => m.id === selectedMeasurementId && m.type === types[0]);
                        if (!multipliersMatch(target ? [target, ...picked] : picked)) return 'Different multipliers — cannot merge';
                        return selectedMeasurementId ? 'Will merge into selected measurement' : 'Will create a new measurement';
                      })()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => { setMultiSelectedIds(new Set()); setIsMultiSelectMode(false); }}
                      className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 px-2 py-1 rounded"
                    >
                      Clear
                    </button>
                    {multiSelectedIds.size >= 2 && (
                      <button
                        data-testid="btn-merge"
                        onClick={handleMergeSelected}
                        className="text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg flex items-center gap-1.5 active:scale-95 transition-all"
                      >
                        <GitMerge size={14} />
                        Merge
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Takeoff Totals */}
            {(() => {
              const filteredTakeoffs = takeoffTotals.filter(takeoff => {
                if (!measurementFilter) return true;
                const fl = measurementFilter.toLowerCase();
                if (takeoff.name.toLowerCase().includes(fl)) return true;
                return sidebarPages.some(p =>
                  p.measurements.some(m => m.takeoffId === takeoff.id && m.name.toLowerCase().includes(fl))
                );
              });

              const packageOrder: string[] = [];
              const packageMap: Record<string, typeof filteredTakeoffs> = {};
              const ungrouped: typeof filteredTakeoffs = [];
              for (const t of filteredTakeoffs) {
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

              const renderTakeoffCard = (takeoff: typeof filteredTakeoffs[0]) => {
              const isActive = selectedTakeoffId === takeoff.id;
              const isExpanded = expandedTakeoffs[takeoff.id] !== false; // Default to expanded

              return (
                <div
                  key={takeoff.id}
                  className={`mb-4 bg-raised border rounded-xl overflow-hidden shadow-sm transition-colors flex-shrink-0 border-l-4 ${isActive ? 'border-accent-500 ring-1 ring-accent-500' : 'border-edge'}`}
                  style={{ borderLeftColor: takeoff.color }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.add('ring-2', 'ring-accent-400', 'ring-inset');
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                    const measurementId = e.dataTransfer.getData('text/plain');
                    const measurement = sidebarPages.flatMap(p => p.measurements).find(m => m.id === measurementId);

                    if (measurement) {
                      if (takeoff.type === 'count' && measurement.type !== 'count') {
                        toast('Cannot drop non-count measurements into a count takeoff.', { type: 'warning' });
                        return;
                      }
                      if (takeoff.type !== 'count' && measurement.type === 'count') {
                        toast('Cannot drop count measurements into a non-count takeoff.', { type: 'warning' });
                        return;
                      }
                      if (takeoff.type === 'length' && measurement.type === 'area') {
                        toast('Cannot drop area measurements into a linear takeoff.', { type: 'warning' });
                        return;
                      }

                      updateMeasurement(measurementId, { takeoffId: takeoff.id, color: takeoff.color });
                    }
                  }}
                >
                  <div
                    className={`px-3 py-2 border-b flex justify-between items-center group/header cursor-pointer transition-colors ${isActive ? 'bg-accent-50 dark:bg-accent-900/20 border-accent-100 dark:border-accent-800/30' : 'bg-sunken border-edge hover:bg-hover/50'}`}
                    onClick={() => {
                      if (isActive) {
                        setSelectedTakeoffId(null);
                      } else {
                        setSelectedTakeoffId(takeoff.id);
                        setSelectedColor(takeoff.color);
                        if (takeoff.type === 'length') setCurrentTool('length');
                        else if (takeoff.type === 'area') setCurrentTool('area');
                        else if (takeoff.type === 'count') setCurrentTool('count');
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <button
                        data-testid="takeoff-expand"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedTakeoffs(prev => ({ ...prev, [takeoff.id]: !isExpanded }));
                        }}
                        className="text-ink-faint hover:text-ink-soft p-2 rounded transition-colors active:scale-95 shrink-0"
                      >
                        {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </button>
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: takeoff.color }} />
                      <span className={`text-sm font-semibold break-words whitespace-normal flex-1 min-w-0 ${isActive ? 'text-accent-800 dark:text-accent-300' : 'text-ink'}`}>{takeoff.name}</span>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setTakeoffToDelete(takeoff);
                          }}
                          className="text-ink-faint hover:text-red-500 p-2 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors can-hover:md:opacity-0 can-hover:md:group-hover/header:opacity-100 active:scale-95"
                          title="Delete Takeoff"
                        >
                          <Trash2 size={16} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditTakeoff(takeoff);
                          }}
                          className="text-ink-faint hover:text-accent-500 p-2 rounded-md hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors can-hover:md:opacity-0 can-hover:md:group-hover/header:opacity-100 active:scale-95"
                          title="Edit Takeoff"
                        >
                          <Edit2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0 ml-2">
                      <span data-testid="takeoff-total" className={`text-xs font-bold px-2 py-1 rounded-lg border transition-all ${isActive ? 'bg-accent-600 text-white border-accent-700 shadow-sm' : 'bg-sunken text-ink border-edge'}`}>
                        {formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', page.scaleConfig?.unit || 'ft', takeoff, false)}
                      </span>
                      {(takeoff.costPerUnit || takeoff.isAdvancedCost) && (
                        <div className="flex flex-col items-end mt-1">
                          {formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', page.scaleConfig?.unit || 'ft', takeoff)
                            .split('\n')
                            .slice(1)
                            .map((line, i) => (
                              <span key={i} className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-tight text-right">
                                {line}
                              </span>
                            ))
                          }
                        </div>
                      )}
                    </div>
                  </div>
                  {isExpanded && takeoff.type !== 'count' && (
                    <div className="divide-y divide-edge min-h-[10px]">
                      <button
                        onClick={() => openNewMeasurementModal(takeoff.id)}
                        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-accent-600 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/20 border-b border-dashed border-edge transition-colors"
                      >
                        <Plus size={14} />
                        New Measurement
                      </button>
                      {sidebarPages.flatMap(p =>
                        p.measurements
                          .filter(m => m.takeoffId === takeoff.id && (!measurementFilter || m.name.toLowerCase().includes(measurementFilter.toLowerCase())))
                          .map(m => (
                            <MeasurementItem
                              key={m.id}
                              testId="measurement-row"
                              measurement={m}
                              scaleConfig={p.scaleConfig}
                              takeoffType={takeoff.type}
                              onDelete={() => deleteMeasurement(m.id, p.id)}
                              selected={selectedMeasurementId === m.id}
                              onSelect={() => selectMeasurement(m)}
                              onRename={(newName) => updateMeasurement(m.id, { name: newName }, p.id)}
                              onEditHeights={() => setHeightsModalMeasurementId(m.id)}
                              onEditMultiplier={() => onEditMultiplier(m.id)}
                              takeoff={takeoff}
                              pageName={showCurrentPageOnly ? undefined : p.name}
                              pageId={p.id}
                              projectId={project.id}
                              planSetName={m.planSetId ? project.planSets?.find(ps => ps.id === m.planSetId)?.name : undefined}
                              pageIds={project.pages.filter(pg => pg.measurements.some(m => m.takeoffId === takeoff.id)).map(pg => pg.id)}
                            />
                          ))
                      )}
                    </div>
                  )}
                  {isExpanded && takeoff.type === 'count' && (
                    <div className="divide-y divide-edge min-h-[10px]">
                      {sidebarPages.map(p => {
                        const count = p.measurements.filter(m => m.takeoffId === takeoff.id).length;
                        if (count === 0) return null;
                        return (
                          <div key={p.id} className="p-3 flex items-center justify-between hover:bg-hover/50 transition-colors">
                            <Link
                              to={`/project/${project.id}/page/${p.id}`}
                              state={{ pageIds: project.pages.filter(pg => pg.measurements.some(m => m.takeoffId === takeoff.id)).map(pg => pg.id) }}
                              className="text-sm font-medium text-accent-600 dark:text-accent-400 hover:text-accent-800 dark:hover:text-accent-300 hover:underline truncate"
                            >
                              {p.name}
                            </Link>
                            <span className="text-sm font-semibold text-ink bg-sunken px-2 py-0.5 rounded-full">
                              {count}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
              };

              return (
                <>
                  {packageOrder.map(pkg => (
                    <React.Fragment key={`pkg-${pkg}`}>
                      <div className="px-2 pt-3 pb-1">
                        <span className="text-[10px] font-bold text-ink-soft uppercase tracking-widest">{pkg}</span>
                      </div>
                      {packageMap[pkg].map(renderTakeoffCard)}
                    </React.Fragment>
                  ))}
                  {ungrouped.map(renderTakeoffCard)}
                </>
              );
            })()}

            {/* Ungrouped Measurements */}
            {sidebarPages.flatMap(p => p.measurements)
              .filter(m => !m.takeoffId && (!measurementFilter || m.name.toLowerCase().includes(measurementFilter.toLowerCase()))).length > 0 && (
              <div
                className={`mb-4 bg-raised border rounded-xl overflow-hidden shadow-sm transition-colors flex-shrink-0 ${!selectedTakeoffId ? 'border-accent-500 ring-1 ring-accent-500' : 'border-edge'}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('ring-2', 'ring-accent-400', 'ring-inset');
                }}
                onDragLeave={(e) => {
                  e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                  const measurementId = e.dataTransfer.getData('text/plain');
                  if (measurementId) {
                    updateMeasurement(measurementId, { takeoffId: undefined });
                  }
                }}
              >
                <div
                  className={`px-3 py-2 border-b cursor-pointer transition-colors ${!selectedTakeoffId ? 'bg-accent-50 dark:bg-accent-900/20 border-accent-100 dark:border-accent-800/30' : 'bg-sunken border-edge hover:bg-hover/50'}`}
                  onClick={() => setSelectedTakeoffId(null)}
                >
                  <span className={`text-sm font-semibold ${!selectedTakeoffId ? 'text-accent-800 dark:text-accent-300' : 'text-ink'}`}>Ungrouped</span>
                </div>
                <div className="divide-y divide-edge min-h-[10px]">
                  {sidebarPages.flatMap(p =>
                    p.measurements
                      .filter(m => !m.takeoffId)
                      .map(m => (
                        <MeasurementItem
                          key={m.id}
                          testId="measurement-row"
                          measurement={m}
                          scaleConfig={p.scaleConfig}
                          takeoffType={undefined}
                          onDelete={() => deleteMeasurement(m.id, p.id)}
                          selected={selectedMeasurementId === m.id}
                          onSelect={() => selectMeasurement(m)}
                          onRename={(newName) => updateMeasurement(m.id, { name: newName }, p.id)}
                          onEditHeights={() => setHeightsModalMeasurementId(m.id)}
                          onEditMultiplier={() => onEditMultiplier(m.id)}
                          pageName={showCurrentPageOnly ? undefined : p.name}
                          pageId={p.id}
                          projectId={project.id}
                          planSetName={m.planSetId ? project.planSets?.find(ps => ps.id === m.planSetId)?.name : undefined}
                          pageIds={project.pages.filter(pg => pg.measurements.some(m => !m.takeoffId)).map(pg => pg.id)}
                        />
                      ))
                  )}
                </div>
              </div>
            )}

            {sidebarPages.flatMap(p => p.measurements).length === 0 && (
              <p className="text-sm text-ink-soft italic text-center py-4">No measurements yet.</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
