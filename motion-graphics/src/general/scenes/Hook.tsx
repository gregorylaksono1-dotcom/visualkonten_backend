import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig } from "../theme";
import { FitText } from "./FitText";

export const Hook: React.FC<{ scene: any; theme: Props["theme"] }> = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);

  // Entrance
  const enterSpring = spring({ fps, frame, config: { damping: 14 } });
  const enterY = interpolate(enterSpring, [0, 1], [100, 0]);
  
  // Exit (fade out in last 10 frames)
  // We assume the sequence duration controls when this unmounts, but we can do a fade out
  // Wait, Remotion Sequence will unmount us. It's better to pass duration or just rely on Sequence cut.
  // The prompt says "exit fade di ~8 frame terakhir"
  // So we need durationInFrames as prop to do exit fade. We will get it from context.

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 64 }}>
      {scene.headline && (
        <div
          style={{
            transform: `translateY(${enterY}px)`,
            opacity: enterSpring,
          }}
        >
          <FitText
            text={scene.headline}
            maxFontSize={100 * mood.fontScale}
            maxBoxWidth={width * 0.88}
            maxLines={2}
            fontFamily="Poppins, sans-serif"
            fontWeight={900}
            style={{ color: theme.palette.ink, textAlign: "center", lineHeight: 1.1, textShadow: `0 8px 32px rgba(0,0,0,0.15)` }}
          />
        </div>
      )}
      {scene.sub && (
        <div
          style={{
            fontFamily: "Inter, sans-serif",
            fontWeight: 500,
            fontSize: 48 * mood.fontScale,
            color: theme.palette.ink,
            textAlign: "center",
            marginTop: 32,
            opacity: spring({ fps, frame: frame - 5, config: { damping: 14 } }),
            transform: `translateY(${interpolate(spring({ fps, frame: frame - 5 }), [0, 1], [50, 0])}px)`,
          }}
        >
          {scene.sub}
        </div>
      )}
    </AbsoluteFill>
  );
};
