import React from "react";
import { fitTextOnNLines } from "@remotion/layout-utils";

// Auto-fit font: menghitung fontSize supaya `text` muat dalam `maxBoxWidth`
// dengan maksimal `maxLines` baris, di-cap `maxFontSize`. Mencegah teks
// panjang (mis. "Beli 1 Gratis 1") overflow / drop ke baris baru tak rapi.
export const FitText: React.FC<{
  text: string;
  maxFontSize: number;
  maxBoxWidth: number;
  maxLines?: number;
  fontFamily: string;
  fontWeight?: number | string;
  letterSpacing?: number;
  textTransform?: "uppercase" | "lowercase" | "capitalize" | "none";
  style?: React.CSSProperties;
}> = ({
  text,
  maxFontSize,
  maxBoxWidth,
  maxLines = 1,
  fontFamily,
  fontWeight = 400,
  letterSpacing,
  textTransform,
  style,
}) => {
  const { fontSize } = fitTextOnNLines({
    text,
    maxLines,
    maxBoxWidth,
    fontFamily,
    fontWeight,
    letterSpacing: letterSpacing ? `${letterSpacing}px` : undefined,
    textTransform,
    maxFontSize,
  });

  return (
    <div
      style={{
        fontFamily,
        fontWeight,
        fontSize,
        letterSpacing,
        textTransform,
        maxWidth: maxBoxWidth,
        // izinkan wrap kalau maxLines > 1, tetap tak overflow karena fontSize sudah dihitung
        whiteSpace: maxLines > 1 ? "normal" : "nowrap",
        ...style,
      }}
    >
      {text}
    </div>
  );
};
