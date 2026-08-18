import { CvProps } from "./schema";

export type CvPalette = { bg: string; text: string; accent: string };

// Kit tema — tiap kit punya beberapa kombinasi 2-warna. Dipilih random-deterministik (seed)
// & adaptif ke bidang orangnya (builder yang set `kit` dari field).
export const CV_KITS: Record<string, CvPalette[]> = {
  creative: [
    { bg: "#1e2a5a", text: "#ffffff", accent: "#ef6f7b" }, // navy / pink
    { bg: "#2b1055", text: "#ffffff", accent: "#ffb703" }, // purple / gold
    { bg: "#0f766e", text: "#ffffff", accent: "#fb7185" }, // teal / coral
  ],
  tech: [
    { bg: "#0a0a0a", text: "#ffffff", accent: "#22d3ee" }, // black / cyan
    { bg: "#0b1220", text: "#e6f0ff", accent: "#a3e635" }, // navy / lime
    { bg: "#111827", text: "#ffffff", accent: "#8b5cf6" }, // charcoal / violet
  ],
  premium: [
    { bg: "#0f172a", text: "#f8fafc", accent: "#fbbf24" }, // navy / gold
    { bg: "#1c1917", text: "#fafaf9", accent: "#14b8a6" }, // stone / teal
    { bg: "#0c0a09", text: "#f5f5f4", accent: "#d4af37" }, // black / champagne
  ],
  energetic: [
    { bg: "#e11d48", text: "#ffffff", accent: "#0ea5e9" }, // red / sky
    { bg: "#ea580c", text: "#ffffff", accent: "#0f172a" }, // orange / navy
    { bg: "#7c3aed", text: "#ffffff", accent: "#fde047" }, // violet / yellow
  ],
  calm: [
    { bg: "#134e4a", text: "#ecfeff", accent: "#fcd34d" }, // teal / amber
    { bg: "#1e3a5f", text: "#eef6ff", accent: "#7dd3fc" }, // slate / sky
    { bg: "#065f46", text: "#ecfdf5", accent: "#fca5a5" }, // green / rose
  ],
};

// field → kit default (kalau builder tak set)
export const FIELD_TO_KIT: Record<string, keyof typeof CV_KITS> = {
  design: "creative", creative: "creative", art: "creative", content: "creative",
  tech: "tech", developer: "tech", engineering: "tech", data: "tech", it: "tech",
  finance: "premium", business: "premium", management: "premium", legal: "premium", consulting: "premium",
  marketing: "energetic", sales: "energetic", growth: "energetic",
  health: "calm", education: "calm", nonprofit: "calm", hospitality: "calm",
};

export const resolveCvPalette = (theme: CvProps["theme"], field: string): CvPalette => {
  if (theme.palette) return theme.palette;
  const kit = CV_KITS[theme.kit] ? theme.kit : (FIELD_TO_KIT[field] || "creative");
  const pool = CV_KITS[kit];
  return pool[Math.abs(theme.seed) % pool.length];
};

export const cvMoodFont = (kit: string) => (kit === "premium" || kit === "calm" ? 1 : 1.05);
