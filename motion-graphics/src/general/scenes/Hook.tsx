import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, readableTextColor } from "../theme";
import { KineticText } from "./KineticText";
import { SceneDecor } from "./SceneDecor";

export const Hook: React.FC<{ scene: any; theme: Props["theme"] }> = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);
  const p = theme.palette!;

  // Entrance
  const enterSpring = spring({ fps, frame, config: { damping: 14 } });
  const enterY = interpolate(enterSpring, [0, 1], [100, 0]);
  
  // Exit (fade out in last 10 frames)
  // We assume the sequence duration controls when this unmounts, but we can do a fade out
  // Wait, Remotion Sequence will unmount us. It's better to pass duration or just rely on Sequence cut.
  // The prompt says "exit fade di ~8 frame terakhir"
  // So we need durationInFrames as prop to do exit fade. We will get it from context.

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 56 }}>
      <SceneDecor palette={p} />

      {scene.headline && (
        <div style={{ transform: `translateY(${enterY}px)`, opacity: enterSpring, position: "relative", zIndex: 1 }}>
          <KineticText
            text={scene.headline}
            maxFontSize={104 * mood.fontScale}
            maxBoxWidth={width * 0.88}
            maxLines={2}
            fontFamily="Poppins, sans-serif"
            fontWeight={900}
            color={theme.palette.ink}
            underline={theme.palette.accent}
            style={{ textShadow: `0 8px 32px rgba(0,0,0,0.15)` }}
          />
        </div>
      )}
      {scene.sub && (
        <div
          style={{
            marginTop: 44,
            fontFamily: "Inter, sans-serif",
            fontWeight: 700,
            fontSize: 40 * mood.fontScale,
            color: readableTextColor(p.ink, p),
            background: p.ink,
            padding: "12px 28px",
            borderRadius: 100,
            textAlign: "center",
            position: "relative",
            zIndex: 1,
            opacity: spring({ fps, frame: frame - 8, config: { damping: 14 } }),
            transform: `translateY(${interpolate(spring({ fps, frame: frame - 8 }), [0, 1], [40, 0])}px)`,
          }}
        >
          {scene.sub}
        </div>
      )}
    </AbsoluteFill>
  );
};
