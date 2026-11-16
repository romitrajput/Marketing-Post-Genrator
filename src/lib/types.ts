export type Confidence = 'high' | 'medium' | 'manual';

export type LayerKind =
  | 'background'
  | 'subject'
  | 'object'
  | 'graphic'
  | 'shape'
  | 'text'
  | 'image'
  | 'original';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A source image held in memory for the current session. */
export interface SourceImage {
  blob: Blob;
  url: string; // object URL
  name: string;
  width: number;
  height: number;
  bytes: number;
  type: string;
}

/** One approximate layer produced by the decomposition engine. */
export interface LayerSpec {
  id: string;
  name: string;
  kind: LayerKind;
  confidence: Confidence;
  box: Box; // position in document (= original image) pixels
  url: string; // transparent PNG object URL (cropped to box)
  include: boolean; // user can untick before opening the studio
  visible: boolean;
  note?: string;
  // text-specific
  text?: string;
  textColor?: string;
  fontSize?: number;
  onObject?: boolean;
  parentId?: string; // object the text is painted on
  parentBg?: string; // local colour behind the glyphs (used to repaint the parent)
  // mask coverage (0-1) of the box, informative
  coverage?: number;
}

export interface Decomposition {
  docW: number;
  docH: number;
  layers: LayerSpec[]; // bottom -> top
  log: string[];
}

/** Metadata stored on each Fabric object (serialised with the project). */
export interface LayerMeta {
  id: string;
  name: string;
  kind: LayerKind;
  confidence?: Confidence;
  locked?: boolean;
  note?: string;
  // Raster layers: un-processed cutout so feather / colour match can be re-applied non-destructively
  baseSrc?: string;
  feather?: number;
  colorMatch?: { mean: number[]; std: number[] } | null;
  /** colour statistics of the layer this one replaced (target for "Match colours") */
  matchTarget?: { mean: number[]; std: number[] } | null;
  // Where this layer came from in the original image (enables "Refine mask")
  origBox?: Box;
  // text layers detected by OCR
  ocrText?: string;
  textColor?: string;
  fontSize?: number;
  onObject?: boolean;
  parentId?: string;
  parentBg?: string;
  // adjustments (kept here so the panel can show slider values)
  adj?: Adjustments;
}

export interface Adjustments {
  brightness: number; // -1..1
  contrast: number; // -1..1
  saturation: number; // -1..1
  temperature: number; // -1..1
  blur: number; // 0..1
}

export const DEFAULT_ADJ: Adjustments = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, blur: 0 };

export interface StepState {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  progress?: number; // 0..1
}
