import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig, interpolate, Img } from "remotion";
import { Props } from "../schema";
import { getMoodConfig, sanitizeText, readableTextColor } from "../theme";
import { getFeatureIcon } from "./icons";
import { Emblem } from "./Emblem";
import { FitText } from "./FitText";

export const Features: React.FC<{
  scene: any;
  theme: Props["theme"];
  product: Props["product"];
  hero_mode: Props["hero_mode"];
  content_type?: Props["content_type"];
  announcement?: Props["announcement"];
}> = ({ scene, theme, product, hero_mode, content_type, announcement }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const mood = getMoodConfig(theme.mood);
  const p = theme.palette!;
  const isAnnouncement = content_type === "announcement";
  const isLogo = product.image_subject === "logo";
  const effectiveHeroMode = isLogo ? "emblem" : hero_mode;
  const layout = product.image_layout || "cutout_hero";
  const dateHero = sanitizeText(announcement?.date_hero);

  // ---------- PRODUCT anchor (foto/emblem kecil) ----------
  const renderAnchor = () => {
    if (!scene.show_product) return null;
    const src = product.imageUrl || product.image || "";
    const enter = spring({ fps, frame, config: { damping: 14 } });
    return (
      <div style={{
        height: "22%", width: "100%", display: "flex", justifyContent: "center", alignItems: "center",
        marginBottom: 20, opacity: enter, transform: `translateY(${interpolate(enter, [0, 1], [-40, 0])}px)`,
      }}>
        {effectiveHeroMode === "image" && src ? (
          layout === "backdrop" || layout === "framed_portrait" ? (
            <div style={{ height: "100%", aspectRatio: "1/1", borderRadius: 24, overflow: "hidden", boxShadow: `0 12px 28px rgba(0,0,0,0.5)`, border: `2px solid ${p.accent}55` }}>
              <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          ) : (
            <Img src={src} style={{ height: "100%", objectFit: "contain", filter: product.image_is_cutout ? `drop-shadow(0 18px 28px rgba(0,0,0,0.5))` : undefined, borderRadius: product.image_is_cutout ? 0 : 24 }} />
          )
        ) : (
          <div style={{ position: "relative", width: "100%", height: "100%", transform: "scale(0.45)" }}>
            <Emblem theme={theme} product={product} />
          </div>
        )}
      </div>
    );
  };

  // ---------- DATE HERO (announcement) — tanggal jadi grafik dominan ----------
  const renderDateHero = () => {
    if (!isAnnouncement || !dateHero) return null;
    const enter = spring({ fps, frame: frame - 4, config: { damping: 13 } });
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 28,
        opacity: enter, transform: `translateY(${interpolate(enter, [0, 1], [24, 0])}px)`,
      }}>
        <div style={{ fontFamily: "Inter, sans-serif", fontWeight: 700, fontSize: 22, letterSpacing: 6, color: p.accent, textTransform: "uppercase", marginBottom: 8 }}>
          {sanitizeText(scene.heading) || "Catat Tanggalnya"}
        </div>
        <FitText
          text={dateHero}
          maxFontSize={92 * mood.fontScale}
          maxBoxWidth={width * 0.86}
          maxLines={2}
          fontFamily="Poppins, sans-serif"
          fontWeight={900}
          style={{ color: "#fff", textAlign: "center", lineHeight: 0.95, textShadow: `0 12px 34px ${p.accent}66` }}
        />
        <div style={{ width: 90, height: 5, borderRadius: 3, background: p.accent, marginTop: 16 }} />
      </div>
    );
  };

  // ---------- ROWS ----------
  // teks di kartu terang (announcement) → warna paling kontras dari palet; di gelap → ink terang
  const rowColor = isAnnouncement ? readableTextColor(p.ink, p) : p.ink;
  const renderRows = (asCard: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", gap: asCard ? 0 : 22, width: "100%" }}>
      {scene.items?.map((raw: string, i: number) => {
        const item = sanitizeText(raw);
        if (!item) return null;
        const iconName = scene.icons?.[i] || "sparkle";
        const spr = spring({ fps, frame: frame - (12 + i * 8), config: { damping: 14 } });
        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 20, width: "100%",
            padding: asCard ? "22px 6px" : "18px 28px",
            borderTop: asCard && i > 0 ? `2px dashed ${p.brandB}22` : undefined,
            background: asCard ? "transparent" : `linear-gradient(90deg, ${p.accent}14, ${p.accent}08)`,
            border: asCard ? undefined : `1px solid ${p.accent}33`,
            borderRadius: asCard ? 0 : 18,
            opacity: spr, transform: `translateX(${interpolate(spr, [0, 1], [-24, 0])}px)`,
          }}>
            {/* icon in accent chip */}
            <div style={{
              width: 56, height: 56, flexShrink: 0, borderRadius: 16,
              background: asCard ? `${p.brandA}18` : `${p.accent}22`,
              display: "flex", justifyContent: "center", alignItems: "center",
              transform: `scale(${interpolate(spr, [0, 1], [0, 1])})`,
            }}>
              <div style={{ width: 30, height: 30 }}>{getFeatureIcon(iconName, asCard ? p.brandA : p.accent)}</div>
            </div>
            <span style={{ fontFamily: "Inter, sans-serif", fontWeight: 700, fontSize: 36 * mood.fontScale, color: rowColor }}>
              {item}
            </span>
          </div>
        );
      })}
    </div>
  );

  // ---------- HEADING (product only; announcement heading dipakai di date-hero) ----------
  const renderHeading = () => {
    const text = sanitizeText(scene.heading || scene.headline);
    if (!text || isAnnouncement) return null;
    const spr = spring({ fps, frame: frame - 5 });
    return (
      <div style={{
        fontFamily: "Poppins, sans-serif", fontWeight: 800,
        fontSize: (scene.heading ? 40 : 60) * mood.fontScale,
        color: p.accent, letterSpacing: scene.heading ? 4 : 0,
        textTransform: scene.heading ? "uppercase" : "none",
        marginBottom: 28, textAlign: "center",
        opacity: spr, transform: `translateY(${interpolate(spr, [0, 1], [-24, 0])}px)`,
      }}>
        {text}
      </div>
    );
  };

  const cardEnter = spring({ fps, frame: frame - 8, config: { damping: 15 } });

  return (
    <AbsoluteFill style={{ padding: "72px 44px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      {/* Backing glow */}
      <div style={{
        position: "absolute", bottom: "-15%", left: "-25%", width: "150%", height: "90%",
        background: `radial-gradient(ellipse at center, ${p.accent}22 0%, transparent 60%)`,
        pointerEvents: "none", opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" }),
      }} />

      {renderAnchor()}
      {renderDateHero()}

      {isAnnouncement ? (
        // TICKET editorial: strip aksen atas + notch + rows
        <div style={{
          position: "relative", width: "100%", background: p.ink, borderRadius: 28,
          boxShadow: `0 24px 50px rgba(0,0,0,0.35)`, overflow: "hidden",
          opacity: cardEnter, transform: `translateY(${interpolate(cardEnter, [0, 1], [40, 0])}px)`,
        }}>
          {/* accent strip */}
          <div style={{ height: 10, width: "100%", background: `linear-gradient(90deg, ${p.brandA}, ${p.accent})` }} />
          {/* perforation notches */}
          <div style={{ position: "absolute", top: "50%", left: -18, width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.45)", transform: "translateY(-50%)" }} />
          <div style={{ position: "absolute", top: "50%", right: -18, width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.45)", transform: "translateY(-50%)" }} />
          <div style={{ padding: "16px 36px 30px 36px" }}>
            {renderRows(true)}
          </div>
        </div>
      ) : (
        <>
          {renderHeading()}
          {renderRows(false)}
        </>
      )}
    </AbsoluteFill>
  );
};