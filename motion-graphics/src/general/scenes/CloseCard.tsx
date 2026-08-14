import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, sanitizeText, readableTextColor } from "../theme";
import { getFeatureIcon } from "./icons";
import { FitText } from "./FitText";

// Momen 2 (padat/ramai): features + offer + cta digabung dalam 1 end-card.
export const CloseCard: React.FC<{
  features: any;
  offer: any;
  cta: any;
  theme: Props["theme"];
  product: Props["product"];
  hero_mode: Props["hero_mode"];
  content_type?: Props["content_type"];
  announcement?: Props["announcement"];
}> = ({ features, offer, cta, theme, content_type }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);
  const p = theme.palette!;

  const items = (features?.items || []).map((x: string) => sanitizeText(x)).filter(Boolean);
  const icons = features?.icons || [];
  const offerNow = sanitizeText(offer?.now);
  const offerBadge = sanitizeText(offer?.badge);
  const ctaHeadline = sanitizeText(cta?.headline);
  const ctaButton = sanitizeText(cta?.button);
  const ctaHandle = sanitizeText(cta?.handle);
  const offerOn = !!(offer?.enabled && offerNow);

  const pulse = Math.sin((frame / fps) * 4) * 0.04;

  return (
    <AbsoluteFill style={{ padding: "56px 44px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(ellipse at center, ${p.accent}22 0%, transparent 62%)`,
        pointerEvents: "none", opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" }),
      }} />

      {/* Chips fitur (ramai, wrap) */}
      {items.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14, width: "100%" }}>
          {items.map((it: string, i: number) => {
            const spr = spring({ fps, frame: frame - i * 5, config: { damping: 14 } });
            return (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 12, background: p.ink, borderRadius: 100,
                padding: "12px 22px", boxShadow: "0 8px 20px rgba(0,0,0,0.25)",
                opacity: spr, transform: `scale(${interpolate(spr, [0, 1], [0.8, 1])})`,
              }}>
                <div style={{ width: 26, height: 26 }}>{getFeatureIcon(icons[i] || "sparkle", p.brandA)}</div>
                <span style={{ fontFamily: "Inter, sans-serif", fontWeight: 700, fontSize: 28 * mood.fontScale, color: readableTextColor(p.ink, p) }}>{it}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Offer besar */}
      {offerOn && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, transform: `scale(${spring({ fps, frame: frame - 8, config: { damping: 12 } })})` }}>
          {offerBadge && (
            <div style={{ background: p.accent, color: readableTextColor(p.accent, p), fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 26, padding: "8px 20px", borderRadius: 100 }}>
              {offerBadge}
            </div>
          )}
          <FitText text={offerNow} maxFontSize={110 * mood.fontScale} maxBoxWidth={width * 0.85} maxLines={1}
            fontFamily="Poppins, sans-serif" fontWeight={900} style={{ color: p.ink, lineHeight: 0.95 }} />
        </div>
      )}

      {/* CTA headline (kalau tak ada offer) */}
      {ctaHeadline && !offerOn && (
        <FitText text={ctaHeadline} maxFontSize={66 * mood.fontScale} maxBoxWidth={width * 0.86} maxLines={2}
          fontFamily="Poppins, sans-serif" fontWeight={900} style={{ color: p.ink, textAlign: "center", lineHeight: 1.05 }} />
      )}

      {/* Tombol CTA */}
      {ctaButton && (
        <div style={{
          background: p.accent, borderRadius: 100, padding: "20px 52px", boxShadow: `0 20px 40px ${p.accent}70`,
          transform: `scale(${spring({ fps, frame: frame - 14, config: { damping: 12 } }) + pulse})`,
        }}>
          <FitText text={ctaButton} maxFontSize={44 * mood.fontScale} maxBoxWidth={width * 0.6} maxLines={1}
            fontFamily="Poppins, sans-serif" fontWeight={800} style={{ color: readableTextColor(p.accent, p) }} />
        </div>
      )}

      {ctaHandle && (
        <div style={{ fontFamily: "Inter, sans-serif", fontWeight: 600, fontSize: 32 * mood.fontScale, color: p.ink, opacity: interpolate(spring({ fps, frame: frame - 18 }), [0, 1], [0, 0.85]) }}>
          {ctaHandle}
        </div>
      )}
    </AbsoluteFill>
  );
};
