import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { CvPalette } from "../theme";
import { readableTextColor } from "../../general/theme";

// Scene KEAHLIAN dengan progress bar (level 0–100, diisi user).
export const CvSkills: React.FC<{
  palette: CvPalette;
  skills: { name: string; level: number }[];
}> = ({ palette, skills }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const p = palette;

  return (
    <AbsoluteFill style={{ background: p.bg, padding: "96px 56px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 }}>
      <div style={{ opacity: spring({ fps, frame }), transform: `translateY(${interpolate(spring({ fps, frame }), [0, 1], [-20, 0])}px)`, marginBottom: 10 }}>
        <div style={{ display: "inline-flex", background: p.accent, color: readableTextColor(p.accent, { brandB: p.bg, ink: p.text } as any),
          padding: "8px 18px", borderRadius: 100, fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 22, letterSpacing: 1, textTransform: "uppercase" }}>
          Keahlian
        </div>
      </div>

      {skills.map((s, i) => {
        const barSpr = spring({ fps, frame: frame - (10 + i * 8), config: { damping: 18 } });
        const w = interpolate(barSpr, [0, 1], [0, Math.max(0, Math.min(100, s.level))]);
        const rowIn = spring({ fps, frame: frame - (6 + i * 8) });
        return (
          <div key={i} style={{ opacity: rowIn, transform: `translateX(${interpolate(rowIn, [0, 1], [-30, 0])}px)` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
              <span style={{ fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 42, color: p.text }}>{s.name}</span>
              <span style={{ fontFamily: "Poppins, sans-serif", fontWeight: 900, fontSize: 34, color: p.accent }}>{Math.round(w)}%</span>
            </div>
            <div style={{ height: 18, borderRadius: 100, background: `${p.text}22`, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${w}%`, borderRadius: 100, background: p.accent, boxShadow: `0 0 16px ${p.accent}88` }} />
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
