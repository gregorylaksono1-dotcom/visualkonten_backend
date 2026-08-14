import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { getGlyphSvg } from "./glyphs";
import { Props } from "../schema";

// Medallion emblem — versi lebih "didesain" (bukan ikon di kotak putih stok):
// core lingkaran ber-gradient brand + glyph putih, 2 arc tipis solid berputar,
// glow lembut, dan 1 dot mengorbit biar hidup. ⛔ tanpa kotak putih & ring putus-putus.
export const Emblem: React.FC<{
  theme: Props["theme"];
  product: Props["product"];
}> = ({ theme, product }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const p = theme.palette!;

  const scale = spring({ fps, frame, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });

  const arc1 = (frame * 1.1) % 360;
  const arc2 = -(frame * 1.7) % 360;
  const orbit = (frame * 2.2) % 360;
  const pulse = 0.85 + 0.15 * Math.sin(frame * 0.12);

  const emblemSize = width * 0.44;
  const isLogo = product.image_subject === "logo" && (product.imageUrl || product.image);

  return (
    <div
      style={{
        position: "relative",
        width: emblemSize,
        height: emblemSize,
        transform: `scale(${scale})`,
        opacity,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Soft outer glow */}
      <div style={{
        position: "absolute", width: "120%", height: "120%", borderRadius: "50%",
        background: `radial-gradient(circle, ${p.accent}55 0%, transparent 65%)`,
        filter: "blur(20px)", opacity: pulse,
      }} />

      {/* Arc 1 — thin solid, gapped */}
      <div style={{
        position: "absolute", width: "104%", height: "104%", borderRadius: "50%",
        border: `2px solid ${p.accent}`,
        borderRightColor: "transparent", borderBottomColor: "transparent",
        transform: `rotate(${arc1}deg)`, opacity: 0.9,
      }} />
      {/* Arc 2 — counter-rotating */}
      <div style={{
        position: "absolute", width: "116%", height: "116%", borderRadius: "50%",
        border: `1.5px solid ${p.ink}`,
        borderTopColor: "transparent", borderLeftColor: "transparent",
        transform: `rotate(${arc2}deg)`, opacity: 0.35,
      }} />

      {/* Orbiting dot */}
      <div style={{ position: "absolute", width: "116%", height: "116%", transform: `rotate(${orbit}deg)` }}>
        <div style={{
          position: "absolute", top: "-2%", left: "50%", width: 12, height: 12, marginLeft: -6,
          borderRadius: "50%", background: p.accent, boxShadow: `0 0 14px ${p.accent}`,
        }} />
      </div>

      {/* Gradient core */}
      <div style={{
        position: "absolute", width: "78%", height: "78%", borderRadius: "50%",
        background: `linear-gradient(145deg, ${p.brandA} 0%, ${p.brandB} 100%)`,
        display: "flex", justifyContent: "center", alignItems: "center",
        boxShadow: `inset 0 2px 20px rgba(255,255,255,0.15), 0 20px 50px rgba(0,0,0,0.45)`,
        border: `1px solid ${p.accent}55`,
      }}>
        <div style={{ width: "46%", height: "46%", display: "flex", justifyContent: "center", alignItems: "center" }}>
          {isLogo ? (
            <img src={product.imageUrl || product.image || ""} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            getGlyphSvg(product.emblem_glyph || "star", "#ffffff")
          )}
        </div>
      </div>
    </div>
  );
};