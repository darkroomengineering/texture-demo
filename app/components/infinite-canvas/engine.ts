/**
 * Infinite Canvas Engine
 *
 * Orchestrates an infinite pannable image space. Rendering is delegated to
 * the portable instanced-quads and texture-array modules.
 */

import { InstancedQuadRenderer } from "./instanced-quads";
import { TextureArrayManager } from "./texture-array";

// --- Layout constants ---

const CHUNK_SIZE = 3200;
const PLANES_PER_CHUNK_DESKTOP = 8;
const PLANES_PER_CHUNK_MOBILE = 5;
const RENDER_DISTANCE = 2;
const FADE_MARGIN = 1.2;
const BASE_MIN = 100;
const BASE_MAX = 800;
const GAP = 40;

// --- Physics constants ---

const VEL_LERP = 0.08;
const VEL_DECAY = 0.95;
const ZOOM_LERP = 0.06;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4.0;

// --- Types ---

interface PlaneData {
  x: number;
  y: number;
  w: number;
  h: number;
  texIndex: number;
}

interface ChunkData {
  planes: PlaneData[];
}

interface EngineOptions {
  textureCount: number;
  textureSize: number;
}

// --- Seeded random ---

function hashChunk(cx: number, cy: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ cx, 16777619);
  h = Math.imul(h ^ cy, 16777619);
  h = Math.imul(h ^ (cx * 31 + cy * 17), 16777619);
  return h >>> 0;
}

function srand(seed: number, i: number): number {
  let h = seed + i * 374761393;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- Engine ---

export class InfiniteCanvasEngine {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private renderer: InstancedQuadRenderer | null = null;
  private textures: TextureArrayManager | null = null;
  private opts: EngineOptions;
  private isMobile: boolean;
  private planesPerChunk: number;

  // Camera
  private camX = 0;
  private camY = 0;
  private zoom = 1;
  private targetZoom = 1;
  private vx = 0;
  private vy = 0;
  private tvx = 0;
  private tvy = 0;

  // Input
  private dragging = false;
  private lastPx = 0;
  private lastPy = 0;
  private pinchDist = 0;
  private touches = new Map<number, { x: number; y: number }>();

  // Chunks
  private chunks = new Map<string, ChunkData>();

  // Lifecycle
  private raf = 0;
  private dead = false;
  private statsEl: HTMLElement | null = null;
  private frames = 0;
  private fpsTime = 0;
  private fps = 0;

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.canvas = canvas;
    this.opts = opts;
    this.isMobile =
      typeof window !== "undefined" &&
      window.matchMedia("(any-pointer: coarse) and (hover: none)").matches;
    this.planesPerChunk = this.isMobile ? PLANES_PER_CHUNK_MOBILE : PLANES_PER_CHUNK_DESKTOP;
  }

  start() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      console.error("WebGL2 not available");
      return;
    }
    this.gl = gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.04, 0.04, 0.04, 1);

    // Renderer
    this.renderer = new InstancedQuadRenderer(gl);
    if (!this.renderer.init()) {
      console.error("Failed to init renderer");
      return;
    }

    // Textures
    const texSize = this.isMobile ? Math.min(this.opts.textureSize, 512) : this.opts.textureSize;
    this.textures = new TextureArrayManager(gl, this.opts.textureCount, texSize);
    this.textures.create();
    this.textures.loadFromUrls(
      (i, w, h) => `https://picsum.photos/seed/img${i}/${w}/${h}`,
      this.isMobile ? 4 : 8,
      80,
    );

    this.bindInput();
    this.resize();
    window.addEventListener("resize", this.onResize);
    this.statsEl = document.getElementById("canvas-stats");
    this.fpsTime = performance.now();

    // Initial drift
    this.tvx = 1.5;
    this.tvy = 0.8;

    this.loop();
  }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    this.unbindInput();
    this.textures?.dispose();
    this.renderer?.dispose();
    if (this.gl) {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  // --- Chunks ---

  private getChunk(cx: number, cy: number): ChunkData {
    const key = `${cx},${cy}`;
    const cached = this.chunks.get(key);
    if (cached) return cached;

    const seed = hashChunk(cx, cy);
    const planes: PlaneData[] = [];
    const texCount = this.opts.textureCount;
    const scales = this.textures!.uvScales;

    for (let i = 0; i < this.planesPerChunk; i++) {
      const r = (n: number) => srand(seed, i * 12 + n);

      const texIndex = Math.floor(r(0) * 1_000_000) % texCount;
      const aspect = scales[texIndex]!.aspect;

      // Size: pick a base, then derive width/height from texture aspect ratio
      // Use a power distribution for more size variety (many small, few large)
      const t = r(1);
      const base = BASE_MIN + (t * t) * (BASE_MAX - BASE_MIN);
      let w: number;
      let h: number;
      if (aspect >= 1) {
        w = base;
        h = base / aspect;
      } else {
        h = base;
        w = base * aspect;
      }

      const x = cx * CHUNK_SIZE + GAP + r(2) * (CHUNK_SIZE - w - GAP * 2);
      const y = cy * CHUNK_SIZE + GAP + r(3) * (CHUNK_SIZE - h - GAP * 2);

      planes.push({ x, y, w, h, texIndex });
    }

    const chunk: ChunkData = { planes };

    if (this.chunks.size > 512) {
      const oldest = this.chunks.keys().next().value;
      if (oldest) this.chunks.delete(oldest);
    }

    this.chunks.set(key, chunk);
    return chunk;
  }

  // --- Input ---

  private bindInput() {
    const el = this.canvas;
    el.addEventListener("pointerdown", this.onPtrDown);
    el.addEventListener("pointermove", this.onPtrMove);
    el.addEventListener("pointerup", this.onPtrUp);
    el.addEventListener("pointercancel", this.onPtrUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("touchstart", this.onTouchStart, { passive: false });
    el.addEventListener("touchmove", this.onTouchMove, { passive: false });
    el.addEventListener("touchend", this.onTouchEnd);
    window.addEventListener("keydown", this.onKey);
  }

  private unbindInput() {
    const el = this.canvas;
    el.removeEventListener("pointerdown", this.onPtrDown);
    el.removeEventListener("pointermove", this.onPtrMove);
    el.removeEventListener("pointerup", this.onPtrUp);
    el.removeEventListener("pointercancel", this.onPtrUp);
    el.removeEventListener("wheel", this.onWheel);
    el.removeEventListener("touchstart", this.onTouchStart);
    el.removeEventListener("touchmove", this.onTouchMove);
    el.removeEventListener("touchend", this.onTouchEnd);
    window.removeEventListener("keydown", this.onKey);
  }

  private onPtrDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.dragging = true;
    this.lastPx = e.clientX;
    this.lastPy = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPtrMove = (e: PointerEvent) => {
    if (!this.dragging || e.pointerType === "touch") return;
    this.tvx -= (e.clientX - this.lastPx) * 0.3;
    this.tvy -= (e.clientY - this.lastPy) * 0.3;
    this.lastPx = e.clientX;
    this.lastPy = e.clientY;
  };

  private onPtrUp = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.dragging = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.targetZoom = clamp(this.targetZoom * (e.deltaY > 0 ? 0.92 : 1.08), MIN_ZOOM, MAX_ZOOM);
  };

  private onKey = (e: KeyboardEvent) => {
    const s = 8;
    if (e.key === "ArrowLeft" || e.key === "a") this.tvx -= s;
    else if (e.key === "ArrowRight" || e.key === "d") this.tvx += s;
    else if (e.key === "ArrowUp" || e.key === "w") this.tvy -= s;
    else if (e.key === "ArrowDown" || e.key === "s") this.tvy += s;
    else if (e.key === "=" || e.key === "+") this.targetZoom = clamp(this.targetZoom * 1.1, MIN_ZOOM, MAX_ZOOM);
    else if (e.key === "-") this.targetZoom = clamp(this.targetZoom * 0.9, MIN_ZOOM, MAX_ZOOM);
  };

  // Touch
  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (this.touches.size === 2) this.pinchDist = this.getPinch();
  };

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    if (this.touches.size === 1 && e.touches.length === 1) {
      const t = e.touches[0]!;
      const prev = this.touches.get(t.identifier);
      if (prev) {
        this.tvx -= (t.clientX - prev.x) * 0.4;
        this.tvy -= (t.clientY - prev.y) * 0.4;
        this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    } else if (this.touches.size >= 2 && e.touches.length >= 2) {
      for (const t of Array.from(e.touches)) {
        this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      const d = this.getPinch();
      if (this.pinchDist > 0) {
        this.targetZoom = clamp(this.targetZoom * (d / this.pinchDist), MIN_ZOOM, MAX_ZOOM);
      }
      this.pinchDist = d;
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) this.touches.delete(t.identifier);
    if (this.touches.size < 2) this.pinchDist = 0;
  };

  private getPinch(): number {
    const pts = Array.from(this.touches.values());
    if (pts.length < 2) return 0;
    const dx = pts[0]!.x - pts[1]!.x;
    const dy = pts[0]!.y - pts[1]!.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // --- Resize ---

  private onResize = () => this.resize();

  private resize() {
    const dpr = Math.min(window.devicePixelRatio, this.isMobile ? 1.5 : 2);
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // --- Loop ---

  private loop = () => {
    if (this.dead) return;
    this.update();
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private update() {
    this.vx += (this.tvx - this.vx) * VEL_LERP;
    this.vy += (this.tvy - this.vy) * VEL_LERP;
    this.camX += this.vx;
    this.camY += this.vy;
    this.tvx *= VEL_DECAY;
    this.tvy *= VEL_DECAY;
    this.zoom += (this.targetZoom - this.zoom) * ZOOM_LERP;
    if (Math.abs(this.tvx) < 0.01) this.tvx = 0;
    if (Math.abs(this.tvy) < 0.01) this.tvy = 0;

    this.frames++;
    const now = performance.now();
    if (now - this.fpsTime > 1000) {
      this.fps = this.frames;
      this.frames = 0;
      this.fpsTime = now;
    }
  }

  private render() {
    const gl = this.gl!;
    const renderer = this.renderer!;
    const texMgr = this.textures!;

    gl.clear(gl.COLOR_BUFFER_BIT);
    texMgr.bind();
    renderer.begin();

    // Visible chunk range
    const halfW = (this.canvas.width / this.zoom) * 0.5;
    const halfH = (this.canvas.height / this.zoom) * 0.5;
    const minCx = Math.floor((this.camX - halfW) / CHUNK_SIZE) - 1;
    const maxCx = Math.floor((this.camX + halfW) / CHUNK_SIZE) + 1;
    const minCy = Math.floor((this.camY - halfH) / CHUNK_SIZE) - 1;
    const maxCy = Math.floor((this.camY + halfH) / CHUNK_SIZE) + 1;

    const ccx = this.camX / CHUNK_SIZE;
    const ccy = this.camY / CHUNK_SIZE;

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const dx = cx + 0.5 - ccx;
        const dy = cy + 0.5 - ccy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const fade = dist <= RENDER_DISTANCE ? 1 : Math.max(0, 1 - (dist - RENDER_DISTANCE) / FADE_MARGIN);
        if (fade <= 0.001) continue;

        const chunk = this.getChunk(cx, cy);
        for (const p of chunk.planes) {
          const meta = texMgr.uvScales[p.texIndex]!;
          renderer.push(p.x, p.y, p.w, p.h, p.texIndex, fade, meta.sx, meta.sy);
        }
      }
    }

    renderer.flush(this.camX, this.camY, this.zoom);

    if (this.statsEl) {
      this.statsEl.textContent = [
        `${this.fps} fps`,
        `${renderer.instanceCount} quads`,
        `${texMgr.loadedCount}/${this.opts.textureCount} textures`,
        `zoom ${this.zoom.toFixed(2)}x`,
        this.isMobile ? "mobile" : "desktop",
      ].join(" \u00b7 ");
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
