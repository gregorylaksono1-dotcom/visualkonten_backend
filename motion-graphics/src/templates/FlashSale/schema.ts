import { z } from "zod";
import { zColor } from "@remotion/zod-types";

// ==== THEME (semua warna dari sini — ⛔ jangan hardcode warna di komponen) ====
export const themeSchema = z.object({
  bgFrom: zColor().default("#ff9d1c"), // gradient atas (oranye)
  bgTo: zColor().default("#ff6a00"), // gradient bawah
  panel: zColor().default("#e11d2a"), // panel produk (merah)
  paper: zColor().default("#ffffff"), // sisi teks (putih)
  ink: zColor().default("#111111"), // teks gelap
  paperInk: zColor().default("#111111"),// teks di atas putih
  onPanel: zColor().default("#ffffff"), // teks di atas panel merah
  accent: zColor().default("#e11d2a"), // aksen/pita/diskon
  button: zColor().default("#111111"), // tombol CTA
  buttonInk: zColor().default("#ffffff"),
});
export type Theme = z.infer<typeof themeSchema>;

// ==== TIMING (durasi tiap scene, detik) → total durasi dihitung di Root ====
export const timingSchema = z.object({
  intro: z.number().min(1).max(6).default(3),
  badge: z.number().min(1).max(6).default(3),
  showcase: z.number().min(4).max(16).default(11),
  outro: z.number().min(1).max(5).default(2),
});

// ==== PROPS UTAMA (KONTRAK — LLM & backend mengisi ini) ====
export const flashSaleSchema = z.object({
  brand: z.object({
    name: z.string().default("ETSHOP.IN"),
    logoUrl: z.string().optional(), // PNG transparan (opsional)
  }),
  product: z.object({
    title: z.string().default("HEADPHONE"),
    subtitle: z.string().default("BEATS PRO"),
    imageUrl: z.string().default(""), // URL foto produk (cutout atau biasa)
    imageIsCutout: z.boolean().default(false), // true = produk floating; false = di kartu
  }),
  sale: z.object({
    badgeText: z.string().default("FLASH SALE"),
    headline: z.string().default("BIG SALE"),
    discount: z.string().default("50% OFF"),
    priceOld: z.string().optional(), // "Rp150.000"
    priceNew: z.string().optional(), // "Rp99.000"
    description: z.string().default("Kualitas premium, harga spesial hari ini saja."),
  }),
  cta: z.object({
    text: z.string().default("SHOP NOW"),
  }),
  theme: themeSchema.default({}),
  timing: timingSchema.default({}),
});

export type FlashSaleProps = z.infer<typeof flashSaleSchema>;
