import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FlashSaleProps } from "../schema";
import { gradient } from "../../../shared/theme";
import { anton } from "../../../shared/fonts";

// Tag lingkaran bergantung di tali, drop-in + swing (goyang) halus.
export const SaleBadge: React.FC<FlashSaleProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { sale, theme } = props;

  const drop = spring({ frame, fps, config: { damping: 12, mass: 1.2 } }); // sedikit mantul
  const dropY = interpolate(drop, [0, 1], [-500, 0]);
  // swing: rotasi meredam mengikuti sinus
  const swing = Math.sin(frame / 7) * interpolate(frame, [0, 40, 120], [0, 8, 2], { extrapolateRight: "clamp" });
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: gradient(theme), justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          transform: `translateY(${dropY}px) rotate(${swing}deg)`,
          transformOrigin: "top center",
          opacity,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        {/* tali */}
        <div style={{ width: 6, height: 260, background: "rgba(0,0,0,0.55)" }} />
        {/* badge */}
        <div
          style={{
            width: 520,
            height: 520,
            borderRadius: "50%",
            background: theme.ink,
            marginTop: -6,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            boxShadow: "0 30px 60px rgba(0,0,0,0.3)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* pita aksen */}
          <div
            style={{
              position: "absolute",
              bottom: 150,
              left: -20,
              right: -20,
              height: 120,
              background: theme.accent,
              transform: "rotate(-8deg)",
            }}
          />
          <div style={{ position: "relative", textAlign: "center", transform: "rotate(-6deg)" }}>
            <div style={{ fontFamily: anton, color: theme.paper, fontSize: 84, lineHeight: 0.95 }}>
              {sale.badgeText}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
