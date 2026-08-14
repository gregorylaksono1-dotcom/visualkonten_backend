import React from "react";
import { AbsoluteFill, Img, spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, sanitizeText, readableTextColor } from "../theme";
import { Emblem } from "./Emblem";
import { FitText } from "./FitText";

// Momen 1 (padat): hook + reveal digabung — kicker + hero produk/emblem + nama + tagline/date.
export const HeroPunch: React.FC<{
  hook: any;
  reveal: any;
  theme: Props["theme"];
  product: Props["product"];
  hero_mode: Props["hero_mode"];
  content_type?: Props["content_type"];
  announcement?: Props["announcement"];
}> = ({ hook, reveal, theme, product, hero_mode, content_type, announcement }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);
  const p = theme.palette!;

  const isLogo = product.image_subject === "logo";
  const effHero = isLogo ? "emblem" : hero_mode;
  const layout = product.image_layout || "cutout_hero";
  const isBackdrop = effHero === "image" && layout === "backdrop";
  const isAnnouncement = content_type === "announcement";

  const kicker = sanitizeText(hook?.headline);
  const name = sanitizeText(reveal?.product_name || product.name);
  const tagline = sanitizeText(reveal?.tagline || product.tagline);
  const dateHero = sanitizeText(announcement?.date_hero);

  const renderHero = () => {
    if (effHero !== "image") {
      return (
        <div style={{ height: width * 0.42, display: "flex", justifyContent: "center", alignItems: "center" }}>
          <Emblem theme={theme} product={product} />
        </div>
      );
    }
    if (isBackdrop) return null; // backdrop dirender global di Background
    const src = product.imageUrl || product.image || "";
    const spr = spring({ fps, frame, config: { damping: 12 } });
    if (layout === "framed_portrait") {
      return (
        <div style={{
          width: width * 0.58, height: width * 0.58, borderRadius: 28, overflow: "hidden",
          boxShadow: "0 24px 50px rgba(0,0,0,0.5)", border: `2px solid ${p.accent}55`,
          transform: `scale(${interpolate(spr, [0, 1], [0.8, 1])})`,
        }}>
          <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      );
    }
    return (
      <div style={{
        width: width * 0.55, height: width * 0.55, display: "flex", justifyContent: "center", alignItems: "center",
        transform: `translateY(${interpolate(spr, [0, 1], [-60, 0])}px) scale(${interpolate(spr, [0, 1], [0.6, 1])})`,
      }}>
        <Img src={src} style={{
          width: "100%", height: "100%", objectFit: "contain",
          filter: product.image_is_cutout ? "drop-shadow(0 24px 34px rgba(0,0,0,0.45))" : undefined,
          borderRadius: product.image_is_cutout ? 0 : 28,
        }} />
      </div>
    );
  };

  return (
    <AbsoluteFill style={{
      padding: isBackdrop ? "56px 40px 96px 40px" : "56px 40px",
      display: "flex", flexDirection: "column",
      justifyContent: isBackdrop ? "flex-end" : "center", alignItems: "center", gap: 18,
    }}>
      {isAnnouncement && announcement?.ribbon && (
        <div style={{
          background: p.brandB, color: readableTextColor(p.brandB, p), padding: "8px 22px", borderRadius: 8,
          fontFamily: "Poppins, sans-serif", fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", fontSize: 22,
          opacity: spring({ fps, frame: frame - 3 }),
        }}>
          {sanitizeText(announcement.ribbon)}
        </div>
      )}

      {kicker && (
        <div style={{ opacity: spring({ fps, frame }), transform: `translateY(${interpolate(spring({ fps, frame }), [0, 1], [-24, 0])}px)` }}>
          <FitText text={kicker} maxFontSize={56 * mood.fontScale} maxBoxWidth={width * 0.9} maxLines={2}
            fontFamily="Poppins, sans-serif" fontWeight={900}
            style={{ color: isBackdrop ? "#fff" : p.accent, textAlign: "center", lineHeight: 1.05, letterSpacing: 1 }} />
        </div>
      )}

      {renderHero()}

      {name && (
        <div style={{ opacity: spring({ fps, frame: frame - 8 }), transform: `translateY(${interpolate(spring({ fps, frame: frame - 8 }), [0, 1], [20, 0])}px)` }}>
          <FitText text={name} maxFontSize={72 * mood.fontScale} maxBoxWidth={width * 0.9} maxLines={2}
            fontFamily="Poppins, sans-serif" fontWeight={900}
            style={{
              color: effHero === "emblem" ? "transparent" : (isBackdrop ? "#fff" : p.ink),
              backgroundImage: effHero === "emblem" ? `linear-gradient(90deg, ${p.brandA}, ${p.accent}, ${p.brandB})` : undefined,
              backgroundClip: effHero === "emblem" ? "text" : undefined,
              WebkitBackgroundClip: effHero === "emblem" ? "text" : undefined,
              textAlign: "center", lineHeight: 1.05,
            }} />
        </div>
      )}

      {dateHero ? (
        <div style={{ opacity: spring({ fps, frame: frame - 12 }) }}>
          <FitText text={dateHero} maxFontSize={64 * mood.fontScale} maxBoxWidth={width * 0.85} maxLines={1}
            fontFamily="Poppins, sans-serif" fontWeight={900}
            style={{ color: isBackdrop ? "#fff" : p.accent, textAlign: "center", textShadow: `0 8px 24px ${p.accent}55` }} />
        </div>
      ) : tagline ? (
        <div style={{ opacity: spring({ fps, frame: frame - 12 }) }}>
          <FitText text={tagline} maxFontSize={36 * mood.fontScale} maxBoxWidth={width * 0.82} maxLines={1}
            fontFamily="Inter, sans-serif" fontWeight={600}
            style={{
              color: isBackdrop ? "#fff" : readableTextColor(p.ink, p),
              background: isBackdrop ? "rgba(0,0,0,0.3)" : p.ink,
              padding: "10px 26px", borderRadius: 100,
            }} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
