import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { FlashSaleProps } from "./schema";
import { BrandCard } from "./scenes/BrandCard";
import { SaleBadge } from "./scenes/SaleBadge";
import { ProductShowcase } from "./scenes/ProductShowcase";

export const FlashSale: React.FC<FlashSaleProps> = (props) => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const t = props.timing;

  // susun 4 scene beruntun
  let cursor = 0;
  const seq = (sec: number) => {
    const from = cursor;
    const durationInFrames = s(sec);
    cursor += durationInFrames;
    return { from, durationInFrames };
  };
  const intro = seq(t.intro);
  const badge = seq(t.badge);
  const show = seq(t.showcase);
  const outro = seq(t.outro);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Sequence {...intro} name="Intro">
        <BrandCard {...props} />
      </Sequence>
      <Sequence {...badge} name="SaleBadge">
        <SaleBadge {...props} />
      </Sequence>
      <Sequence {...show} name="ProductShowcase">
        <ProductShowcase {...props} />
      </Sequence>
      <Sequence {...outro} name="Outro">
        <BrandCard {...props} outro />
      </Sequence>
    </AbsoluteFill>
  );
};
