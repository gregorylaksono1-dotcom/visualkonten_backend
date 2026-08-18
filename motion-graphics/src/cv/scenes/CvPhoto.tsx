import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { CvPalette } from "../theme";
import { FitText } from "../../general/scenes/FitText";
import { readableTextColor } from "../../general/theme";

// Scene FOTO orang (wajib upload): potret berbingkai + nama + role.
export const CvPhoto: React.FC<{
  palette: CvPalette;
  name: string;
  role: string;
  imageUrl?: string | null;
}> = ({ palette, name, role, imageUrl }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p = palette;
  const enter = spring({ fps, frame, config: { damping: 13 } });

  return (
    <AbsoluteFill style={{ background: p.bg, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: "80px 48px", gap: 34 }}>
      {/* aksen blok di belakang foto */}
      <div style={{ position: "absolute", top: height * 0.16, width: width * 0.62, height: width * 0.62, borderRadius: 32, background: p.accent, transform: `rotate(-4deg) scale(${interpolate(enter, [0, 1], [0.8, 1])})`, opacity: 0.9 }} />

      {/* foto berbingkai */}
      <div style={{
        position: "relative", width: width * 0.6, height: width * 0.72, borderRadius: 28, overflow: "hidden",
        border: `6px solid ${p.text}`, boxShadow: `0 30px 60px rgba(0,0,0,0.45)`,
        transform: `scale(${interpolate(enter, [0, 1], [0.82, 1])}) translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
        opacity: interpolate(enter, [0, 0.5], [0, 1]),
      }}>
        {imageUrl ? (
          <Img src={imageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <AbsoluteFill style={{ background: `linear-gradient(160deg, ${p.accent}, ${p.bg})`, display: "flex", justifyContent: "center", alignItems: "center", color: p.text, fontSize: 40, fontWeight: 800, fontFamily: "Poppins, sans-serif" }}>
            FOTO
          </AbsoluteFill>
        )}
      </div>

      {/* nama + role */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, zIndex: 1,
        opacity: spring({ fps, frame: frame - 10 }), transform: `translateY(${interpolate(spring({ fps, frame: frame - 10 }), [0, 1], [24, 0])}px)` }}>
        <FitText text={name} maxFontSize={72} maxBoxWidth={width * 0.86} maxLines={1}
          fontFamily="Poppins, sans-serif" fontWeight={900} style={{ color: p.text, textAlign: "center" }} />
        <div style={{ display: "inline-block", background: p.accent, color: readableTextColor(p.accent, { brandB: p.bg, ink: p.text } as any),
          padding: "8px 22px", borderRadius: 100, fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 26 }}>
          {role}
        </div>
      </div>
    </AbsoluteFill>
  );
};
