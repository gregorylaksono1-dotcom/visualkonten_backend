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
            // bingkai putih → gambar/screenshot tampil UTUH (contain), tidak terpotong
            <div style={{ height: "100%", maxWidth: "92%", background: "#ffffff", padding: 8, borderRadius: 20, overflow: "hidden", boxShadow: `0 12px 28px rgba(0,0,0,0.5)`, border: `2px solid ${p.accent}55` }}>
              <Img src={src} style={{ height: "100%", width: "auto", maxWidth: "100%", objectFit: "contain", borderRadius: 12, display: "block" }} />
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
    <div style={{ display: "flex", flexDirection: "column", gap: asCard ? 0 : 22, width: "100%", alignItems: "stretch" }}>
      {scene.items?.map((raw: string, i: number) => {
        const item = sanitizeText(raw);
        if (!item) return null;
        const iconName = scene.icons?.[i] || "sparkle";
        const spr = spring({ fps, frame: frame - (12 + i * 7), config: { damping: 13 } });
        const idle = Math.sin(frame * 0.07 + i * 1.3) * 4;
        const enterX = interpolate(spr, [0, 1], [i % 2 ? 40 : -40, 0]);

        if (asCard) {
          // ANNOUNCEMENT ticket rows (tetap)
          return (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 20, width: "100%", padding: "22px 6px",
              borderTop: i > 0 ? `2px dashed ${p.brandB}22` : undefined,
              opacity: spr, transform: `translateX(${interpolate(spr, [0, 1], [-24, 0])}px)`,
            }}>
              <div style={{ position: "relative", width: 60, height: 60, flexShrink: 0, borderRadius: 18, background: `${p.brandA}18`, display: "flex", justifyContent: "center", alignItems: "center", transform: `scale(${interpolate(spr, [0, 1], [0, 1])})` }}>
                <div style={{ width: 32, height: 32 }}>{getFeatureIcon(iconName, p.brandA)}</div>
              </div>
              <span style={{ fontFamily: "Inter, sans-serif", fontWeight: 700, fontSize: 36 * mood.fontScale, color: rowColor }}>{item}</span>
            </div>
          );
        }

        // PRODUCT rows — kartu premium: ghost number + icon tile berkilau + shine sweep + accent underline + arrow chip
        const pop = interpolate(spr, [0, 1], [0, 1]);
        const sweep = interpolate(frame - (12 + i * 7), [6, 26], [-40, 150], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div key={i} style={{
            position: "relative",
            alignSelf: i % 2 ? "flex-end" : "flex-start",
            width: "96%",
            display: "flex", alignItems: "center", gap: 20,
            padding: "22px 24px",
            borderRadius: 26,
            background: `linear-gradient(105deg, ${p.accent}30 0%, ${p.accent}12 55%, ${p.accent}00 100%)`,
            border: `1.5px solid ${p.accent}40`,
            borderLeft: `7px solid ${p.accent}`,
            boxShadow: `0 18px 36px rgba(0,0,0,0.36), inset 0 1px 0 ${p.ink}1f`,
            backdropFilter: "blur(6px)",
            overflow: "hidden",
            opacity: spr,
            transform: `translateX(${enterX}px) translateY(${idle}px) rotate(${interpolate(spr, [0, 1], [i % 2 ? 2.5 : -2.5, 0])}deg)`,
          }}>
            {/* ghost index number (besar, mengintip) */}
            <div style={{ position: "absolute", right: 16, bottom: -22, fontFamily: "Poppins, sans-serif", fontWeight: 900,
              fontSize: 122, lineHeight: 1, color: p.accent, opacity: 0.1, pointerEvents: "none" }}>{i + 1}</div>
            {/* shine sweep (lewat 1×) */}
            <div style={{ position: "absolute", top: 0, bottom: 0, left: `${sweep}%`, width: "24%",
              background: `linear-gradient(100deg, transparent, ${p.ink}33, transparent)`, transform: "skewX(-16deg)", pointerEvents: "none" }} />

            {/* icon tile berkilau + glow ring + nomor */}
            <div style={{ position: "relative", width: 78, height: 78, flexShrink: 0, borderRadius: 20,
              background: `linear-gradient(145deg, ${p.accent}, ${p.brandA})`,
              display: "flex", justifyContent: "center", alignItems: "center",
              boxShadow: `0 10px 24px ${p.accent}66, inset 0 2px 5px ${p.ink}55`,
              transform: `scale(${pop}) rotate(${interpolate(spr, [0, 1], [-28, 0])}deg)` }}>
              <div style={{ position: "absolute", inset: -6, borderRadius: 26, border: `2px solid ${p.accent}55`, opacity: 0.7 }} />
              <div style={{ width: 40, height: 40 }}>{getFeatureIcon(iconName, "#ffffff")}</div>
              <div style={{ position: "absolute", top: -10, left: -10, width: 32, height: 32, borderRadius: "50%",
                background: p.ink, color: p.brandB, display: "flex", justifyContent: "center", alignItems: "center",
                fontFamily: "Poppins, sans-serif", fontWeight: 900, fontSize: 17, boxShadow: `0 3px 10px rgba(0,0,0,0.35)` }}>{i + 1}</div>
            </div>

            {/* teks + garis aksen tumbuh di bawahnya */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 9, minWidth: 0 }}>
              <span style={{ fontFamily: "Poppins, sans-serif", fontWeight: 800, fontSize: 38 * mood.fontScale, color: rowColor, lineHeight: 1.05 }}>{item}</span>
              <div style={{ width: interpolate(spr, [0, 1], [0, 64]), height: 4, borderRadius: 2, background: p.accent, opacity: 0.85 }} />
            </div>

            {/* arrow chip bulat */}
            <div style={{ width: 42, height: 42, flexShrink: 0, borderRadius: "50%", background: `${p.accent}22`,
              border: `1.5px solid ${p.accent}66`, display: "flex", justifyContent: "center", alignItems: "center",
              transform: `scale(${pop})` }}>
              <div style={{ width: 12, height: 12, borderTop: `4px solid ${p.accent}`, borderRight: `4px solid ${p.accent}`, transform: "rotate(45deg)", marginLeft: -3 }} />
            </div>
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