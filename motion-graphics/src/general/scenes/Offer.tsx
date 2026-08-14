import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, readableTextColor } from "../theme";
import { FitText } from "./FitText";

export const Offer: React.FC<{ scene: any; theme: Props["theme"] }> = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 64 }}>
      {scene.badge && (
        <div
          style={{
            fontFamily: "Poppins, sans-serif",
            fontWeight: 800,
            fontSize: 48 * mood.fontScale,
            color: "#fff",
            backgroundColor: theme.palette.accent,
            padding: "16px 40px",
            borderRadius: 100,
            marginBottom: 48,
            boxShadow: `0 12px 32px ${theme.palette.accent}80`,
            transform: `scale(${spring({ fps, frame, config: { damping: 10 } })})`,
          }}
        >
          <FitText
            text={scene.badge}
            maxFontSize={48 * mood.fontScale}
            maxBoxWidth={width * 0.7}
            maxLines={1}
            fontFamily="Poppins, sans-serif"
            fontWeight={800}
            style={{ color: readableTextColor(theme.palette.accent, theme.palette) }}
          />
        </div>
      )}

      {scene.was && (
        <div
          style={{
            fontFamily: "Inter, sans-serif",
            fontWeight: 600,
            fontSize: 48 * mood.fontScale,
            color: theme.palette.ink,
            opacity: interpolate(spring({ fps, frame: frame - 10 }), [0, 1], [0, 0.5]),
            textDecoration: "line-through",
            marginBottom: 16,
            transform: `translateY(${interpolate(spring({ fps, frame: frame - 10 }), [0, 1], [20, 0])}px)`,
          }}
        >
          {scene.was}
        </div>
      )}

      {scene.now && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 16,
            transform: `scale(${spring({ fps, frame: frame - 15, config: { damping: 12 } })})`,
          }}
        >
          <FitText
            text={scene.now}
            maxFontSize={140 * mood.fontScale}
            maxBoxWidth={scene.unit ? width * 0.58 : width * 0.82}
            maxLines={1}
            fontFamily="Poppins, sans-serif"
            fontWeight={900}
            style={{ color: theme.palette.ink, lineHeight: 0.9, textShadow: `0 12px 40px rgba(0,0,0,0.1)` }}
          />
          {scene.unit && (
            <div
              style={{
                fontFamily: "Poppins, sans-serif",
                fontWeight: 800,
                fontSize: 64 * mood.fontScale,
                color: theme.palette.ink,
                paddingBottom: 16,
              }}
            >
              {scene.unit}
            </div>
          )}
        </div>
      )}

      {scene.note && (
        <div
          style={{
            fontFamily: "Inter, sans-serif",
            fontWeight: 500,
            fontSize: 32 * mood.fontScale,
            color: theme.palette.ink,
            opacity: interpolate(spring({ fps, frame: frame - 25 }), [0, 1], [0, 0.7]),
            marginTop: 64,
            textAlign: "center",
          }}
        >
          {scene.note}
        </div>
      )}
    </AbsoluteFill>
  );
};
