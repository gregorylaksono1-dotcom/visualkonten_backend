import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { fitTextOnNLines } from "@remotion/layout-utils";

// Tipografi kinetik: teks masuk KATA-PER-KATA (stagger), auto-fit ukuran,
// + opsi garis aksen yang "menyapu" masuk di bawah teks. Bikin headline
// terasa didesain, bukan teks statis standar.
export const KineticText: React.FC<{
  text: string;
  maxFontSize: number;
  maxBoxWidth: number;
  maxLines?: number;
  fontFamily: string;
  fontWeight?: number | string;
  color?: string;
  align?: "center" | "left";
  startFrame?: number;
  underline?: string; // warna garis aksen (opsional)
  letterSpacing?: number;
  style?: React.CSSProperties;
}> = ({
  text,
  maxFontSize,
  maxBoxWidth,
  maxLines = 2,
  fontFamily,
  fontWeight = 900,
  color,
  align = "center",
  startFrame = 0,
  underline,
  letterSpacing,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { fontSize } = fitTextOnNLines({ text, maxLines, maxBoxWidth, fontFamily, fontWeight, maxFontSize });
  const words = text.split(" ").filter(Boolean);
  const localF = frame - startFrame;
  const underlineSpr = spring({ fps, frame: localF - words.length * 3, config: { damping: 16 } });

  return (
    <div
      style={{
        position: "relative",
        display: "inline-flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
        alignItems: "flex-end",
        gap: `${fontSize * 0.12}px ${fontSize * 0.26}px`,
        maxWidth: maxBoxWidth,
        ...style,
      }}
    >
      {words.map((w, i) => {
        const spr = spring({ fps, frame: localF - i * 3, config: { damping: 13 } });
        return (
          <span
            key={i}
            style={{
              fontFamily,
              fontWeight,
              fontSize,
              color,
              letterSpacing,
              lineHeight: 1.02,
              display: "inline-block",
              opacity: spr,
              transform: `translateY(${interpolate(spr, [0, 1], [fontSize * 0.55, 0])}px) rotate(${interpolate(spr, [0, 1], [-5, 0])}deg)`,
            }}
          >
            {w}
          </span>
        );
      })}
      {underline && (
        <div
          style={{
            position: "absolute",
            left: 0,
            bottom: -Math.max(10, fontSize * 0.14),
            height: Math.max(6, fontSize * 0.1),
            borderRadius: 999,
            background: underline,
            width: `${interpolate(underlineSpr, [0, 1], [0, 100])}%`,
          }}
        />
      )}
    </div>
  );
};
