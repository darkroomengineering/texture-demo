"use client";

import { useEffect, useRef, useState } from "react";

interface InfiniteCanvasProps {
  textureCount?: number;
  textureSize?: number;
}

export default function InfiniteCanvas({
  textureCount = 200,
  textureSize = 1024,
}: InfiniteCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mounted, setMounted] = useState(false);

  // Only render canvas on client
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let engine: import("./engine").InfiniteCanvasEngine | null = null;

    import("./engine").then(({ InfiniteCanvasEngine }) => {
      engine = new InfiniteCanvasEngine(canvas, { textureCount, textureSize });
      engine.start();
    });

    return () => {
      engine?.destroy();
    };
  }, [mounted, textureCount, textureSize]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#0a0a0a",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {mounted && <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 14,
              color: "rgba(255,255,255,0.7)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Infinite Texture Canvas
          </span>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              color: "rgba(255,255,255,0.35)",
            }}
          >
            Drag to pan &middot; Scroll to zoom &middot; Arrow keys / WASD
          </span>
        </div>
        <div
          id="canvas-stats"
          style={{
            fontFamily: "monospace",
            fontSize: 11,
            color: "rgba(255,255,255,0.4)",
            lineHeight: 1.6,
            alignSelf: "flex-end",
          }}
        />
      </div>
    </div>
  );
}
