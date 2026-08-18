import React from "react";
import { AbsoluteFill, Img, spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, sanitizeText, readableTextColor } from "../theme";
import { Emblem } from "./Emblem";
import { FitText } from "./FitText";
import { SceneDecor } from "./SceneDecor";

export const Reveal: React.FC<{ 
  scene: any; 
  theme: Props["theme"]; 
  product: Props["product"]; 
  hero_mode: Props["hero_mode"];
  content_type?: Props["content_type"];
  announcement?: Props["announcement"];
}> = ({ scene, theme, product, hero_mode, content_type, announcement }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);

  const imgSpring = spring({ fps, frame, config: { damping: 12 } });
  const scale = interpolate(imgSpring, [0, 1], [0.5, 1]);
  const rot = interpolate(imgSpring, [0, 1], [-15, 0]);
  const yOffset = interpolate(imgSpring, [0, 1], [-100, 0]);

  // Halo radial
  const haloOpacity = interpolate(frame, [0, 15], [0, 0.6], { extrapolateRight: "clamp" });

  // Light sweep
  const sweepProgress = interpolate(frame, [10, 30], [-0.5, 1.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const isLogo = product.image_subject === "logo";
  const effectiveHeroMode = isLogo ? "emblem" : hero_mode;
  const layout = product.image_layout || "cutout_hero";

  const renderImageHero = () => {
    const src = product.imageUrl || product.image || "";
    
    if (layout === "backdrop") {
      // Backdrop is now rendered globally in Background.tsx to persist across scenes.
      return null;
    }
    
    if (layout === "framed_portrait") {
      return (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", position: "relative" }}>
          <div
            style={{
              position: "relative",
              width: width * 0.7,
              height: height * 0.45,
              borderRadius: 32,
              overflow: "hidden",
              boxShadow: `0 30px 60px rgba(0,0,0,0.5)`,
              transform: `scale(${interpolate(imgSpring, [0, 1], [0.8, 1])})`,
              opacity: interpolate(imgSpring, [0, 0.5], [0, 1]),
            }}
          >
            <Img
              src={src}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </div>
        </div>
      );
    }

    // Default cutout_hero
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", position: "relative" }}>
        {/* Halo */}
        <div
          style={{
            position: "absolute",
            width: width * 0.8,
            height: width * 0.8,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${theme.palette.accent} 0%, transparent 70%)`,
            opacity: haloOpacity,
            mixBlendMode: "screen",
            transform: `scale(${imgSpring})`,
          }}
        />

        {/* Product Image */}
        <div
          style={{
            position: "relative",
            width: width * 0.62,
            height: width * 0.62,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            transform: `translateY(${yOffset}px) scale(${scale}) rotate(${rot}deg)`,
          }}
        >
          <Img
            src={src}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              filter: product.image_is_cutout ? `drop-shadow(0 30px 40px rgba(0,0,0,0.4))` : undefined,
              borderRadius: product.image_is_cutout ? 0 : 32,
            }}
          />
          {/* Light Sweep */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              overflow: "hidden",
              borderRadius: product.image_is_cutout ? 0 : 32,
              maskImage: product.image_is_cutout ? `url(${src})` : undefined,
              maskSize: "contain",
              maskRepeat: "no-repeat",
              maskPosition: "center",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                width: "150%",
                background: `linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)`,
                transform: `translateX(${sweepProgress * 100}%) skewX(-20deg)`,
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  const isBackdrop = effectiveHeroMode === "image" && layout === "backdrop";

  return (
    <AbsoluteFill style={{ 
      padding: isBackdrop ? "64px 32px 120px 32px" : "64px 32px", 
      display: "flex", 
      flexDirection: "column", 
      justifyContent: isBackdrop ? "flex-end" : "center", 
      alignItems: "center", 
      gap: 40
    }}>
      {!isBackdrop && <SceneDecor palette={theme.palette!} />}
      {effectiveHeroMode === "image" && renderImageHero()}

      {effectiveHeroMode === "emblem" && (
        <div style={{ 
          transform: content_type === "announcement" ? "scale(0.8)" : "scale(1)", 
          transition: "transform 0.5s",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: width * 0.45,
          zIndex: 1,
        }}>
          <Emblem theme={theme} product={product} />
        </div>
      )}

      {/* Texts */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, position: "relative", zIndex: 2 }}>
        
        {/* Ribbon for announcement */}
        {content_type === "announcement" && announcement?.ribbon && (
          <div style={{
            position: "absolute",
            top: -20,
            background: theme.palette.brandB,
            color: theme.palette.ink,
            padding: "8px 24px",
            fontSize: 24,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: 2,
            borderRadius: 8,
            boxShadow: `0 10px 20px rgba(0,0,0,0.2)`,
            transform: `translateY(${interpolate(spring({ fps, frame: frame - 10 }), [0, 1], [-20, 0])}px)`,
            opacity: spring({ fps, frame: frame - 10 }),
            zIndex: 1,
          }}>
            {sanitizeText(announcement.ribbon)}
          </div>
        )}

        {scene.product_name && (
          <div
            style={{
              opacity: spring({ fps, frame: frame - 15 }),
              transform: `translateY(${interpolate(spring({ fps, frame: frame - 15 }), [0, 1], [30, 0])}px)`,
              zIndex: 2,
            }}
          >
            <FitText
              text={sanitizeText(scene.product_name)}
              maxFontSize={(content_type === "announcement" ? 84 : 72) * mood.fontScale}
              maxBoxWidth={width * 0.9}
              maxLines={2}
              fontFamily="Poppins, sans-serif"
              fontWeight={900}
              style={{
                color: effectiveHeroMode === "emblem" ? "transparent" : (isBackdrop ? "#fff" : theme.palette.ink),
                backgroundImage: effectiveHeroMode === "emblem" ? `linear-gradient(90deg, ${theme.palette.brandA}, ${theme.palette.accent}, ${theme.palette.brandB})` : undefined,
                backgroundSize: "200% auto",
                backgroundClip: effectiveHeroMode === "emblem" ? "text" : undefined,
                WebkitBackgroundClip: effectiveHeroMode === "emblem" ? "text" : undefined,
                backgroundPosition: `${(frame * 2) % 200}% center`,
                textAlign: "center",
                lineHeight: 1.1,
              }}
            />
          </div>
        )}
        
        {scene.tagline && (
          <div
            style={{
              fontFamily: "Inter, sans-serif",
              fontWeight: 600,
              fontSize: 40 * mood.fontScale,
              color: isBackdrop ? "#fff" : readableTextColor(theme.palette.ink, theme.palette),
              textAlign: "center",
              padding: "12px 32px",
              background: isBackdrop ? "rgba(0,0,0,0.3)" : theme.palette.ink,
              backdropFilter: isBackdrop ? "blur(10px)" : undefined,
              borderRadius: 100,
              opacity: spring({ fps, frame: frame - 20 }),
              transform: `scale(${spring({ fps, frame: frame - 20 })})`,
              zIndex: 3,
            }}
          >
            {sanitizeText(scene.tagline)}
          </div>
        )}

        {/* Date Hero for announcement */}
        {content_type === "announcement" && announcement?.date_hero && (
          <div
            style={{
              marginTop: 24,
              opacity: spring({ fps, frame: frame - 25 }),
              transform: `scale(${interpolate(spring({ fps, frame: frame - 25 }), [0, 1], [0.8, 1])})`,
              zIndex: 3,
            }}
          >
            <FitText
              text={sanitizeText(announcement.date_hero)}
              maxFontSize={96 * mood.fontScale}
              maxBoxWidth={width * 0.9}
              maxLines={2}
              fontFamily="Poppins, sans-serif"
              fontWeight={900}
              style={{ color: isBackdrop ? "#fff" : theme.palette.ink, textAlign: "center", lineHeight: 1, textShadow: `0 10px 30px ${theme.palette.accent}80` }}
            />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
