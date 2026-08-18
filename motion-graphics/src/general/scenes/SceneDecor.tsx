import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Props } from "../schema";

// Elemen dekoratif untuk MENGISI RUANG kosong (ring, plus, dot, bracket) —
// melayang halus, opacity rendah, warna aksen. Bikin frame gak "kosong & standar".
export const SceneDecor: React.FC<{ palette: NonNullable<Props["theme"]["palette"]>; opacity?: number }> = ({
  palette,
  opacity = 0.16,
}) => {
  const frame = useCurrentFrame();
  const items: { x: number; y: number; s: number; type: "ring" | "plus" | "dot" | "bracket" }[] = [
    { x: 9, y: 15, s: 78, type: "ring" },
    { x: 88, y: 22, s: 40, type: "plus" },
    { x: 15, y: 82, s: 30, type: "dot" },
    { x: 90, y: 78, s: 70, type: "ring" },
    { x: 80, y: 55, s: 34, type: "plus" },
    { x: 12, y: 50, s: 46, type: "bracket" },
  ];

  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: 0 }}>
      {items.map((it, i) => {
        const t = frame * 0.02 + i;
        const fy = Math.sin(t) * 12;
        const fx = Math.cos(t * 0.8) * 8;
        const rot = frame * 0.15 * (i % 2 ? 1 : -1);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${it.x}%`,
              top: `${it.y}%`,
              transform: `translate(-50%, -50%) translate(${fx}px, ${fy}px) rotate(${rot}deg)`,
              opacity,
            }}
          >
            {it.type === "ring" && (
              <div style={{ width: it.s, height: it.s, borderRadius: "50%", border: `${Math.max(4, it.s * 0.08)}px solid ${palette.accent}` }} />
            )}
            {it.type === "dot" && <div style={{ width: it.s, height: it.s, borderRadius: "50%", background: palette.accent }} />}
            {it.type === "plus" && (
              <div style={{ position: "relative", width: it.s, height: it.s }}>
                <div style={{ position: "absolute", top: "44%", left: 0, width: "100%", height: "12%", borderRadius: 4, background: palette.accent }} />
                <div style={{ position: "absolute", left: "44%", top: 0, height: "100%", width: "12%", borderRadius: 4, background: palette.accent }} />
              </div>
            )}
            {it.type === "bracket" && (
              <div style={{ width: it.s, height: it.s * 1.4, borderLeft: `${Math.max(4, it.s * 0.09)}px solid ${palette.accent}`, borderTop: `${Math.max(4, it.s * 0.09)}px solid ${palette.accent}`, borderBottom: `${Math.max(4, it.s * 0.09)}px solid ${palette.accent}`, borderTopLeftRadius: 12, borderBottomLeftRadius: 12 }} />
            )}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
