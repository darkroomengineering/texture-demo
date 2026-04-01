/**
 * TextureArrayManager
 *
 * Portable WebGL2 TEXTURE_2D_ARRAY manager for loading many varied-aspect-ratio
 * images into a single GPU texture bind. Images are letterboxed into square
 * slots and UV scale metadata is exposed so the renderer can show only the
 * image portion.
 *
 * ## Porting to another project
 *
 * 1. Copy this file — it has zero framework dependencies.
 * 2. Call `create()` once with a WebGL2 context.
 * 3. Call `loadFromUrls()` with your image URLs.
 * 4. Bind with `bind()` before drawing.
 * 5. Read `uvScales` to get per-layer { sx, sy } for the vertex shader.
 *
 * The key performance insight: TEXTURE_2D_ARRAY lets you batch hundreds of
 * images into a single texture bind. Combined with instanced rendering
 * (see instanced-quads.ts), this gives one draw call for all visible quads
 * regardless of how many unique textures are shown.
 *
 * ### Limitations
 * - All layers share the same pixel dimensions (square, set by `slotSize`).
 * - Max layers depends on GPU (typically 256–2048; query MAX_ARRAY_TEXTURE_LAYERS).
 * - Requires WebGL2 (TEXTURE_2D_ARRAY is not in WebGL1).
 */

// Aspect ratio presets — landscape, portrait, square, panoramic
const ASPECT_PRESETS: [number, number][] = [
  [4, 3],
  [3, 2],
  [16, 9],
  [2, 1],
  [3, 1],
  [3, 4],
  [2, 3],
  [9, 16],
  [1, 2],
  [1, 1],
  [1, 1],
  [5, 4],
  [4, 5],
  [16, 10],
  [10, 16],
];

interface TextureLayerMeta {
  /** UV X scale — fraction of slot width used by the image (0–1) */
  sx: number;
  /** UV Y scale — fraction of slot height used by the image (0–1) */
  sy: number;
  /** Original image aspect ratio (width / height) */
  aspect: number;
}

export class TextureArrayManager {
  readonly slotSize: number;
  readonly layerCount: number;
  readonly uvScales: TextureLayerMeta[];

  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture | null = null;
  private scratchCanvas: OffscreenCanvas | HTMLCanvasElement;
  private scratchCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private _loadedCount = 0;
  private destroyed = false;

  get loadedCount() {
    return this._loadedCount;
  }

  constructor(gl: WebGL2RenderingContext, layerCount: number, slotSize: number) {
    this.gl = gl;
    this.layerCount = layerCount;
    this.slotSize = slotSize;
    this.uvScales = new Array(layerCount);

    // Pre-compute UV scales and aspect ratios for each layer
    for (let i = 0; i < layerCount; i++) {
      const preset = ASPECT_PRESETS[i % ASPECT_PRESETS.length]!;
      const aspect = preset[0] / preset[1];
      if (aspect >= 1) {
        // Landscape or square — full width, partial height
        this.uvScales[i] = { sx: 1, sy: 1 / aspect, aspect };
      } else {
        // Portrait — partial width, full height
        this.uvScales[i] = { sx: aspect, sy: 1, aspect };
      }
    }

    // Offscreen canvas for letterboxing
    if (typeof OffscreenCanvas !== "undefined") {
      this.scratchCanvas = new OffscreenCanvas(slotSize, slotSize);
      this.scratchCtx = this.scratchCanvas.getContext("2d")!;
    } else {
      const c = document.createElement("canvas");
      c.width = slotSize;
      c.height = slotSize;
      this.scratchCanvas = c;
      this.scratchCtx = c.getContext("2d")!;
    }
  }

  /** Allocate the GPU texture array and fill with placeholder colors. */
  create() {
    const gl = this.gl;
    this.texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);

    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.slotSize, this.slotSize, this.layerCount);

    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Fill each layer with a distinct placeholder color
    const pixel = new Uint8Array(4);
    for (let i = 0; i < this.layerCount; i++) {
      const hue = (i * 137.508) % 360;
      const [r, g, b] = hslToRgb(hue / 360, 0.45, 0.18);
      pixel[0] = r;
      pixel[1] = g;
      pixel[2] = b;
      pixel[3] = 255;
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    }
  }

  /** Load images progressively. `urlFn(index, width, height)` returns the URL. */
  loadFromUrls(
    urlFn: (index: number, width: number, height: number) => string,
    batchSize = 6,
    batchDelayMs = 80,
  ) {
    this.loadBatch(0, urlFn, batchSize, batchDelayMs);
  }

  /** Bind the texture array to TEXTURE0. */
  bind() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
  }

  dispose() {
    this.destroyed = true;
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
  }

  // --- Internal ---

  private loadBatch(
    start: number,
    urlFn: (i: number, w: number, h: number) => string,
    batchSize: number,
    delayMs: number,
  ) {
    if (this.destroyed || start >= this.layerCount) return;
    const end = Math.min(start + batchSize, this.layerCount);

    for (let i = start; i < end; i++) {
      const meta = this.uvScales[i]!;
      // Compute request dimensions that fit in slotSize
      const reqW = Math.round(this.slotSize * meta.sx);
      const reqH = Math.round(this.slotSize * meta.sy);
      this.loadOne(i, urlFn(i, reqW, reqH), reqW, reqH);
    }

    setTimeout(() => this.loadBatch(end, urlFn, batchSize, delayMs), delayMs);
  }

  private loadOne(index: number, url: string, imgW: number, imgH: number) {
    if (this.destroyed) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;

    img.onload = () => {
      if (this.destroyed) return;
      this.uploadLayer(index, img, imgW, imgH);
      this._loadedCount++;
    };
    img.onerror = () => {
      this._loadedCount++;
    };
  }

  private uploadLayer(index: number, img: HTMLImageElement, imgW: number, imgH: number) {
    const gl = this.gl;
    const ctx = this.scratchCtx;
    const s = this.slotSize;

    // Clear to transparent, then draw image centered
    ctx.clearRect(0, 0, s, s);
    const dx = Math.round((s - imgW) / 2);
    const dy = Math.round((s - imgH) / 2);
    ctx.drawImage(img, dx, dy, imgW, imgH);

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      index,
      s,
      s,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.scratchCanvas as TexImageSource,
    );
  }
}

// --- Utility ---

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, h + 1 / 3);
  const g = hue2rgb(p, q, h);
  const b = hue2rgb(p, q, h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}
