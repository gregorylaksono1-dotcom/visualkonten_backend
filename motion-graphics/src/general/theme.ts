import { Props } from "./schema";

export const getMoodConfig = (mood: string) => {
  switch (mood) {
    case "premium":
    case "elegant":
      return { speedMultiplier: 0.7, contrast: 1.2, radius: 0, fontScale: 1, glowOpacity: 0.1 };
    case "playful":
    case "upbeat":
      return { speedMultiplier: 1.3, contrast: 1, radius: 32, fontScale: 1.1, glowOpacity: 0.3 };
    case "energetic":
      return { speedMultiplier: 1.4, contrast: 1.15, radius: 18, fontScale: 1.08, glowOpacity: 0.28 };
    case "techy":
      return { speedMultiplier: 1.1, contrast: 1.1, radius: 8, fontScale: 1, glowOpacity: 0.2 };
    case "fresh":
    default:
      return { speedMultiplier: 1.0, contrast: 1.0, radius: 16, fontScale: 1, glowOpacity: 0.15 };
  }
};

const palettePool: Record<string, NonNullable<Props["theme"]["palette"]>> = {
  ocean_blue: { brandA: "#0284c7", brandB: "#0f172a", accent: "#38bdf8", ink: "#f0f9ff" },
  sunset_orange: { brandA: "#ea580c", brandB: "#431407", accent: "#fb923c", ink: "#fff7ed" },
  emerald_green: { brandA: "#059669", brandB: "#064e3b", accent: "#34d399", ink: "#ecfdf5" },
  royal_purple: { brandA: "#7c3aed", brandB: "#2e1065", accent: "#a78bfa", ink: "#f5f3ff" },
  rose_pink: { brandA: "#e11d48", brandB: "#4c0519", accent: "#fb7185", ink: "#fff1f2" },
  cyber_neon: { brandA: "#0ea5e9", brandB: "#171717", accent: "#a3e635", ink: "#ffffff" },
  monochrome: { brandA: "#404040", brandB: "#0a0a0a", accent: "#a3a3a3", ink: "#ffffff" },
  gold_rush: { brandA: "#d97706", brandB: "#27272a", accent: "#fde047", ink: "#fafafa" },
  midnight_blue: { brandA: "#3b82f6", brandB: "#0f172a", accent: "#60a5fa", ink: "#e2e8f0" },
  cherry_blossom: { brandA: "#db2777", brandB: "#1f2937", accent: "#f472b6", ink: "#fce7f3" },
  // Alias nama dari builder §3A (sebelumnya tidak cocok → selalu jatuh ke biru default)
  midnight_gold: { brandA: "#1e293b", brandB: "#0f172a", accent: "#fbbf24", ink: "#f8fafc" },
  rose_plum: { brandA: "#db2777", brandB: "#3b0764", accent: "#fbcfe8", ink: "#fff1f2" },
  emerald_night: { brandA: "#10b981", brandB: "#053b34", accent: "#a7f3d0", ink: "#ecfeff" },
  sunset_coral: { brandA: "#fb7185", brandB: "#7c2d12", accent: "#fed7aa", ink: "#fff7ed" },
  royal_violet: { brandA: "#7c3aed", brandB: "#2e1065", accent: "#c4b5fd", ink: "#f5f3ff" },
  teal_navy: { brandA: "#0ea5e9", brandB: "#0c1b33", accent: "#5eead4", ink: "#f0f9ff" },
  festive_red_gold: { brandA: "#e11d48", brandB: "#4c0519", accent: "#fde68a", ink: "#fff1f2" },
  mono_ink: { brandA: "#3f3f46", brandB: "#0a0a0a", accent: "#e5e7eb", ink: "#ffffff" },
  forest_lime: { brandA: "#65a30d", brandB: "#14320f", accent: "#d9f99d", ink: "#f7fee7" },
  plum_peach: { brandA: "#c026d3", brandB: "#4a044e", accent: "#fcd34d", ink: "#fdf4ff" },
};

// Daftar id utk rotasi deterministik kalau builder tak set palette_id
const POOL_IDS = Object.keys(palettePool);

// Hash string → int (utk pilih palet deterministik dari seed apa pun)
const hashStr = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

// ---------- KONTRAS: pilih warna teks paling terbaca dari palet ----------
const hexToRgb = (hex: string): [number, number, number] => {
  let h = (hex || "#000").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return [0, 0, 0];
};
const relLum = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastRatio = (a: string, b: string): number => {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
// Kembalikan warna teks (dari palet, fallback hitam/putih) yang paling kontras dgn `bg`.
export const readableTextColor = (bg: string, palette: NonNullable<Props["theme"]["palette"]>): string => {
  const darkCand = relLum(palette.brandB) <= relLum("#111111") ? palette.brandB : "#111111";
  const lightCand = relLum(palette.ink) >= relLum("#ffffff") ? palette.ink : "#ffffff";
  return contrastRatio(bg, darkCand) >= contrastRatio(bg, lightCand) ? darkCand : lightCand;
};

// ⛔ ANTI-PLACEHOLDER (render-safe): buang token placeholder yang bocor ke teks
// (mis. "Kebaktian DATE" → "Kebaktian"). Mengembalikan "" kalau seluruhnya placeholder.
const PLACEHOLDER_RE = /\b(DATE|TIME|TBA|TBD|XXX|PLACEHOLDER)\b|\[[^\]]*\]|\{\{[^}]*\}\}|<[^>]*>/g;
export const sanitizeText = (t?: string | null): string => {
  if (!t) return "";
  return t.replace(PLACEHOLDER_RE, "").replace(/\s{2,}/g, " ").trim();
};

export const resolvePalette = (theme: Props["theme"]): NonNullable<Props["theme"]["palette"]> => {
  if (theme.palette && theme.palette.brandB) return theme.palette as NonNullable<Props["theme"]["palette"]>;
  if (theme.palette_id && palettePool[theme.palette_id]) return palettePool[theme.palette_id];
  // Fallback anti-seragam: kalau tak ada palette_id valid, rotasi deterministik dari pool
  // pakai bg_style+mood sebagai seed (⛔ jangan selalu biru default).
  const seed = hashStr(`${theme.bg_style || "aurora"}|${theme.mood || "fresh"}`);
  return palettePool[POOL_IDS[seed % POOL_IDS.length]];
};