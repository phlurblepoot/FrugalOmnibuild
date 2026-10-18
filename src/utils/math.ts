import { Point, ScaleConfig, MeasurementTakeoff, MeasurementSegment } from '../types';

export const parseFeetAndInches = (input: string, defaultUnit: string = 'ft'): number | null => {
  const cleanInput = input.trim();
  if (!cleanInput) return null;

  // Try to parse as a simple decimal first
  const asFloat = parseFloat(cleanInput);
  if (!isNaN(asFloat) && asFloat.toString() === cleanInput) {
    return defaultUnit === 'in' ? asFloat / 12 : asFloat;
  }

  // Regex to extract feet, inches, and fractions
  const regex = /^(?:([\d.]+)\s*(?:'|ft|feet))?\s*(?:-)?\s*(?:([\d.]+)\s*(?:"|in|inches)?)?\s*(?:(\d+)\/(\d+)\s*(?:"|in|inches)?)?$/i;
  const match = cleanInput.match(regex);

  if (!match || (!match[1] && !match[2] && !match[3])) {
    // Fallback: try to parse just a fraction like "1/2"
    const fractionMatch = cleanInput.match(/^\s*(\d+)\/(\d+)\s*$/);
    if (fractionMatch) {
      const num = parseInt(fractionMatch[1], 10);
      const den = parseInt(fractionMatch[2], 10);
      if (den !== 0) {
        const val = num / den;
        return defaultUnit === 'in' ? val / 12 : val;
      }
    }
    
    // If it still has numbers, maybe it's just a raw number with some text
    const rawNum = parseFloat(cleanInput.replace(/[^\d.-]/g, ''));
    if (!isNaN(rawNum)) {
      return defaultUnit === 'in' ? rawNum / 12 : rawNum;
    }
    
    return null;
  }

  // If there are explicit units in the string, we use them
  const hasExplicitFeet = cleanInput.match(/'|ft|feet/i);
  const hasExplicitInches = cleanInput.match(/"|in|inches/i);

  let feet = parseFloat(match[1] || '0');
  let inches = parseFloat(match[2] || '0');
  const fracNum = parseInt(match[3] || '0', 10);
  const fracDen = parseInt(match[4] || '1', 10);

  let totalInches = inches;
  if (fracDen !== 0) {
    totalInches += fracNum / fracDen;
  }

  // If no explicit units were provided, treat the first number based on defaultUnit
  if (!hasExplicitFeet && !hasExplicitInches) {
    if (defaultUnit === 'ft') {
      // "3 1/2" -> 3.5 feet
      const whole = parseFloat(match[2] || '0');
      const fraction = fracDen !== 0 ? fracNum / fracDen : 0;
      return whole + fraction;
    } else {
      // "3 1/2" -> 3.5 inches
      const whole = parseFloat(match[2] || '0');
      const fraction = fracDen !== 0 ? fracNum / fracDen : 0;
      return (whole + fraction) / 12;
    }
  }

  return feet + (totalInches / 12);
};

export const generateArcPoints = (A: Point, B: Point, C: Point, segments: number = 32): Point[] => {
  const D = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
  if (Math.abs(D) < 1e-5) {
    // Collinear, just return straight line
    return [A, B, C];
  }

  const Ux = ((A.x * A.x + A.y * A.y) * (B.y - C.y) + (B.x * B.x + B.y * B.y) * (C.y - A.y) + (C.x * C.x + C.y * C.y) * (A.y - B.y)) / D;
  const Uy = ((A.x * A.x + A.y * A.y) * (C.x - B.x) + (B.x * B.x + B.y * B.y) * (A.x - C.x) + (C.x * C.x + C.y * C.y) * (B.x - A.x)) / D;

  const center = { x: Ux, y: Uy };
  const radius = Math.sqrt(Math.pow(A.x - Ux, 2) + Math.pow(A.y - Uy, 2));

  let startAngle = Math.atan2(A.y - Uy, A.x - Ux);
  let midAngle = Math.atan2(B.y - Uy, B.x - Ux);
  let endAngle = Math.atan2(C.y - Uy, C.x - Ux);

  // Ensure angles are positive
  if (startAngle < 0) startAngle += 2 * Math.PI;
  if (midAngle < 0) midAngle += 2 * Math.PI;
  if (endAngle < 0) endAngle += 2 * Math.PI;

  let clockwise = false;
  
  let ccwDist = endAngle - startAngle;
  if (ccwDist < 0) ccwDist += 2 * Math.PI;
  
  let midCcwDist = midAngle - startAngle;
  if (midCcwDist < 0) midCcwDist += 2 * Math.PI;
  
  if (midCcwDist > ccwDist) {
    clockwise = true;
  }

  let totalAngle = ccwDist;
  if (clockwise) {
    totalAngle = 2 * Math.PI - ccwDist;
  }

  const points: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let angle = startAngle;
    if (clockwise) {
      angle -= t * totalAngle;
    } else {
      angle += t * totalAngle;
    }
    points.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle)
    });
  }

  return points;
};

export const expandArcPoints = (points: Point[], arcMidIndices: number[] = []): Point[] => {
  if (!arcMidIndices || arcMidIndices.length === 0) return points;
  const arcSet = new Set(arcMidIndices);
  const result: Point[] = [];
  let i = 0;
  while (i < points.length) {
    if (arcSet.has(i) && i > 0 && i < points.length - 1) {
      const arcPts = generateArcPoints(points[i - 1], points[i], points[i + 1]);
      result.push(...arcPts.slice(1)); // start already in result
      i += 2; // skip mid + end (end is now last item in result)
    } else {
      result.push(points[i]);
      i++;
    }
  }
  return result;
};

export const calculateDistance = (p1: Point, p2: Point): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

export const calculatePolylineLength = (points: Point[]): number => {
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    length += calculateDistance(points[i], points[i + 1]);
  }
  return length;
};

// Shoelace formula for polygon area
export const calculatePolygonArea = (points: Point[]): number => {
  if (points.length < 3) return 0;
  
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
};

export const isPointInPolygon = (point: Point, polygon: Point[]): boolean => {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

// Shoelace WITH sign. In the y-down screen coords these points live in, a
// positive result means the ring winds CLOCKWISE on screen. calculatePolygonArea
// (abs) stays for single-polygon magnitudes; this exists for winding-aware ring
// normalization.
export const signedPolygonArea = (points: Point[]): number => {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
};

type MeasurementGeometry = {
  points: Point[];
  arcMidIndices?: number[];
  segments?: MeasurementSegment[];
};

// Net pixel area of an area measurement: additive segments minus subtract
// segments (arcs expanded), clamped at 0 so an oversized hole can't drive a
// takeoff negative.
export const measurementAreaPx = (m: MeasurementGeometry): number => {
  const segs = [
    { points: m.points, arcMidIndices: m.arcMidIndices, subtract: false },
    ...(m.segments ?? []).map(s => ({ points: s.points, arcMidIndices: s.arcMidIndices, subtract: !!s.subtract })),
  ];
  const net = segs.reduce((sum, s) => {
    const a = calculatePolygonArea(expandArcPoints(s.points, s.arcMidIndices));
    return sum + (s.subtract ? -a : a);
  }, 0);
  return Math.max(0, net);
};

// Arc-expanded rings with winding normalized for nonzero-rule fills: additive
// rings get positive signed area (on-screen clockwise in these y-down coords),
// subtract rings negative. Only the OPPOSITION matters to the nonzero rule —
// which side is which is arbitrary — and it is what lets one compound path
// punch real holes in both the Konva canvas and the pdf-lib printout.
// Degenerate (<3 point) rings are dropped.
export const measurementRings = (m: MeasurementGeometry): { points: Point[]; subtract: boolean }[] => {
  const segs = [
    { points: m.points, arcMidIndices: m.arcMidIndices, subtract: false },
    ...(m.segments ?? []).map(s => ({ points: s.points, arcMidIndices: s.arcMidIndices, subtract: !!s.subtract })),
  ];
  const rings: { points: Point[]; subtract: boolean }[] = [];
  for (const s of segs) {
    const pts = expandArcPoints(s.points, s.arcMidIndices);
    if (pts.length < 3) continue;
    const signed = signedPolygonArea(pts);
    const wantPositive = !s.subtract;
    const isPositive = signed > 0;
    rings.push({ points: wantPositive === isPositive ? pts : [...pts].reverse(), subtract: !!s.subtract });
  }
  return rings;
};

export const calculateSurfaceAreaPx = (
  points: Point[],
  heightsReal: number[],
  isTwoSided: boolean,
  scale: ScaleConfig | null
): number => {
  if (!scale || scale.pixelDistance === 0) return 0;
  const ratio = scale.realWorldDistance / scale.pixelDistance;
  let areaPx = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const lenPx = calculateDistance(points[i], points[i + 1]);
    const h1Px = (heightsReal[i] || 0) / ratio;
    const h2Px = (heightsReal[i + 1] || 0) / ratio;
    areaPx += lenPx * (h1Px + h2Px) / 2;
  }
  return areaPx * (isTwoSided ? 2 : 1);
};

export const formatFeetAndInches = (decimalFeet: number): string => {
  const totalSixteenths = Math.round(decimalFeet * 12 * 16);
  const f = Math.floor(totalSixteenths / (12 * 16));
  const remainingSixteenths = totalSixteenths % (12 * 16);
  const i = Math.floor(remainingSixteenths / 16);
  const frac = remainingSixteenths % 16;

  let fractionStr = '';
  if (frac > 0) {
    let num = frac;
    let den = 16;
    while (num % 2 === 0 && den % 2 === 0) {
      num /= 2;
      den /= 2;
    }
    fractionStr = ` ${num}/${den}`;
  }

  if (f === 0 && i === 0 && frac === 0) return `0"`;
  
  if (f === 0) {
    const inchPart = i === 0 && frac > 0 ? fractionStr.trim() : `${i}${fractionStr}`;
    return `${inchPart}"`;
  }
  
  const inchPart = i === 0 && frac > 0 ? fractionStr.trim() : `${i}${fractionStr}`;
  return `${f}' - ${inchPart}"`;
};

export const convertUnit = (
  value: number,
  fromUnit: string,
  toUnit: string,
  type: 'length' | 'area' | 'count'
): number => {
  if (type === 'count' || !fromUnit || !toUnit) return value;
  
  const normalize = (u: string) => u.toLowerCase().replace(/\s+/g, '').replace(/^(sq|square)/, '');
  const nFrom = normalize(fromUnit);
  const nTo = normalize(toUnit);

  if (nFrom === nTo) return value;

  if (type === 'length') {
    const factors: Record<string, number> = {
      'in': 1,
      'inch': 1,
      'inches': 1,
      'ft': 12,
      'foot': 12,
      'feet': 12,
      'yd': 36,
      'yard': 36,
      'yards': 36,
      'cm': 1 / 2.54,
      'm': 100 / 2.54,
    };

    if (factors[nFrom] && factors[nTo]) {
      return (value * factors[nFrom]) / factors[nTo];
    }
  } else if (type === 'area') {
    const factors: Record<string, number> = {
      'in': 1,
      'inch': 1,
      'inches': 1,
      'ft': 144,
      'foot': 144,
      'feet': 144,
      'yd': 1296,
      'yard': 1296,
      'yards': 1296,
      'cm': Math.pow(1 / 2.54, 2),
      'm': Math.pow(100 / 2.54, 2),
    };

    if (factors[nFrom] && factors[nTo]) {
      return (value * factors[nFrom]) / factors[nTo];
    }
  }

  return value;
};

export const UNIT_LABELS: Record<string, string> = {
  'in': 'in',
  'ft': 'ft',
  'yd': 'yd',
  'cm': 'cm',
  'm': 'm',
  'sqin': 'sq in',
  'sqft': 'sq ft',
  'sqyd': 'sq yd',
  'sqcm': 'sq cm',
  'sqm': 'sq m',
  'each': 'each',
  'sq in': 'sq in',
  'sq ft': 'sq ft',
  'sq yd': 'sq yd',
  'sq cm': 'sq cm',
  'sq m': 'sq m'
};

export const calculateTakeoffCostDetails = (takeoff: MeasurementTakeoff, totalValue: number) => {
  if (takeoff.isAdvancedCost && takeoff.customCosts) {
    return takeoff.customCosts.map(item => {
      let cost = 0;
      let quantity: number | undefined;

      switch (item.type) {
        case 'flat':
          cost = item.cost || 0;
          break;
        case 'yield':
          if (item.yield && item.yield > 0) {
            quantity = totalValue / item.yield;
            cost = quantity * (item.cost || 0);
          }
          break;
        case 'unit':
          cost = totalValue * (item.costPerUnit || 0);
          break;
        case 'amount_per_units':
          if (item.perUnits && item.perUnits > 0) {
            quantity = totalValue / item.perUnits;
            cost = quantity * (item.amount || 0);
          }
          break;
      }
      return { ...item, costValue: cost, quantity, quantityUnit: item.unit };
    });
  }
  return [];
};

export const calculateTakeoffTotalCost = (takeoff: MeasurementTakeoff, totalValue: number): number => {
  if (takeoff.isAdvancedCost && takeoff.customCosts) {
    return takeoff.customCosts.reduce((sum, item) => {
      switch (item.type) {
        case 'flat':
          return sum + (item.cost || 0);
        case 'yield':
          if (item.yield && item.yield > 0) {
            return sum + (totalValue / item.yield) * (item.cost || 0);
          }
          return sum;
        case 'unit':
          return sum + totalValue * (item.costPerUnit || 0);
        case 'amount_per_units':
          if (item.perUnits && item.perUnits > 0) {
            return sum + (totalValue / item.perUnits) * (item.amount || 0);
          }
          return sum;
        default:
          return sum;
      }
    }, 0);
  } else if (takeoff.costPerUnit) {
    return totalValue * takeoff.costPerUnit;
  }
  return 0;
};

export const roundUpTo100 = (value: number): number =>
  value <= 0 ? 0 : Math.ceil(value / 100) * 100;

export const formatRealValue = (
  realValue: number,
  type: 'length' | 'area' | 'count',
  unit: string,
  takeoff?: MeasurementTakeoff,
  includeCost: boolean = true
): string => {
  let displayValue = realValue;
  let displayUnit = unit;

  if (type === 'count') {
    displayValue = Math.round(realValue);
    displayUnit = 'each';
  } else if (takeoff?.unit) {
    displayUnit = takeoff.unit;
    displayValue = convertUnit(realValue, unit, takeoff.unit, type);
  }

  let text = '';
  const readableUnit = UNIT_LABELS[displayUnit] || displayUnit;

  if (type === 'count') {
    text = `${displayValue} each`;
  } else if (!takeoff?.unit && type === 'length' && (unit === 'ft' || unit === 'in')) {
    const decimalFeet = unit === 'in' ? realValue / 12 : realValue;
    text = formatFeetAndInches(decimalFeet);
  } else if (!takeoff?.unit && type === 'area') {
    if (unit === 'ft') {
      text = `${realValue.toFixed(2)} sq ft`;
    } else if (unit === 'in') {
      text = `${realValue.toFixed(2)} sq in`;
    } else {
      const areaUnit = unit.startsWith('sq') ? readableUnit : `sq ${readableUnit}`;
      text = `${realValue.toFixed(2)} ${areaUnit}`;
    }
  } else {
    text = `${displayValue.toFixed(2)} ${readableUnit}`;
  }

  if (includeCost && takeoff) {
    if (takeoff.isAdvancedCost) {
      const details = calculateTakeoffCostDetails(takeoff, displayValue);
      const totalCost = details.reduce((sum, d) => sum + d.costValue, 0);
      if (totalCost > 0) {
        text += `\n$${totalCost.toFixed(2)}`;
        details.forEach(d => {
          if (d.quantity !== undefined && d.quantity > 0) {
            text += `\n(${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'} of ${d.name})`;
          }
        });
      }
    } else {
      const totalCost = calculateTakeoffTotalCost(takeoff, displayValue);
      if (totalCost > 0) {
        text += `\n$${totalCost.toFixed(2)}`;
      }
    }
  }

  return text;
};

export const formatMeasurement = (
  pixelValue: number,
  type: 'length' | 'area' | 'count',
  scale: ScaleConfig | null,
  takeoff?: MeasurementTakeoff,
  includeCost: boolean = false
): string => {
  if (type === 'count') {
    return formatRealValue(pixelValue, type, 'each', takeoff, includeCost);
  }

  if (!scale || scale.pixelDistance === 0) {
    return `${pixelValue.toFixed(2)} px${type === 'area' ? '²' : ''}`;
  }

  const realValue = calculateRealValue(pixelValue, type, scale);
  return formatRealValue(realValue, type, scale.unit, takeoff, includeCost);
};

export const calculateRealValue = (
  pixelValue: number,
  type: 'length' | 'area' | 'count',
  scale: ScaleConfig | null
): number => {
  if (type === 'count') return pixelValue;
  if (!scale || scale.pixelDistance === 0) return pixelValue;
  
  const ratio = scale.realWorldDistance / scale.pixelDistance;
  return type === 'length' ? pixelValue * ratio : pixelValue * Math.pow(ratio, 2);
};

export const evaluateMathExpression = (input: string): number | null => {
  const cleanInput = input.trim();
  if (!cleanInput) return null;

  if (!cleanInput.startsWith('=')) {
    const val = parseFloat(cleanInput);
    return isNaN(val) ? null : val;
  }

  try {
    // Remove the leading '='
    let expression = cleanInput.substring(1);
    
    // Replace percentages (e.g., 40% -> 0.4)
    // We need to be careful with things like 40% * 100
    // A simple regex to replace \d% with \d/100
    expression = expression.replace(/([\d.]+)\s*%/g, '($1/100)');
    
    // Basic sanitization: only allow numbers, operators, parentheses, and dots
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      return null;
    }

    // Use Function constructor for evaluation (relatively safe given the regex above)
    // eslint-disable-next-line no-new-func
    const result = new Function(`return ${expression}`)();
    
    const finalVal = parseFloat(result);
    return isNaN(finalVal) ? null : finalVal;
  } catch (e) {
    console.error('Math evaluation error:', e);
    return null;
  }
};
