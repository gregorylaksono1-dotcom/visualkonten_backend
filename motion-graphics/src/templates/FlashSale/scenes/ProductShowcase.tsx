import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FlashSaleProps } from "../schema";
import { anton, poppins } from "../../../shared/fonts";

// Split: kiri panel merah (produk slide-in) + kanan putih (judul, diskon, CTA, deskripsi) — reveal bertahap.
export const ProductShowcase: React.FC<FlashSaleProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { product, sale, cta, theme } = props;

  const sp = (delay: number, cfg = { damping: 200, mass: 0.7 }) =>
    spring({ frame: frame - delay, fps, config: cfg });
  const fade = (a: number, b: number) => interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // produk slide dari kiri + overshoot
  const prod = sp(0, { damping: 14, mass: 1 });
  const prodX = interpolate(prod, [0, 1], [-620, 0]);

  const headline = fade(18, 30);
  const titleS = sp(26);
  const titleX = interpolate(titleS, [0, 1], [80, 0]);
  const subOp = fade(40, 55);
  const bracket = sp(24);
  const discountS = sp(66, { damping: 9, mass: 0.9 });
  const discountScale = interpolate(discountS, [0, 1], [0.3, 1]);
  const priceOp = fade(88, 102);
  const descOp = fade(100, 118);
  const ctaS = sp(112, { damping: 12 });
  const ctaScale = interpolate(ctaS, [0, 1], [0.6, 1]);
  const ctaPulse = 1 + Math.sin(frame / 10) * 0.02;

  const LEFT = "56%";

  return (
    <AbsoluteFill style={{ backgroundColor: theme.paper }}>
      {/* PANEL KANAN (putih) — teks */}
      <AbsoluteFill style={{ left: LEFT, padding: 64, justifyContent: "center" }}>
        <div style={{ position: "relative", display: "inline-block", paddingRight: 8 }}>
          {/* bracket frame [ ] */}
          <div
            style={{
              position: "absolute",
              inset: "-24px -8px -24px -8px",
              border: `6px solid ${theme.paperInk}`,
              opacity: interpolate(bracket, [0, 1], [0, 1]),
              transform: `scaleY(${interpolate(bracket, [0, 1], [0.6, 1])})`,
              borderRadius: 4,
            }}
          />
          <div style={{ position: "relative", transform: `translateX(${titleX}px)` }}>
            <div style={{ fontFamily: anton, color: theme.accent, fontSize: 48, opacity: headline, letterSpacing: 1 }}>
              {sale.headline}
            </div>
            <div style={{ fontFamily: anton, color: theme.paperInk, fontSize: 92, lineHeight: 0.95, opacity: interpolate(titleS, [0, 1], [0, 1]) }}>
              {product.title}
            </div>
            {product.subtitle ? (
              <div style={{ fontFamily: poppins, fontWeight: 800, color: theme.paperInk, fontSize: 34, letterSpacing: 6, opacity: subOp, marginTop: 6 }}>
                {product.subtitle}
              </div>
            ) : null}
          </div>
        </div>

        {/* diskon */}
        <div style={{ marginTop: 60, transform: `scale(${discountScale})`, transformOrigin: "left center" }}>
          <span style={{ fontFamily: anton, color: theme.accent, fontSize: 120, lineHeight: 1 }}>{sale.discount}</span>
        </div>

        {/* harga (opsional) */}
        {(sale.priceOld || sale.priceNew) && (
          <div style={{ opacity: priceOp, marginTop: 8, fontFamily: poppins, fontWeight: 800 }}>
            {sale.priceOld ? (
              <span style={{ color: "#888", fontSize: 36, textDecoration: "line-through", marginRight: 16 }}>{sale.priceOld}</span>
            ) : null}
            {sale.priceNew ? <span style={{ color: theme.paperInk, fontSize: 48 }}>{sale.priceNew}</span> : null}
          </div>
        )}

        {/* deskripsi */}
        {sale.description ? (
          <div style={{ opacity: descOp, marginTop: 24, fontFamily: poppins, color: theme.paperInk, fontSize: 30, lineHeight: 1.35, maxWidth: 420 }}>
            {sale.description}
          </div>
        ) : null}
      </AbsoluteFill>

      {/* PANEL KIRI (merah) — produk */}
      <AbsoluteFill style={{ right: `calc(100% - ${LEFT})`, background: theme.panel, justifyContent: "center", alignItems: "center", overflow: "hidden" }}>
        <div style={{ transform: `translateX(${prodX}px)`, width: "80%", height: "60%", display: "flex", justifyContent: "center", alignItems: "center" }}>
          {product.imageUrl ? (
            <Img
              src={product.imageUrl}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                borderRadius: product.imageIsCutout ? 0 : 28,
                filter: product.imageIsCutout ? "drop-shadow(0 30px 50px rgba(0,0,0,0.45))" : "none",
                boxShadow: product.imageIsCutout ? "none" : "0 30px 60px rgba(0,0,0,0.35)",
              }}
            />
          ) : (
            <div style={{ width: "80%", height: "70%", borderRadius: 28, background: "rgba(255,255,255,0.15)", display: "flex", justifyContent: "center", alignItems: "center", color: theme.onPanel, fontFamily: poppins }}>
              (foto produk)
            </div>
          )}
        </div>

        {/* CTA pill di bawah panel merah */}
        <div style={{ position: "absolute", bottom: 80, transform: `scale(${ctaScale * ctaPulse})` }}>
          <div
            style={{
              background: theme.button,
              color: theme.buttonInk,
              fontFamily: poppins,
              fontWeight: 800,
              fontSize: 38,
              letterSpacing: 2,
              padding: "22px 56px",
              borderRadius: 999,
              boxShadow: "0 16px 30px rgba(0,0,0,0.3)",
            }}
          >
            {cta.text}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
