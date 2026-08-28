import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { CvPalette } from "../theme";
import { KineticText } from "../../general/scenes/KineticText";
import { FitText } from "../../general/scenes/FitText";
import { readableTextColor } from "../../general/theme";

export type CvMotif = "none" | "diagonal" | "circle" | "stripe" | "dots" | "blocks";

// Latar aksen khas per-scene (di belakang konten) — bikin tiap scene beda karakter.
const Motif: React.FC<{ type: CvMotif; palette: CvPalette }> = ({ type, palette }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const a = palette.accent;
  const inn = spring({ fps, frame, config: { damping: 16 } });

  if (type === "diagonal") {
    const ty = interpolate(inn, [0, 1], [140, 0]);
    // opacity rendah → aksen latar, BUKAN blok pekat di belakang teks (biar teks tetap terbaca di bg)
    return <div style={{ position: "absolute", bottom: "-24%", left: "-20%", width: "140%", height: "72%", background: a, transform: `rotate(-12deg) translateY(${ty}px)`, opacity: 0.16 }} />;
  }
  if (type === "circle") {
    return <div style={{ position: "absolute", top: "-26%", right: "-34%", width: width * 1.0, height: width * 1.0, borderRadius: "50%", background: a, transform: `scale(${interpolate(inn, [0, 1], [0.6, 1])})`, opacity: 0.15 }} />;
  }
  if (type === "stripe") {
    const tx = interpolate(inn, [0, 1], [-160, 0]);
    return <div style={{ position: "absolute", top: "38%", left: "-30%", width: "160%", height: "24%", background: a, opacity: 0.16, transform: `rotate(-18deg) translateX(${tx}px)` }} />;
  }
  if (type === "dots") {
    return <AbsoluteFill style={{ opacity: interpolate(inn, [0, 1], [0, 0.22]), backgroundImage: `radial-gradient(${a} 3px, transparent 3px)`, backgroundSize: "46px 46px" }} />;
  }
  if (type === "blocks") {
    const items = [{ x: 6, y: 12, s: 90, r: -8 }, { x: 84, y: 20, s: 60, r: 10 }, { x: 12, y: 82, s: 54, r: 6 }, { x: 88, y: 78, s: 76, r: -12 }];
    return <>{items.map((it, i) => {
      const o = interpolate(spring({ fps, frame: frame - i * 4 }), [0, 1], [0, 0.5]);
      return <div key={i} style={{ position: "absolute", left: `${it.x}%`, top: `${it.y}%`, width: it.s, height: it.s, background: a, opacity: o, transform: `translate(-50%,-50%) rotate(${it.r + frame * 0.1}deg)`, borderRadius: 12 }} />;
    })}</>;
  }
  return null;
};

// Scene tipografi kinetik CV: bg 2-warna solid + motif khas + eyebrow + judul + list/angka/chips/paragraf.
export const CvScene: React.FC<{
  palette: CvPalette;
  eyebrow?: string;
  title?: string;
  items?: string[];
  chips?: string[];
  body?: string;
  big?: string;
  sub?: string;
  align?: "center" | "left";
  motif?: CvMotif;
}> = ({ palette, eyebrow, title, items, chips, body, big, sub, align = "center", motif = "none" }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const p = palette;
  const alignItems = align === "center" ? "center" : "flex-start";
  const inkPal = { brandB: p.bg, ink: p.text } as any;

  return (
    <AbsoluteFill style={{ background: p.bg, overflow: "hidden" }}>
      <Motif type={motif} palette={p} />

      <AbsoluteFill style={{ padding: "96px 56px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems, gap: 22, zIndex: 1 }}>
        {eyebrow && (
          <div style={{ opacity: spring({ fps, frame }), transform: `translateY(${interpolate(spring({ fps, frame }), [0, 1], [-20, 0])}px)` }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10, background: p.accent, color: readableTextColor(p.accent, inkPal),
              padding: "8px 18px", borderRadius: 100, fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 20, letterSpacing: 1, textTransform: "uppercase" }}>
              {eyebrow}
            </div>
          </div>
        )}

        {big && (
          <KineticText text={big} maxFontSize={150} maxBoxWidth={width * 0.86} maxLines={1}
            fontFamily="Poppins, sans-serif" fontWeight={900} color={p.accent} align={align} startFrame={4} style={{ lineHeight: 0.92 }} />
        )}

        {title && (
          <KineticText text={title} maxFontSize={96} maxBoxWidth={width * 0.88} maxLines={3}
            fontFamily="Poppins, sans-serif" fontWeight={900} color={p.text} align={align} startFrame={2} underline={p.accent} style={{ lineHeight: 1.02 }} />
        )}

        {sub && (
          <div style={{ marginTop: 6, fontFamily: "Inter, sans-serif", fontWeight: 600, fontSize: 34, color: p.text, opacity: interpolate(spring({ fps, frame: frame - 12 }), [0, 1], [0, 0.85]), textAlign: align }}>
            {sub}
          </div>
        )}

        {body && (
          <div style={{
            position: "relative", marginTop: 22, maxWidth: width * 0.88, alignSelf: align === "center" ? "center" : "flex-start",
            background: `${p.accent}16`, borderLeft: `8px solid ${p.accent}`, borderRadius: 18,
            padding: "28px 30px 28px 34px", boxShadow: `0 14px 34px rgba(0,0,0,0.28)`,
            opacity: interpolate(spring({ fps, frame: frame - 10 }), [0, 1], [0, 1]),
            transform: `translateX(${interpolate(spring({ fps, frame: frame - 10 }), [0, 1], [-24, 0])}px)`,
          }}>
            {/* tanda kutip aksen */}
            <div style={{ position: "absolute", top: -26, left: 16, fontFamily: "Poppins, sans-serif", fontWeight: 900, fontSize: 96, lineHeight: 1, color: p.accent, opacity: 0.9 }}>“</div>
            <div style={{ fontFamily: "Inter, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: 36, lineHeight: 1.42, color: p.text, textAlign: "left" }}>
              {body}
            </div>
          </div>
        )}

        {chips && chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: align === "center" ? "center" : "flex-start", maxWidth: width * 0.9, marginTop: 6 }}>
            {chips.map((c, i) => {
              const spr = spring({ fps, frame: frame - (10 + i * 6), config: { damping: 14 } });
              return (
                <div key={i} style={{ border: `3px solid ${p.accent}`, color: p.text, background: `${p.accent}1f`, padding: "12px 24px", borderRadius: 100,
                  fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 34, opacity: spr,
                  transform: `scale(${interpolate(spr, [0, 1], [0.7, 1])}) translateY(${interpolate(spr, [0, 1], [16, 0])}px)` }}>
                  {c}
                </div>
              );
            })}
          </div>
        )}

        {items && items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", alignItems, marginTop: 8 }}>
            {items.map((it, i) => {
              const spr = spring({ fps, frame: frame - (10 + i * 7), config: { damping: 14 } });
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 18, maxWidth: width * 0.9,
                  opacity: spr, transform: `translateX(${interpolate(spr, [0, 1], [align === "center" ? 0 : -40, 0])}px) translateY(${interpolate(spr, [0, 1], [26, 0])}px)` }}>
                  <div style={{ width: 34, height: 8, borderRadius: 4, background: p.accent, flexShrink: 0 }} />
                  <FitText text={it} maxFontSize={52} maxBoxWidth={width * 0.78} maxLines={1} fontFamily="Poppins, sans-serif" fontWeight={800} style={{ color: p.text }} />
                </div>
              );
            })}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
