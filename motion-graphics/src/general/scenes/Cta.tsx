import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, readableTextColor } from "../theme";
import { FitText } from "./FitText";

export const Cta: React.FC<{ scene: any; theme: Props["theme"] }> = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);

  // Button pulse loop
  const pulse = Math.sin((frame / fps) * 4) * 0.05;

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 64 }}>
      {scene.headline && (
        <div
          style={{
            marginBottom: 64,
            transform: `translateY(${interpolate(spring({ fps, frame }), [0, 1], [50, 0])}px)`,
            opacity: spring({ fps, frame }),
          }}
        >
          <FitText
            text={scene.headline}
            maxFontSize={80 * mood.fontScale}
            maxBoxWidth={width * 0.86}
            maxLines={2}
            fontFamily="Poppins, sans-serif"
            fontWeight={900}
            style={{ color: theme.palette.ink, textAlign: "center", lineHeight: 1.1 }}
          />
        </div>
      )}

      {scene.button && (
        <div
          style={{
            fontFamily: "Poppins, sans-serif",
            fontWeight: 800,
            fontSize: 56 * mood.fontScale,
            color: theme.palette.ink,
            backgroundColor: theme.palette.accent,
            padding: "24px 64px",
            borderRadius: 100,
            boxShadow: `0 24px 48px ${theme.palette.accent}80`,
            transform: `scale(${spring({ fps, frame: frame - 10, config: { damping: 12 } }) + pulse})`,
            marginBottom: 48,
          }}
        >
          <FitText
            text={scene.button}
            maxFontSize={56 * mood.fontScale}
            maxBoxWidth={width * 0.66}
            maxLines={1}
            fontFamily="Poppins, sans-serif"
            fontWeight={800}
            style={{ color: readableTextColor(theme.palette.accent, theme.palette) }}
          />
        </div>
      )}

      {scene.handle && (
        <div
          style={{
            fontFamily: "Inter, sans-serif",
            fontWeight: 600,
            fontSize: 40 * mood.fontScale,
            color: theme.palette.ink,
            opacity: interpolate(spring({ fps, frame: frame - 20 }), [0, 1], [0, 0.8]),
          }}
        >
          {scene.handle}
        </div>
      )}
    </AbsoluteFill>
  );
};
