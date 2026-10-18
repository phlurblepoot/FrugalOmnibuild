export type Point = { x: number; y: number };

export type MeasurementType = 'scale' | 'length' | 'area' | 'count';

export interface MeasurementSegment {
  points: Point[];
  arcMidIndices?: number[];
  /** Cutout: this polygon's area subtracts from the measurement's net area
   *  (windows/doors). Only meaningful on area measurements. */
  subtract?: boolean;
}

export interface Measurement {
  id: string;
  type: MeasurementType;
  points: Point[];
  color: string; // Used if not in a takeoff
  name: string;
  takeoffId?: string;
  heights?: number[];
  isTwoSided?: boolean;
  regionId?: string;
  planSetId?: string; // The plan set version this measurement was made/updated on
  arcMidIndices?: number[]; // indices of arc mid-control points; triples (i-1, i, i+1) are arcs
  segments?: MeasurementSegment[]; // additional segments (first segment lives in points/arcMidIndices)
  /** Length/area only: the measurement counts this many times (e.g. 4 for one
   *  floor plan standing in for four identical floors). A whole number; unset
   *  means 1. Read it through measurementMultiplier() (src/utils/multiplier.ts). */
  multiplier?: number;
}

export type CostType = 'flat' | 'yield' | 'unit' | 'amount_per_units';

export interface CustomCost {
  id: string;
  name: string;
  type: CostType;
  cost?: number;
  yield?: number;
  costPerUnit?: number;
  amount?: number;
  perUnits?: number;
  unit?: string;
}

export interface MeasurementTakeoff {
  id: string;
  name: string;
  color: string;
  type: MeasurementType;
  unit?: string;
  costPerUnit?: number;
  isAdvancedCost?: boolean;
  customCosts?: CustomCost[];
  pricePackage?: string;
}

export interface TakeoffTemplate {
  id: string;
  name: string;
  color: string;
  type: MeasurementType;
  unit?: string;
  costPerUnit?: number;
  isAdvancedCost?: boolean;
  customCosts?: CustomCost[];
  createdAt: number;
}

export interface ScaleConfig {
  pixelDistance: number;
  realWorldDistance: number;
  unit: string;
  label?: string;
}

export interface PlanSet {
  id: string;
  name: string;
  date?: string;
  createdAt: number;
}

export interface ScaleRegion {
  id: string;
  name: string;
  points: Point[];
  scaleConfig: ScaleConfig | null;
  color: string;
}

export interface ProjectPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  // Legacy raster-page reference. Pages uploaded under the old pipeline have an
  // imageId pointing at a full-size JPEG; new uploads leave these empty and use
  // sourcePdfFileId + sourcePdfPageNum instead so the original vectors survive.
  imageId: string;
  thumbnailId?: string;
  imageWidth: number;
  imageHeight: number;
  // Vector source for the page. When sourcePdfFileId is set, the canvas renders
  // this PDF page on demand via pdf.js and printouts copy its vectors via pdf-lib.
  // Multiple ProjectPages from one upload share the same sourcePdfFileId.
  sourcePdfFileId?: string;
  sourcePdfPageNum?: number; // 1-based index within sourcePdfFileId
  // True once extractedText has been populated from the source PDF's
  // embedded text layer (vs. OCR or upload-time guess). ProjectView's mount
  // effect reindexes any vector page where this flag isn't set, so future
  // search hits use the real text the PDF was written with.
  searchTextIndexed?: boolean;
  measurements: Measurement[];
  scaleConfig: ScaleConfig | null;
  // Durable logical-sheet id (optional for legacy/in-flight pages — the
  // migration backfills it). All revisions of one sheet share a sheetId. The
  // newest revision (by plan-set order) is current/living; older are read-only
  // history.
  sheetId?: string;
  planSetId?: string; // Optional for backwards compatibility
  isMultiRegion?: boolean;
  scaleRegions?: ScaleRegion[];
  extractedText?: string;
  showLegend?: boolean;
  showLegendTotals?: boolean;
  legendPosition?: { x: number, y: number };
  legendScale?: number;
  legendScaleX?: number;
  legendScaleY?: number;
  legendFontSize?: number;
  legendWidth?: number;
}

// Email thread attached to a project (moved from the old bid pipeline on conversion,
// or created directly when a project is sent a proposal via SMTP).
export interface BidEmail {
  messageId?: string;       // Original Message-ID header for reply threading
  from: string;             // Sender email address
  fromName?: string;        // Sender display name
  subject: string;
  body: string;             // Plain text body
  htmlBody?: string;        // HTML body
  receivedAt: number;       // Timestamp
  attachmentIds?: string[]; // File IDs stored in images table
  accountId?: string;       // Inbound-account id retained for legacy data compatibility (IMAP removed).
}

export interface RoleEmailSet {
  /** Comma-separated address list. */
  to?: string;
  cc?: string;
  bcc?: string;
}
export interface CustomerRoleEmails {
  general?: RoleEmailSet;
  accounting?: RoleEmailSet;
  estimating?: RoleEmailSet;
  pm?: RoleEmailSet;
}
export interface Customer {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  contactName?: string;
  notes?: string;
  emails: CustomerRoleEmails;
  createdAt?: number;
  updatedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  contractor?: string;
  customerId?: string;
  /** Optional project-specific role-email overrides (rides in project meta). */
  contactEmails?: CustomerRoleEmails;
  address?: string;
  bidDueDate?: number | null;
  planSets?: PlanSet[];
  pages: ProjectPage[];
  takeoffs: MeasurementTakeoff[];
  submitted?: boolean;
  responded?: boolean;
  accepted?: boolean;
  archived?: boolean;
  legendOnAllPages?: boolean;
  // Email thread the project was created from (moved from the bid pipeline on conversion)
  email?: BidEmail;
  emails?: BidEmail[];
  // Optimistic-concurrency version — echoed back on save; the server rejects
  // stale saves with 409. Assigned by the server (1 on create).
  version?: number;
  // Lifecycle stage — two stages only (bidding | in_progress). Archiving and
  // lost-bid tracking are independent flags (`archived`, `lostBid`), not
  // stages, so an archived project keeps the stage it was in. Server-derived;
  // legacy 8-stage values are collapsed on read (normalizeProjectStatus).
  status?: string;
}

export type Tool = 'pan' | 'scale' | 'length' | 'area' | 'count' | 'region' | 'subtract';

export interface NoteElement {
  id: string;
  type: 'text' | 'image' | 'link' | 'table' | 'drawing' | 'scale_area' | 'polyline';
  x: number;
  y: number;
  width?: number;
  height?: number;
  content?: string; // For text, link
  data?: any; // For table, drawing, scale_area
  imageUrl?: string; // For image
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  color?: string;
  fontSize?: number;
  strokeWidth?: number;
  isNew?: boolean;
}

export interface ProjectNote {
  id: string;
  projectId: string;
  elements: NoteElement[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  createdAt: number;
  updatedAt: number;
}
