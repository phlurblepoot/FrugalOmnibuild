import { CustomCost } from '../types';
import { TakeoffTotals } from '../pages/project/proposal/proposalGenerator';
import { calculateTakeoffTotalCost } from './math';

// A single per-custom-cost allocation detail row, as produced by
// allocateSubsetDetails(). Extends the underlying CustomCost with the allocated
// cost value, the computed quantity (when applicable), and the quantity unit.
export type SubsetCostDetail = CustomCost & {
  costValue: number;
  quantity: number | undefined;
  quantityUnit: string | undefined;
};

// Compute the prorated cost of a subset (a page or measurement slice) of a
// takeoff. Advanced takeoffs prorate `flat` costs by the subset's share of the
// total, and scale yield/unit/amount_per_units costs by the subset value.
// Non-advanced takeoffs fall back to the shared calculateTakeoffTotalCost.
//
// NOTE: extracted verbatim from ProjectView's three inline `allocateSubsetCost`
// definitions (Excel export, desktop takeoffs table, mobile cards) which were
// byte-for-byte identical. Behavior must remain unchanged.
export const allocateSubsetCost = (takeoff: TakeoffTotals, subsetValue: number): number => {
  if (takeoff.isAdvancedCost && takeoff.customCosts) {
    return takeoff.customCosts.reduce((sum, item) => {
      switch (item.type) {
        case 'flat':
          return sum + (item.cost || 0) * (takeoff.totalRealValue > 0 ? subsetValue / takeoff.totalRealValue : 0);
        case 'yield':
          return item.yield && item.yield > 0 ? sum + (subsetValue / item.yield) * (item.cost || 0) : sum;
        case 'unit':
          return sum + subsetValue * (item.costPerUnit || 0);
        case 'amount_per_units':
          return item.perUnits && item.perUnits > 0 ? sum + (subsetValue / item.perUnits) * (item.amount || 0) : sum;
        default:
          return sum;
      }
    }, 0);
  }
  return calculateTakeoffTotalCost(takeoff, subsetValue);
};

// Compute the per-custom-cost detail rows for a subset of an advanced takeoff.
// Returns [] for non-advanced takeoffs (or takeoffs without customCosts).
//
// NOTE: extracted verbatim from ProjectView's three inline `allocateSubsetDetails`
// definitions which were byte-for-byte identical. Behavior must remain unchanged.
export const allocateSubsetDetails = (takeoff: TakeoffTotals, subsetValue: number): SubsetCostDetail[] => {
  if (!takeoff.isAdvancedCost || !takeoff.customCosts) return [];
  return takeoff.customCosts.map(item => {
    let cost = 0;
    let quantity: number | undefined;
    switch (item.type) {
      case 'flat':
        cost = (item.cost || 0) * (takeoff.totalRealValue > 0 ? subsetValue / takeoff.totalRealValue : 0);
        break;
      case 'yield':
        if (item.yield && item.yield > 0) {
          quantity = subsetValue / item.yield;
          cost = quantity * (item.cost || 0);
        }
        break;
      case 'unit':
        cost = subsetValue * (item.costPerUnit || 0);
        break;
      case 'amount_per_units':
        if (item.perUnits && item.perUnits > 0) {
          quantity = subsetValue / item.perUnits;
          cost = quantity * (item.amount || 0);
        }
        break;
    }
    return { ...item, costValue: cost, quantity, quantityUnit: item.unit };
  });
};
