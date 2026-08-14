import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useVideoConfig, Audio, interpolate } from "remotion";
import { Props, propsSchema } from "./schema";
import { Background } from "./scenes/Background";
import { Particles } from "./particles/Particles";
import { Hook } from "./scenes/Hook";
import { Reveal } from "./scenes/Reveal";
import { Features } from "./scenes/Features";
import { Offer } from "./scenes/Offer";
import { Cta } from "./scenes/Cta";

export const MotionGeneral: React.FC<Props> = (props) => {
  // Validate props at runtime to ensure safety
  const safeProps = useMemo(() => {
    try {
      const parsed = propsSchema.parse(props);
      const { resolvePalette } = require("./theme");
      parsed.theme.palette = resolvePalette(parsed.theme);
      return parsed;
    } catch (e) {
      console.warn("Props validation failed", e);
      return props; // fallback to raw props if validation fails but try to continue
    }
  }, [props]);

  const { fps, durationInFrames } = useVideoConfig();

  // Pre-calculate burst triggers and features range for Particles engine
  const { burstTriggers, featuresRange } = useMemo(() => {
    const triggers: number[] = [];
    let fRange: [number, number] = [-1, -1];

    safeProps.scenes.forEach(s => {
      if (s.enabled) {
        if (s.id === "reveal" || s.id === "offer" || s.id === "cta") {
          triggers.push(Math.round(s.start_sec * fps));
        }
        if (s.id === "features") {
          fRange = [Math.round(s.start_sec * fps), Math.round(s.end_sec * fps)];
        }
      }
    });
    return { burstTriggers: triggers, featuresRange: fRange };
  }, [safeProps.scenes, fps]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <AbsoluteFill style={{ zIndex: 0 }}>
        <Background theme={safeProps.theme} product={safeProps.product} hero_mode={safeProps.hero_mode} />
      </AbsoluteFill>
      
      <AbsoluteFill style={{ zIndex: 1, pointerEvents: "none" }}>
        <Particles accent={safeProps.accent} burstTriggers={burstTriggers} featuresRange={featuresRange} />
      </AbsoluteFill>

      {safeProps.scenes.map((scene) => {
        if (!scene.enabled) return null;
        
        const startFrame = Math.round(scene.start_sec * fps);
        const endFrame = Math.round(scene.end_sec * fps);
        const duration = endFrame - startFrame;

        if (duration <= 0) return null;

        let SceneComponent = null;
        switch (scene.id) {
          case "hook": SceneComponent = Hook; break;
          case "reveal": SceneComponent = Reveal; break;
          case "features": SceneComponent = Features; break;
          case "offer": SceneComponent = Offer; break;
          case "cta": SceneComponent = Cta; break;
        }

        if (!SceneComponent) return null;

        return (
          <Sequence key={scene.id} from={startFrame} durationInFrames={duration} style={{ zIndex: 2 }}>
            <SceneComponent scene={scene} theme={safeProps.theme} product={safeProps.product} hero_mode={safeProps.hero_mode} content_type={safeProps.content_type} announcement={safeProps.announcement} accent={safeProps.accent} />
          </Sequence>
        );
      })}

      {safeProps.music?.audioUrl && (
        <Audio 
          src={safeProps.music.audioUrl} 
          loop 
          volume={(f) =>
            interpolate(f, [durationInFrames - (fps * 2), durationInFrames], [1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          }
        />
      )}
    </AbsoluteFill>
  );
};
