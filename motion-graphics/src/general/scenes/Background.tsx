import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, Img, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig } from "../theme";

export const Background: React.FC<{ 
  theme: Props["theme"];
  product: Props["product"];
  hero_mode: Props["hero_mode"];
}> = ({ theme, product, hero_mode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);

  const t = (frame / fps) * mood.speedMultiplier;
  
  const isLogo = product.image_subject === "logo";
  const effectiveHeroMode = isLogo ? "emblem" : hero_mode;
  const layout = product.image_layout || "cutout_hero";
  const isBackdrop = effectiveHeroMode === "image" && layout === "backdrop";
  const palette = theme.palette!;
  const style = theme.bg_style || "aurora";

  const renderStyle = () => {
    switch (style) {
      case "mesh":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, ${palette.brandB} 0%, ${palette.ink} 100%)` }} />
            <div style={{ position: "absolute", top: "-20%", left: "-10%", width: "70%", height: "70%", background: `radial-gradient(circle, ${palette.brandA} 0%, transparent 70%)`, opacity: 0.6, mixBlendMode: "overlay", transform: `translate(${Math.sin(t)*30}px, ${Math.cos(t)*30}px)` }} />
            <div style={{ position: "absolute", bottom: "-10%", right: "-20%", width: "80%", height: "80%", background: `radial-gradient(circle, ${palette.accent} 0%, transparent 70%)`, opacity: 0.5, mixBlendMode: "overlay", transform: `translate(${Math.cos(t*1.5)*40}px, ${Math.sin(t*1.2)*40}px)` }} />
          </>
        );
      case "spotlight":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: palette.brandB }} />
            <div style={{ position: "absolute", top: "-50%", left: "50%", width: "200%", height: "150%", background: `radial-gradient(circle at 50% 50%, ${palette.brandA} 0%, transparent 60%)`, opacity: 0.8, transform: `translate(-50%, ${Math.sin(t*0.5)*10}%)` }} />
          </>
        );
      case "bokeh_night":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: palette.brandB }} />
            {[...Array(8)].map((_, i) => (
              <div key={i} style={{
                position: "absolute",
                top: `${20 + (i * 17) % 60}%`,
                left: `${10 + (i * 23) % 80}%`,
                width: 200 + (i * 50) % 200,
                height: 200 + (i * 50) % 200,
                borderRadius: "50%",
                background: `radial-gradient(circle, ${i % 2 === 0 ? palette.accent : palette.brandA} 0%, transparent 70%)`,
                opacity: 0.4,
                mixBlendMode: "screen",
                transform: `translate(${Math.sin(t + i)*30}px, ${Math.cos(t + i)*30}px)`,
                filter: "blur(40px)"
              }} />
            ))}
          </>
        );
      case "waves":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: palette.brandB }} />
            {[...Array(3)].map((_, i) => (
              <div key={i} style={{
                position: "absolute",
                bottom: `${-30 + i * 10}%`,
                left: "-50%",
                width: "200%",
                height: "80%",
                background: i === 0 ? palette.brandA : i === 1 ? palette.accent : palette.ink,
                opacity: 0.2 + i * 0.1,
                borderRadius: "40%",
                transform: `rotate(${t * (10 + i * 5)}deg) translateY(${Math.sin(t)*20}px)`,
                transformOrigin: "center center"
              }} />
            ))}
          </>
        );
      case "radial_burst":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: palette.brandB }} />
            <div style={{
              position: "absolute",
              inset: "-50%",
              background: `repeating-conic-gradient(from 0deg, ${palette.brandA} 0deg 10deg, transparent 10deg 20deg)`,
              opacity: 0.15,
              transform: `rotate(${t * 10}deg)`,
            }} />
          </>
        );
      case "geometric":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: palette.brandB }} />
            <div style={{ position: "absolute", top: "10%", left: "10%", width: 300, height: 300, border: `20px solid ${palette.brandA}`, opacity: 0.1, transform: `rotate(${t * 15}deg)` }} />
            <div style={{ position: "absolute", bottom: "10%", right: "10%", width: 400, height: 400, borderRadius: "50%", border: `30px solid ${palette.accent}`, opacity: 0.1, transform: `scale(${1 + Math.sin(t)*0.1})` }} />
            <div style={{ position: "absolute", top: "40%", right: "20%", width: 200, height: 200, background: palette.ink, opacity: 0.05, transform: `rotate(${-t * 10}deg)` }} />
          </>
        );
      case "duotone":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: `linear-gradient(45deg, ${palette.brandA} 0%, ${palette.brandB} 100%)` }} />
            <div style={{
              position: "absolute",
              inset: 0,
              backgroundSize: "4px 4px",
              backgroundImage: `radial-gradient(${palette.accent} 1px, transparent 1px)`,
              opacity: 0.15,
            }} />
          </>
        );
      case "starfield":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: palette.brandB }} />
            {[...Array(40)].map((_, i) => (
              <div key={i} style={{
                position: "absolute",
                top: `${(i * 13) % 100}%`,
                left: `${(i * 27) % 100}%`,
                width: i % 3 === 0 ? 4 : 2,
                height: i % 3 === 0 ? 4 : 2,
                borderRadius: "50%",
                background: palette.ink,
                opacity: 0.3 + Math.sin(t * 3 + i) * 0.3,
                transform: `translateY(${(frame * (i % 3 + 1)) % 1000}px)`,
              }} />
            ))}
          </>
        );
      case "confetti_field":
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: palette.brandB }} />
            {[...Array(30)].map((_, i) => (
              <div key={i} style={{
                position: "absolute",
                top: `${(i * 17) % 100}%`,
                left: `${(i * 31) % 100}%`,
                width: 15,
                height: 15,
                background: i % 2 === 0 ? palette.brandA : palette.accent,
                opacity: 0.2,
                transform: `rotate(${i * 15 + t * 20}deg)`,
              }} />
            ))}
          </>
        );
      case "aurora":
      default:
        return (
          <>
            <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, ${palette.brandA} 0%, ${palette.brandB} 100%)` }} />
            <div style={{
              position: "absolute", width: "140%", height: "140%", top: "-20%", left: "-20%",
              background: `radial-gradient(ellipse at ${50 + Math.sin(t * 0.3) * 20}% ${50 + Math.cos(t * 0.4) * 30}%, ${palette.accent} 0%, transparent 60%)`,
              opacity: mood.glowOpacity * 1.5, mixBlendMode: "screen", filter: "blur(80px)"
            }} />
            <div style={{
              position: "absolute", width: "150%", height: "150%", top: "-25%", left: "-25%",
              background: `radial-gradient(circle at ${40 + Math.cos(t * 0.5) * 30}% ${60 + Math.sin(t * 0.2) * 40}%, ${palette.brandA} 0%, transparent 60%)`,
              opacity: mood.glowOpacity * 1.2, mixBlendMode: "screen", filter: "blur(100px)"
            }} />
          </>
        );
    }
  };

  return (
    <AbsoluteFill style={{ backgroundColor: palette.brandB }}>
      {/* SVG Noise Filter Definition */}
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id="noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="3" stitchTiles="stitch" />
        </filter>
      </svg>

      {renderStyle()}

      {/* Persistent Backdrop Photo */}
      {isBackdrop && (product.imageUrl || product.image) && (
        <AbsoluteFill style={{ zIndex: 1 }}>
          <Img 
            src={product.imageUrl || product.image || ""} 
            style={{ 
              width: "100%", 
              height: "100%", 
              objectFit: "cover",
              transform: `scale(${interpolate(frame, [0, 300], [1, 1.15], { extrapolateRight: "clamp" })})`,
              transformOrigin: "center top",
            }} 
          />
          {/* Gradient Scrim */}
          <div style={{
            position: "absolute",
            inset: 0,
            background: `linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.6) 40%, rgba(0,0,0,0.2) 100%)`,
          }} />
        </AbsoluteFill>
      )}

      {/* Radial Vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at center, transparent 30%, rgba(0,0,0,0.5) 100%)`,
          pointerEvents: "none",
          zIndex: 2,
        }}
      />

      {/* Grain / Noise Overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.04,
          filter: "url(#noise)",
          pointerEvents: "none",
          mixBlendMode: "overlay",
          zIndex: 3,
        }}
      />
    </AbsoluteFill>
  );
};
