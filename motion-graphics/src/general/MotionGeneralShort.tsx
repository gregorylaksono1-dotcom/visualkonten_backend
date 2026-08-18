import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useVideoConfig, Audio, interpolate } from "remotion";
import { Props, propsSchema } from "./schema";
import { Background } from "./scenes/Background";
import { Particles } from "./particles/Particles";
import { HeroPunch } from "./scenes/HeroPunch";
import { CloseCard } from "./scenes/CloseCard";
import { SceneTransition } from "./scenes/SceneTransition";

// Versi PADAT dari MotionGeneral: 4-5 scene → 2 momen, tiap momen lebih "ramai",
// durasi lebih pendek (mis. 8-12 detik). Baca props yang SAMA (schema general);
// timing per-scene diabaikan — template membagi durasi jadi 2 bagian.
export const MotionGeneralShort: React.FC<Props> = (props) => {
  const safeProps = useMemo(() => {
    try {
      const parsed = propsSchema.parse(props);
      const { resolvePalette } = require("./theme");
      parsed.theme.palette = resolvePalette(parsed.theme);
      return parsed;
    } catch (e) {
      console.warn("Props validation failed", e);
      return props;
    }
  }, [props]);

  const { fps, durationInFrames } = useVideoConfig();
  const heroFrames = Math.round(durationInFrames * 0.45);
  const closeFrames = durationInFrames - heroFrames;

  const byId = (id: string) => safeProps.scenes.find((s: any) => s.id === id);
  const hook = byId("hook");
  const reveal = byId("reveal");
  const features = byId("features");
  const offer = byId("offer");
  const cta = byId("cta");

  // Lebih "ramai": paksa partikel padat.
  const denseAccent = { ...safeProps.accent, density: "high" as const };
  const burstTriggers = [0, heroFrames]; // burst di awal tiap momen

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <AbsoluteFill style={{ zIndex: 0 }}>
        <Background theme={safeProps.theme} product={safeProps.product} hero_mode={safeProps.hero_mode} />
      </AbsoluteFill>

      <AbsoluteFill style={{ zIndex: 1, pointerEvents: "none" }}>
        <Particles accent={denseAccent} burstTriggers={burstTriggers} featuresRange={[heroFrames, durationInFrames]} />
      </AbsoluteFill>

      <Sequence from={0} durationInFrames={heroFrames} style={{ zIndex: 2 }}>
        <SceneTransition type="zoomIn" durationInFrames={heroFrames}>
          <HeroPunch
            hook={hook}
            reveal={reveal}
            theme={safeProps.theme}
            product={safeProps.product}
            hero_mode={safeProps.hero_mode}
            content_type={safeProps.content_type}
            announcement={safeProps.announcement}
          />
        </SceneTransition>
      </Sequence>

      <Sequence from={heroFrames} durationInFrames={closeFrames} style={{ zIndex: 2 }}>
        <SceneTransition type="slideUp" durationInFrames={closeFrames}>
          <CloseCard
            features={features}
            offer={offer}
            cta={cta}
            theme={safeProps.theme}
            product={safeProps.product}
            hero_mode={safeProps.hero_mode}
            content_type={safeProps.content_type}
            announcement={safeProps.announcement}
          />
        </SceneTransition>
      </Sequence>

      {safeProps.music?.audioUrl && (
        <Audio
          src={safeProps.music.audioUrl}
          loop
          volume={(f) =>
            interpolate(f, [durationInFrames - fps * 1.5, durationInFrames], [1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          }
        />
      )}
    </AbsoluteFill>
  );
};
