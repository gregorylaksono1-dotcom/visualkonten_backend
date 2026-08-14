import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FlashSaleProps } from "../schema";
import { gradient } from "../../../shared/theme";
import { anton } from "../../../shared/fonts";

// Intro & Outro brand card. Latar gradient, nama brand besar (spring scale + fade).
export const BrandCard: React.FC<FlashSaleProps & { outro?: boolean }> = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { brand, theme } = props;

  const enter = spring({ frame, fps, config: { damping: 200, mass: 0.6 } });
  const scale = interpolate(enter, [0, 1], [0.7, 1]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  // exit fade beberapa frame terakhir (biar transisi mulus)
  const exit = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0.85], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: gradient(theme), justifyContent: "center", alignItems: "center" }}>
      {/* kilau halus diagonal */}
      <AbsoluteFill
        style={{
          background: "linear-gradient(120deg, rgba(255,255,255,0.18), rgba(255,255,255,0) 40%)",
          opacity: 0.9,
        }}
      />
      <div style={{ transform: `scale(${scale})`, opacity: opacity * exit, textAlign: "center" }}>
        {brand.logoUrl ? (
          <Img src={brand.logoUrl} style={{ width: 220, height: 220, objectFit: "contain", marginBottom: 24 }} />
        ) : null}
        <div
          style={{
            fontFamily: anton,
            color: theme.paper,
            fontSize: 150,
            letterSpacing: 2,
            textShadow: "0 10px 30px rgba(0,0,0,0.25)",
            lineHeight: 1,
          }}
        >
          {brand.name}
        </div>
      </div>
    </AbsoluteFill>
  );
};
