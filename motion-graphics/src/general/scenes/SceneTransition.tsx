import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";

export type TransitionType =
  | "fade" | "slideUp" | "slideDown" | "slideRight" | "slideLeft" | "zoomIn" | "zoomOut" | "wipe" | "flip" | "diagonal";

// Transisi masuk & keluar per-scene (di atas background yang kontinu).
// Divariasikan per scene index di MotionGeneral → tiap perpindahan beda efek.
export const SceneTransition: React.FC<{
  type: TransitionType;
  durationInFrames: number;
  children: React.ReactNode;
}> = ({ type, durationInFrames, children }) => {
  const frame = useCurrentFrame();
  const ENTER = 12, EXIT = 9;

  const e = interpolate(frame, [0, ENTER], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
  });
  const x = interpolate(frame, [durationInFrames - EXIT, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic),
  });
  const fadeOpacity = Math.min(e, 1 - x);

  let style: React.CSSProperties = { opacity: fadeOpacity };
  switch (type) {
    case "slideUp":
      style = { opacity: fadeOpacity, transform: `translateY(${interpolate(e, [0, 1], [72, 0])}px) translateY(${interpolate(x, [0, 1], [0, -52])}px)` };
      break;
    case "slideDown":
      style = { opacity: fadeOpacity, transform: `translateY(${interpolate(e, [0, 1], [-72, 0])}px) translateY(${interpolate(x, [0, 1], [0, 52])}px)` };
      break;
    case "slideRight":
      style = { opacity: fadeOpacity, transform: `translateX(${interpolate(e, [0, 1], [-96, 0])}px) translateX(${interpolate(x, [0, 1], [0, 74])}px)` };
      break;
    case "slideLeft":
      style = { opacity: fadeOpacity, transform: `translateX(${interpolate(e, [0, 1], [96, 0])}px) translateX(${interpolate(x, [0, 1], [0, -74])}px)` };
      break;
    case "zoomIn":
      style = { opacity: fadeOpacity, transform: `scale(${interpolate(e, [0, 1], [1.14, 1])}) scale(${interpolate(x, [0, 1], [1, 0.92])})` };
      break;
    case "zoomOut":
      style = { opacity: fadeOpacity, transform: `scale(${interpolate(e, [0, 1], [0.86, 1])}) scale(${interpolate(x, [0, 1], [1, 1.1])})` };
      break;
    case "flip":
      style = { opacity: fadeOpacity, transformOrigin: "center", transform: `perspective(1400px) rotateX(${interpolate(e, [0, 1], [30, 0])}deg) rotateX(${interpolate(x, [0, 1], [0, -22])}deg)` };
      break;
    case "wipe": {
      const leftIn = interpolate(e, [0, 1], [100, 0]);
      const rightOut = interpolate(x, [0, 1], [0, 100]);
      style = { opacity: 1, clipPath: `inset(0 ${rightOut}% 0 ${leftIn}%)` };
      break;
    }
    case "diagonal": {
      // Reveal diagonal (kiri-bawah → kanan-atas), khas video resume
      const r = interpolate(e, [0, 1], [-60, 160]);
      style = { opacity: Math.min(1, 1 - x * 0.6), clipPath: `polygon(0% 0%, ${r}% 0%, ${r - 60}% 100%, 0% 100%)` };
      break;
    }
    case "fade":
    default:
      style = { opacity: fadeOpacity };
      break;
  }

  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};
