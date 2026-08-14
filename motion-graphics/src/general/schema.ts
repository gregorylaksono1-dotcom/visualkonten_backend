import { z } from "zod";

export const Shape = z.enum(["confetti", "sparkle", "bokeh", "bubble", "ring", "orb", "petal", "fruit", "bean", "star", "glint", "bolt", "streak", "shine", "droplet", "steam", "percent", "coin"]);
export const Behavior = z.enum(["fall", "float", "orbit", "burst", "sweep"]);
export const Glyph = z.enum(["play", "book", "cert", "spark", "bolt", "layers", "crown", "key", "chat", "chart", "star", "megaphone", "calendar", "gift", "ticket"]);

export const propsSchema = z.object({
  status: z.literal("ok").default("ok"),
  template: z.literal("motion_general_v1").default("motion_general_v1"),
  engine: z.literal("remotion").default("remotion"),
  format: z.literal("9:16").default("9:16"),
  duration_sec: z.number().min(10).max(30),
  content_type: z.enum(["product", "announcement"]).default("product"),
  hero_mode: z.enum(["image", "emblem"]).default("image"),
  theme: z.object({
    palette: z.object({ brandA: z.string(), brandB: z.string(), accent: z.string(), ink: z.string(), brandC: z.string().optional() }).optional(),
    palette_id: z.string().nullable().default(null),
    bg_style: z.enum(["aurora", "mesh", "spotlight", "bokeh_night", "waves", "radial_burst", "geometric", "duotone", "starfield", "confetti_field"]).default("aurora"),
    mood: z.enum(["fresh", "premium", "playful", "techy", "elegant", "upbeat"]),
  }),
  product: z.object({
    name: z.string(),
    image: z.string().nullable(),      // "provided_reference" atau null
    imageUrl: z.string().nullable().optional(), // URL asli, di-inject backend saat render
    image_subject: z.enum(["product", "person", "group", "venue", "logo"]).nullable().default(null),
    image_layout: z.enum(["cutout_hero", "framed_portrait", "backdrop"]).nullable().default(null),
    image_is_cutout: z.boolean().default(true),
    emblem_glyph: Glyph.nullable().default(null),
    tagline: z.string().default(""),
  }),
  // FIX: objek announcement sebelumnya hilang dari schema → date_hero/ribbon selalu dibuang zod.
  announcement: z.object({
    date_hero: z.string().nullable().default(null),
    ribbon: z.string().nullable().default(null),
  }).nullable().optional(),
  accent: z.object({
    mode: z.enum(["particles", "motif"]).default("particles"),
    shape: Shape,
    behavior: Behavior,
    colors: z.array(z.string()).min(1),
    density: z.enum(["low", "med", "high"]).default("med"),
    asset: z.string().nullable().default(null),
  }),
  scenes: z.array(z.object({
    id: z.enum(["hook", "reveal", "features", "offer", "cta"]),
    enabled: z.boolean(),
    start_sec: z.number(),
    end_sec: z.number(),
    headline: z.string().optional(),
    sub: z.string().optional(),
    product_name: z.string().optional(),
    tagline: z.string().optional(),
    heading: z.string().optional(),
    items: z.array(z.string()).optional(),
    icons: z.array(z.string()).optional(),
    show_product: z.boolean().optional(),
    badge: z.string().optional(),
    was: z.string().optional(),
    now: z.string().optional(),
    unit: z.string().optional(),
    note: z.string().optional(),
    button: z.string().optional(),
    handle: z.string().optional(),
  })),
  music: z.object({
    provider: z.string().default("gemini_lyria"),
    mood: z.string(),
    prompt: z.string(),
    bpm: z.number().optional(),
    audioUrl: z.string().nullable().optional(),
  }).optional(),
});
export type Props = z.infer<typeof propsSchema>;