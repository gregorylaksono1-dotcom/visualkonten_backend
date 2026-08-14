import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { createRng } from "./rng";
import { getBehaviorPos } from "./behaviors";
import { renderShape } from "./shapes";
import { Props } from "../schema";

export type ParticleConfig = {
  id: number;
  x0: number;
  y0: number;
  r: number;
  ang: number;
  rMax: number;
  rot0: number;
  phase: number;
  speed: number;
  size: number;
  color: string;
  behavior: string;
};

export const Particles: React.FC<{
  accent: Props["accent"];
  burstTriggers?: number[]; // Frame indices where bursts happen
  featuresRange?: [number, number]; // [startFrame, endFrame] for features scene
}> = ({ accent, burstTriggers = [], featuresRange = [-1, -1] }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const count = useMemo(() => {
    switch (accent.density) {
      case "low": return 14;
      case "high": return 46;
      case "med":
      default: return 28;
    }
  }, [accent.density]);

  const [particles, extraParticles] = useMemo(() => {
    const rng = createRng(42); // Fixed seed for deterministic behavior
    const arr: ParticleConfig[] = [];
    const extra: ParticleConfig[] = []; // Extra foreground particles for features scene

    // Normal particles
    for (let i = 0; i < count; i++) {
      arr.push({
        id: i,
        x0: rng.next(),
        y0: rng.next(),
        r: rng.range(0.2, 0.4),
        ang: rng.range(0, Math.PI * 2),
        rMax: rng.range(0.3, 0.6),
        rot0: rng.range(0, 360),
        phase: rng.range(0, Math.PI * 2),
        speed: rng.range(0.6, 1.6),
        // rentang ukuran lebih lebar → kedalaman (kecil-tajam s/d besar-blur)
        size: rng.range(5, 40),
        color: accent.colors[i % accent.colors.length],
        behavior: accent.behavior,
      });
    }

    // Extra bokeh particles (density +1 effectively, roughly 20 extra)
    for (let i = 0; i < 20; i++) {
      extra.push({
        id: i + count,
        x0: rng.next(),
        y0: rng.next(),
        r: rng.range(0.3, 0.5),
        ang: rng.range(0, Math.PI * 2),
        rMax: rng.range(0.4, 0.8),
        rot0: rng.range(0, 360),
        phase: rng.range(0, Math.PI * 2),
        speed: rng.range(0.8, 2.0),
        size: rng.range(12, 32), // Bigger for foreground
        color: accent.colors[i % accent.colors.length],
        behavior: accent.behavior,
      });
    }

    return [arr, extra];
  }, [count, accent.behavior, accent.colors]);

  const isInFeatures = featuresRange[0] !== -1 && frame >= featuresRange[0] && frame <= featuresRange[1];
  // Smoothly fade in/out extra particles
  const extraOpacityMult = featuresRange[0] !== -1 ?
    interpolate(frame, [featuresRange[0], featuresRange[0] + 15, featuresRange[1] - 15, featuresRange[1]], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;

  return (
    <AbsoluteFill>
      {/* Base Particles — dengan kedalaman: besar = blur+samar (background), kecil = tajam (foreground) */}
      {particles.map((p) => {
        const { x, y, rotation, scale, opacity } = getBehaviorPos(p, frame, fps, burstTriggers);
        if (opacity <= 0) return null;
        const depthBlur = p.size > 24 ? (p.size - 24) / 5 : 0;      // 0..~3px
        const depthOpacity = p.size > 24 ? 0.45 : p.size < 10 ? 0.8 : 1;
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: x * width,
              top: y * height,
              transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`,
              opacity: opacity * depthOpacity,
              filter: depthBlur > 0 ? `blur(${depthBlur}px)` : undefined,
              pointerEvents: "none",
            }}
          >
            {renderShape(accent.shape, p.color, p.size, accent.mode, accent.asset)}
          </div>
        );
      })}

      {/* Extra Foreground Bokeh Particles (only visible during features scene) */}
      {extraOpacityMult > 0 && extraParticles.map((p) => {
        const { x, y, rotation, scale, opacity } = getBehaviorPos(p, frame, fps, burstTriggers);
        const finalOpacity = opacity * extraOpacityMult * 0.7; // slightly transparent bokeh
        if (finalOpacity <= 0) return null;
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: x * width,
              top: y * height,
              transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`,
              opacity: finalOpacity,
              filter: "blur(6px)", // Bokeh blur
              pointerEvents: "none",
              zIndex: 10, // Bring to front
            }}
          >
            {renderShape(accent.shape, p.color, p.size, accent.mode, accent.asset)}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};