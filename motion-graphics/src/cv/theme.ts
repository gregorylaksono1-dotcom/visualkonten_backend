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

// ---- KONTRAS: pastikan `text` selalu terbaca di atas `bg` ----
// (LLM/builder kadang kirim theme.palette.text yang gelap → nyatu dgn bg gelap → tak terbaca)
const _lum = (hex: string): number => {
  let h = (hex || "#000").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2) || "0", 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const _contrast = (a: string, b: string): number => {
  const la = _lum(a), lb = _lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const _hexToRgb = (hex: string): [number, number, number] => {
  let h = (hex || "#000").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2) || "0", 16), parseInt(h.slice(2, 4) || "0", 16), parseInt(h.slice(4, 6) || "0", 16)];
};
const _mix = (hex: string, target: string, t: number): string => {
  const [r1, g1, b1] = _hexToRgb(hex), [r2, g2, b2] = _hexToRgb(target);
  const m = (a: number, b: number) => Math.round(a + (b - a) * t).toString(16).padStart(2, "0");
  return `#${m(r1, r2)}${m(g1, g2)}${m(b1, b2)}`;
};
// Jamin text & accent TIDAK menyatu dgn bg (2 arah: bg gelap → terangkan, bg terang → gelapkan).
const ensureReadable = (pal: CvPalette): CvPalette => {
  const bgDark = _lum(pal.bg) < 0.45;
  let text = pal.text;
  if (!text || _contrast(pal.bg, text) < 4.5) text = bgDark ? "#ffffff" : "#0b0b0b";
  let accent = pal.accent;
  if (!accent || _contrast(pal.bg, accent) < 2.2) accent = _mix(accent || "#888888", bgDark ? "#ffffff" : "#000000", 0.5);
  return { ...pal, text, accent };
};

export const resolveCvPalette = (theme: CvProps["theme"], field: string): CvPalette => {
  if (theme.palette) return ensureReadable(theme.palette);
  const kit = CV_KITS[theme.kit] ? theme.kit : (FIELD_TO_KIT[field] || "creative");
  const pool = CV_KITS[kit];
  return ensureReadable(pool[Math.abs(theme.seed) % pool.length]);
};

export const cvMoodFont = (kit: string) => (kit === "premium" || kit === "calm" ? 1 : 1.05);
