import React from "react";
import { Img } from "remotion";
import { Shape } from "../schema";

export const renderShape = (
  shape: Shape,
  color: string,
  size: number,
  mode: "particles" | "motif",
  asset: string | null
) => {
  if (mode === "motif" && asset) {
    return (
      <Img 
        src={asset} 
        style={{ width: size * 2, height: size * 2, objectFit: "contain" }} 
        onError={(e) => {
          // Fallback to shape rendering visually if img fails, handled by parent ideally, 
          // but for Remotion Img it will just be broken if not found. We assume asset is validated.
        }}
      />
    );
  }

  const s = size;
  const s2 = size * 2;

  switch (shape) {
    case "confetti":
      return <div style={{ width: s * 1.5, height: s * 0.8, backgroundColor: color, borderRadius: 2 }} />;
    case "sparkle":
      return (
        <svg width={s2} height={s2} viewBox="0 0 24 24" fill={color}>
          <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z" />
        </svg>
      );
    case "bokeh":
      return <div style={{ width: s2, height: s2, backgroundColor: color, borderRadius: "50%", opacity: 0.25, filter: "blur(2px)" }} />;
    case "bubble":
      return <div style={{ width: s2, height: s2, borderRadius: "50%", border: `2px solid ${color}`, opacity: 0.6 }} />;
    case "ring":
      return <div style={{ width: s2, height: s2, borderRadius: "50%", border: `4px solid ${color}` }} />;
    case "orb":
      return <div style={{ width: s2, height: s2, borderRadius: "50%", background: `radial-gradient(circle, ${color} 0%, transparent 80%)` }} />;
    case "petal":
      return <div style={{ width: s * 1.5, height: s2, backgroundColor: color, borderRadius: "50% 0 50% 0" }} />;
    case "fruit":
      return (
        <div style={{ width: s2, height: s2, backgroundColor: color, borderRadius: "50%", position: "relative" }}>
          <div style={{ position: "absolute", top: "15%", left: "15%", width: "25%", height: "25%", backgroundColor: "rgba(255,255,255,0.4)", borderRadius: "50%" }} />
        </div>
      );
    case "bean":
      return (
        <div style={{ width: s * 1.2, height: s2, backgroundColor: color, borderRadius: "40%" }}>
           <div style={{ width: "20%", height: "80%", backgroundColor: "rgba(0,0,0,0.1)", margin: "10% auto", borderRadius: 4 }} />
        </div>
      );
    case "star":
      return (
        <svg width={s2} height={s2} viewBox="0 0 24 24" fill={color}>
          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
        </svg>
      );
    case "bolt":
      return (
        <svg width={s2} height={s2} viewBox="0 0 24 24" fill={color}>
          <path d="M13 2L3 14H12L11 22L21 10H12L13 2Z" />
        </svg>
      );
    case "streak":
      return <div style={{ width: s * 3, height: 4, backgroundColor: color, borderRadius: 2 }} />;
    case "shine":
      return <div style={{ width: s * 2, height: s * 2, background: `linear-gradient(45deg, transparent, ${color}, transparent)` }} />;
    case "droplet":
      return <div style={{ width: s * 1.5, height: s * 1.5, backgroundColor: color, borderRadius: "0 50% 50% 50%", transform: "rotate(45deg)" }} />;
    case "steam":
      return <div style={{ width: s * 1.5, height: s * 2, backgroundColor: color, borderRadius: "50%", opacity: 0.3, filter: "blur(3px)" }} />;
    case "percent":
      return <div style={{ color, fontSize: s * 1.5, fontWeight: 900, fontFamily: "sans-serif" }}>%</div>;
    case "coin":
      return <div style={{ width: s2, height: s2, backgroundColor: color, borderRadius: "50%", border: "2px dashed rgba(255,255,255,0.5)" }} />;
    case "glint":
    default:
      return (
        <svg width={s2} height={s2} viewBox="0 0 24 24" fill={color}>
          <path d="M12 2L13.5 10.5L22 12L13.5 13.5L12 22L10.5 13.5L2 12L10.5 10.5L12 2Z" />
        </svg>
      );
  }
};
