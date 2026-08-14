import { ParticleConfig } from "./Particles";
import { interpolate, Easing } from "remotion";

const wrap = (val: number, min: number, max: number) => {
  const range = max - min;
  let v = (val - min) % range;
  if (v < 0) v += range;
  return min + v;
};

export const getBehaviorPos = (
  p: ParticleConfig,
  frame: number,
  fps: number,
  burstTriggers: number[]
) => {
  const t = (frame / fps) * p.speed + p.phase;
  
  if (p.behavior === "fall") {
    return {
      x: p.x0 + Math.sin(t) * 0.03,
      y: wrap(p.y0 + (frame / fps) * p.speed * 0.5, -0.1, 1.1),
      rotation: p.rot0 + t * 45,
      scale: 1,
      opacity: 1
    };
  }

  if (p.behavior === "float") {
    return {
      x: p.x0 + Math.sin(t * 1.3) * 0.05,
      y: wrap(p.y0 - (frame / fps) * p.speed * 0.4, -0.1, 1.1),
      rotation: p.rot0 + Math.sin(t) * 30,
      scale: 1,
      opacity: 1
    };
  }

  if (p.behavior === "orbit") {
    const cx = 0.5;
    const cy = 0.42;
    const angle = p.phase + t * 0.8;
    const r = p.r * (1 + 0.05 * Math.sin(t));
    return {
      x: cx + Math.cos(angle) * r * 0.5,
      y: cy + Math.sin(angle) * r,
      rotation: angle * (180 / Math.PI),
      scale: 1 + Math.sin(t * 2) * 0.2,
      opacity: 1
    };
  }

  if (p.behavior === "sweep") {
    return {
      x: wrap(p.x0 + (frame / fps) * p.speed * 0.8, -0.1, 1.1),
      y: p.y0 + Math.sin(t) * 0.02,
      rotation: p.rot0,
      scale: 1,
      opacity: 1
    };
  }

  if (p.behavior === "burst") {
    // Find the most recent burst trigger
    let activeTrigger = -1;
    for (const trig of burstTriggers) {
      if (frame >= trig) activeTrigger = trig;
    }

    if (activeTrigger >= 0) {
      const localFrame = frame - activeTrigger;
      const localT = localFrame / fps;
      
      const r = interpolate(localT, [0, 1], [0, p.rMax], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.quad),
      });

      const opacity = interpolate(localT, [0, 0.8, 1], [1, 1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp"
      });

      const cx = 0.5;
      const cy = 0.42;
      return {
        x: cx + Math.cos(p.ang) * r,
        y: cy + Math.sin(p.ang) * r,
        rotation: p.rot0 + localT * 90,
        scale: interpolate(localT, [0, 0.2, 1], [0, 1, 0.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        opacity
      };
    }
    
    return { x: -1, y: -1, rotation: 0, scale: 0, opacity: 0 };
  }

  return { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };
};
