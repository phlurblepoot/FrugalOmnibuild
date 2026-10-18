// src/pages/project/takeoffExcel.ts
// The Takeoffs tab's Excel export as rows (array-of-arrays for
// XLSX.utils.aoa_to_sheet) plus column widths. Moved verbatim out of
// ProjectView.handleExportExcel, which still writes and saves the workbook, so
// the rows can be tested.
//
// Layout: one row per takeoff (grouped by price package, like the tab), its
// advanced-pricing sub-rows, then each page and each measurement under it.
// Every Qty is what the row counts for. When a selected measurement has a
// multiplier, two columns are added — Measured Qty and Multiplier — filled on
// that measurement's row, so the sheet shows its math (Measured Qty ×
// Multiplier = Qty). Without one the sheet is exactly as before.
import { formatRealValue, roundUpTo100 } from '../../utils/math';
import { allocateSubsetCost, allocateSubsetDetails, SubsetCostDetail } from '../../utils/costAllocation';
import type { TakeoffTotals } from './proposal/proposalGenerator';

export type TakeoffExcelCell = string | number;

export function buildTakeoffExcelRows(selectedTakeoffs: TakeoffTotals[]): {
  rows: TakeoffExcelCell[][];
  cols: { wch: number }[];
} {
  const hasMultiplied = selectedTakeoffs.some(t =>
    t.pageBreakdown.some(pb => pb.measurements.some(meas => meas.multiplier > 1)));

  // Build rows as array-of-arrays for full control over layout
  const rows: TakeoffExcelCell[][] = [];
  rows.push(['Takeoff Name', 'Type', 'Qty', 'Unit Cost', 'Total Cost', ...(hasMultiplied ? ['Measured Qty', 'Multiplier'] : [])]);

  // Group by price package (mirrors the UI)
  const packageOrder: string[] = [];
  const packageMap: Record<string, typeof selectedTakeoffs> = {};
  const ungrouped: typeof selectedTakeoffs = [];
  for (const t of selectedTakeoffs) {
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

  const addTakeoffRows = (takeoff: typeof selectedTakeoffs[0]) => {
    const formatQty = (value: number, unit: string | undefined) => value > 0
      ? formatRealValue(value, takeoff.type as 'length' | 'area' | 'count', unit?.replace('sq ', '') || takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false)
      : '-';

    const buildUnitCost = (subsetValue: number, subsetCost: number) => {
      if (takeoff.isAdvancedCost) {
        return subsetCost > 0 ? `$${(subsetCost / (subsetValue || 1)).toFixed(2)} avg/unit` : '-';
      }
      return takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-';
    };

    const addAdvancedDetailRows = (
      details: SubsetCostDetail[],
      subsetQtyFormatted: string,
      indent: string,
    ) => {
      details.forEach(d => {
        if (d.quantity !== undefined && d.quantity > 0) {
          const itemUnitCost = d.type === 'yield'
            ? `$${(d.cost || 0).toFixed(2)}/unit`
            : d.type === 'amount_per_units'
              ? `$${(d.amount || 0).toFixed(2)}/unit`
              : '';
          rows.push([
            `${indent}└ ${d.name}`,
            '',
            `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'}`,
            itemUnitCost,
            `$${d.costValue.toFixed(2)}`,
          ]);
        } else if (d.type === 'flat') {
          rows.push([`${indent}└ ${d.name}`, '', 'flat (prorated)', '', `$${d.costValue.toFixed(2)}`]);
        } else if (d.type === 'unit') {
          rows.push([
            `${indent}└ ${d.name}`,
            '',
            subsetQtyFormatted,
            `$${(d.costPerUnit || 0).toFixed(2)}/unit`,
            `$${d.costValue.toFixed(2)}`,
          ]);
        }
      });
    };

    const totalCost = allocateSubsetCost(takeoff, takeoff.totalRealValue);
    const totalDetails = allocateSubsetDetails(takeoff, takeoff.totalRealValue);
    const qtyFormatted = formatQty(takeoff.totalRealValue, takeoff.unit);

    // Main takeoff row
    rows.push([takeoff.name, takeoff.type, qtyFormatted, buildUnitCost(takeoff.totalRealValue, totalCost), totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-']);

    // Takeoff-level advanced pricing detail sub-rows
    if (takeoff.isAdvancedCost && totalDetails.length > 0) {
      addAdvancedDetailRows(totalDetails, qtyFormatted, '  ');
    }

    // Page rows (and nested measurement rows)
    takeoff.pageBreakdown.forEach(pb => {
      const pageCost = allocateSubsetCost(takeoff, pb.realValue);
      const pageDetails = allocateSubsetDetails(takeoff, pb.realValue);
      const pageQtyFormatted = formatQty(pb.realValue, pb.unit);

      rows.push([
        `  └ ${pb.pageName}`,
        '',
        pageQtyFormatted,
        buildUnitCost(pb.realValue, pageCost),
        pageCost > 0 ? `$${roundUpTo100(pageCost).toLocaleString()}` : '-',
      ]);

      if (takeoff.isAdvancedCost && pageDetails.length > 0) {
        addAdvancedDetailRows(pageDetails, pageQtyFormatted, '      ');
      }

      pb.measurements.forEach(meas => {
        const measCost = allocateSubsetCost(takeoff, meas.realValue);
        const measDetails = allocateSubsetDetails(takeoff, meas.realValue);
        const measQtyFormatted = formatQty(meas.realValue, meas.unit);

        rows.push([
          `      • ${meas.name || 'Measurement'}`,
          '',
          measQtyFormatted,
          buildUnitCost(meas.realValue, measCost),
          measCost > 0 ? `$${roundUpTo100(measCost).toLocaleString()}` : '-',
          // Its math: the measured quantity and how many times it counts.
          ...(meas.multiplier > 1 ? [formatQty(meas.baseValue, meas.unit), meas.multiplier] : []),
        ]);

        if (takeoff.isAdvancedCost && measDetails.length > 0) {
          addAdvancedDetailRows(measDetails, measQtyFormatted, '          ');
        }
      });
    });
  };

  for (const pkg of packageOrder) {
    rows.push([`── ${pkg} ──`, '', '', '', '']);
    packageMap[pkg].forEach(addTakeoffRows);
  }
  ungrouped.forEach(addTakeoffRows);

  const cols = [
    { wch: 48 },
    { wch: 10 },
    { wch: 22 },
    { wch: 22 },
    { wch: 18 },
    ...(hasMultiplied ? [{ wch: 22 }, { wch: 10 }] : []),
  ];

  return { rows, cols };
}
