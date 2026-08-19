import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useVideoConfig, Audio, interpolate } from "remotion";
import { Props, propsSchema } from "./schema";
import { Background } from "./scenes/Background";
import { Particles } from "./particles/Particles";
import { Hook } from "./scenes/Hook";
import { Reveal } from "./scenes/Reveal";
import { Lifestyle } from "./scenes/Lifestyle";
import { Features } from "./scenes/Features";
import { SceneTransition, TransitionType } from "./scenes/SceneTransition";
import { Offer } from "./scenes/Offer";
import { Cta } from "./scenes/Cta";

// Transisi KHAS per jenis scene (tetap variatif karena urutan scene tetap & tiap tipe beda).
const SCENE_TRANSITIONS: Record<string, TransitionType> = {
  hook: "fade",        // buka lembut
  reveal: "zoomIn",    // produk/nama "mendekat"
  lifestyle: "wipe",   // wipe sinematik masuk ke foto
  features: "slideUp", // daftar naik
  offer: "flip",       // harga/penawaran nge-pop
  cta: "zoomOut",      // penutup menyebar
};
// Fallback kalau ada id tak terpetakan.
const FALLBACK_TRANSITIONS: TransitionType[] = ["fade", "slideUp", "zoomIn", "wipe", "slideRight", "flip"];

export const MotionGeneral: React.FC<Props> = (props) => {
  // Validate props at runtime to ensure safety. safeParse → tidak pernah throw;
  // palette SELALU di-resolve (mencegah crash Background/Hook baca theme.palette undefined).
  const safeProps = useMemo(() => {
    const { resolvePalette } = require("./theme");
    const parsed = propsSchema.safeParse(props);
    const data: any = parsed.success ? parsed.data : props;
    if (!parsed.success) console.warn("Props validation failed (fallback)", parsed.error?.issues);
    if (data && data.theme) data.theme.palette = resolvePalette(data.theme);
    return data;
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

      {safeProps.scenes.filter((s) => s.enabled).map((scene, i) => {
        const startFrame = Math.round(scene.start_sec * fps);
        const endFrame = Math.round(scene.end_sec * fps);
        const duration = endFrame - startFrame;

        if (duration <= 0) return null;

        let SceneComponent = null;
        switch (scene.id) {
          case "hook": SceneComponent = Hook; break;
          case "reveal": SceneComponent = Reveal; break;
          case "lifestyle": SceneComponent = Lifestyle; break;
          case "features": SceneComponent = Features; break;
          case "offer": SceneComponent = Offer; break;
          case "cta": SceneComponent = Cta; break;
        }

        if (!SceneComponent) return null;

        // Transisi khas per jenis scene (fallback by-index kalau id tak terpetakan)
        const transType = SCENE_TRANSITIONS[scene.id] ?? FALLBACK_TRANSITIONS[i % FALLBACK_TRANSITIONS.length];

        return (
          <Sequence key={scene.id} from={startFrame} durationInFrames={duration} style={{ zIndex: 2 }}>
            <SceneTransition type={transType} durationInFrames={duration}>
              <SceneComponent scene={scene} theme={safeProps.theme} product={safeProps.product} hero_mode={safeProps.hero_mode} content_type={safeProps.content_type} announcement={safeProps.announcement} accent={safeProps.accent} />
            </SceneTransition>
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
