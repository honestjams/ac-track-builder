// Sign artwork: everything that needs text or a printed face (street name
// blades, shop and landmark signs, traffic signs) is drawn into one texture
// atlas. Drawing text needs fonts, so the atlas is rendered by the caller
// (a canvas in the browser); the build only says what it needs and gets back
// where each piece landed.

export type ArtKind =
  | "street" // white on blue street name blade
  | "poi" // business / landmark sign; colour picks the panel colour
  | "tourist" // brown tourist sign
  | "speed" // speed limit roundel, text = the number
  | "stop"
  | "giveway"
  | "warning" // yellow diamond, text = a symbol hint (curve-left, curve-right, ...)
  | "chevron" // chevron alignment marker, text = "left" | "right"
  | "noentry"
  | "keepleft"
  | "bus" // bus stop plate
  | "info" // blue square, text = short label
  | "back" // plain grey back of a sign
  | "gate"; // timing gate sign: text = "START" or "FINISH"

export interface ArtRequest {
  key: string;
  kind: ArtKind;
  text?: string;
  /** CSS colour for "poi" panels. */
  colour?: string;
}

/** Where a piece of art sits in the atlas (UV, v = 0 at the top) and its shape. */
export interface ArtCell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Width / height of the artwork. */
  aspect: number;
}

export interface ArtAtlas {
  /** PNG with alpha (sign shapes are cut out). */
  data: Uint8Array;
  cells: Record<string, ArtCell>;
}

export type ArtRenderer = (items: ArtRequest[]) => Promise<ArtAtlas>;

/** Collects requests, deduplicated by key. */
export class ArtList {
  private items = new Map<string, ArtRequest>();
  add(r: ArtRequest): string {
    if (!this.items.has(r.key)) this.items.set(r.key, r);
    return r.key;
  }
  get list(): ArtRequest[] {
    return [...this.items.values()];
  }
}

export const streetKey = (name: string) => `street:${name}`;
