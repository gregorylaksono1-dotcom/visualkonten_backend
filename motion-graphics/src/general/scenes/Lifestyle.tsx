import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, sanitizeText, readableTextColor } from "../theme";
import { KineticText } from "./KineticText";
import { SceneDecor } from "./SceneDecor";

// Scene "lifestyle" (b-roll AI, 1 gambar): full-bleed + Ken-Burns + banyak aksen.
export const Lifestyle: React.FC<{
  scene: any;
  theme: Props["theme"];
  product?: Props["product"];
}> = ({ scene, theme, product }) => {
  const frame = useCurrentFrame();
  const { fps, width, durationInFrames } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);
  const p = theme.palette!;
  const src = scene.imageUrl || null;
  const caption = sanitizeText(scene.caption);
  const eyebrow = sanitizeText(product?.name);
  const subcap = sanitizeText(product?.tagline);

  const kb = interpolate(frame, [0, durationInFrames], [1.06, 1.2], { extrapolateRight: "clamp" });
  const panX = interpolate(frame, [0, durationInFrames], [-1.6, 1.6], { extrapolateRight: "clamp" });
  const enter = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const sweep = interpolate(frame, [8, 34], [-45, 150], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const reticleIn = spring({ fps, frame: frame - 10 });
  const pulse = 1 + 0.06 * Math.sin(frame * 0.16);

  // HUD corner bracket
  const Bracket: React.FC<{ pos: "tl" | "tr" | "bl" | "br"; d: number }> = ({ pos, d }) => {
    const o = interpolate(spring({ fps, frame: frame - d }), [0, 1], [0, 0.85]);
    const s = 64;
    const b = `4px solid ${p.accent}`;
    const st: React.CSSProperties = { position: "absolute", width: s, height: s, opacity: o };
    if (pos === "tl") Object.assign(st, { top: 26, left: 26, borderTop: b, borderLeft: b, borderTopLeftRadius: 10 });
    if (pos === "tr") Object.assign(st, { top: 26, right: 26, borderTop: b, borderRight: b, borderTopRightRadius: 10 });
    if (pos === "bl") Object.assign(st, { bottom: 26, left: 26, borderBottom: b, borderLeft: b, borderBottomLeftRadius: 10 });
    if (pos === "br") Object.assign(st, { bottom: 26, right: 26, borderBottom: b, borderRight: b, borderBottomRightRadius: 10 });
    return <div style={st} />;
  };

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {src ? (
        <Img src={src} style={{
          width: "100%", height: "100%", objectFit: "cover",
          transform: `scale(${kb}) translateX(${panX}%)`, transformOrigin: "center center", opacity: enter,
        }} />
      ) : (
        <AbsoluteFill style={{ background: `linear-gradient(160deg, ${p.brandA} 0%, ${p.brandB} 100%)`, opacity: enter }} />
      )}

      {/* Color grade brand (kohesi warna) */}
      <AbsoluteFill style={{ background: `linear-gradient(155deg, transparent 0%, ${p.accent}30 100%)`, mixBlendMode: "soft-light", pointerEvents: "none" }} />

      {/* Scrim atas + bawah */}
      <AbsoluteFill style={{ background: `linear-gradient(to top, rgba(0,0,0,0.86) 0%, rgba(0,0,0,0.3) 42%, rgba(0,0,0,0.0) 60%, rgba(0,0,0,0.5) 100%)` }} />

      {/* Light sweep (lewat 1×) */}
      <AbsoluteFill style={{ overflow: "hidden", pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${sweep}%`, width: "28%", background: "linear-gradient(100deg, transparent, rgba(255,255,255,0.28), transparent)", transform: "skewX(-18deg)" }} />
      </AbsoluteFill>

      {/* Product Image Overlay */}
      {product?.image && (
        <div style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          paddingBottom: "15%",
          opacity: spring({ fps, frame: frame - 5 }),
          transform: `scale(${interpolate(spring({ fps, frame: frame - 5 }), [0, 1], [0.85, 1])}) translateY(${interpolate(spring({ fps, frame: frame - 5 }), [0, 1], [50, 0])}px)`
        }}>
          <Img src={product.image} style={{ maxWidth: "75%", maxHeight: "75%", objectFit: "contain", filter: "drop-shadow(0 25px 40px rgba(0,0,0,0.6))" }} />
        </div>
      )}

      {/* dekor aksen melayang */}
      <SceneDecor palette={p} opacity={0.24} />

      {/* HUD corner brackets */}
      <Bracket pos="tl" d={4} /><Bracket pos="tr" d={7} /><Bracket pos="bl" d={10} /><Bracket pos="br" d={13} />

      {/* Reticle / focus (kanan-atas) */}
      <div style={{ position: "absolute", top: "19%", right: "12%", width: 130, height: 130, opacity: reticleIn * 0.9 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `2px dashed ${p.accent}`, transform: `rotate(${frame * 0.7}deg) scale(${pulse})` }} />
        <div style={{ position: "absolute", inset: "26%", borderRadius: "50%", border: `2px solid ${p.accent}`, opacity: 0.7 }} />
        <div style={{ position: "absolute", top: "48%", left: "10%", width: "80%", height: 2, background: p.accent, opacity: 0.6 }} />
        <div style={{ position: "absolute", left: "48%", top: "10%", height: "80%", width: 2, background: p.accent, opacity: 0.6 }} />
      </div>

      {/* Bingkai aksen tipis */}
      <div style={{ position: "absolute", inset: 18, borderRadius: 24, border: `2px solid ${p.accent}`, opacity: 0.4, pointerEvents: "none" }} />

      {/* Eyebrow pill (nama produk) kiri-atas */}
      {eyebrow && (
        <div style={{ position: "absolute", top: 48, left: 40,
          transform: `translateX(${interpolate(spring({ fps, frame: frame - 3 }), [0, 1], [-40, 0])}px)`, opacity: spring({ fps, frame: frame - 3 }) }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, background: p.accent, color: readableTextColor(p.accent, p),
            padding: "10px 18px", borderRadius: 100, fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 22, boxShadow: `0 8px 20px ${p.accent}66` }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: readableTextColor(p.accent, p), opacity: .85 }} />
            {eyebrow}
          </div>
        </div>
      )}

      {/* Caption + subcaption + strip aksen di bawah */}
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", padding: "0 40px 84px" }}>
        {/* strip aksen animasi di atas caption */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, opacity: spring({ fps, frame: frame - 5 }) }}>
          <div style={{ width: interpolate(spring({ fps, frame: frame - 5 }), [0, 1], [0, 54]), height: 6, borderRadius: 3, background: p.accent }} />
          <span style={{ fontFamily: "Inter, sans-serif", fontWeight: 800, fontSize: 16, letterSpacing: 3, color: p.accent, textTransform: "uppercase" }}>Real Moment</span>
        </div>
        {caption && (
          <div style={{ transform: `translateY(${interpolate(spring({ fps, frame: frame - 6 }), [0, 1], [30, 0])}px)`, opacity: spring({ fps, frame: frame - 6 }) }}>
            <KineticText text={caption} maxFontSize={62 * mood.fontScale} maxBoxWidth={width * 0.86} maxLines={2}
              fontFamily="Poppins, sans-serif" fontWeight={900} color="#ffffff" align="left" underline={p.accent}
              style={{ textShadow: "0 8px 30px rgba(0,0,0,0.5)" }} />
          </div>
        )}
        {subcap && (
          <div style={{ marginTop: 14, fontFamily: "Inter, sans-serif", fontWeight: 600, fontSize: 30 * mood.fontScale, color: "#e8eefc",
            opacity: interpolate(spring({ fps, frame: frame - 14 }), [0, 1], [0, 0.92]),
            transform: `translateY(${interpolate(spring({ fps, frame: frame - 14 }), [0, 1], [16, 0])}px)`, textShadow: "0 6px 20px rgba(0,0,0,0.5)" }}>
            {subcap}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
