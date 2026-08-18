import { z } from "zod";

// Template CV — TERPISAH dari general. ⛔ tanggal/tempat lahir TIDAK ada.
export const cvSchema = z.object({
  status: z.literal("ok").default("ok"),
  template: z.literal("motion_cv_v1").default("motion_cv_v1"),
  engine: z.literal("remotion").default("remotion"),
  format: z.literal("9:16").default("9:16"),
  duration_sec: z.number().min(15).max(40).default(24),
  imageUrl: z.string().nullable().optional(),

  // bidang → dipakai builder buat pilih kit tema yang cocok
  field: z.string().default("general"),

  theme: z.object({
    kit: z.enum(["creative", "tech", "premium", "energetic", "calm"]).default("creative"),
    seed: z.number().default(1), // buat variasi random-tapi-deterministik dari pool kit
    // FIX: izinkan null (builder mengirim "palette": null) + undefined.
    palette: z.object({ bg: z.string(), text: z.string(), accent: z.string() }).nullable().optional(),
  }),

  person: z.object({
    name: z.string(),
    role: z.string(),                 // jabatan/profesi (mis. "Graphic Designer")
    image: z.string().nullable(),     // "provided_reference" (WAJIB foto orang)
    imageUrl: z.string().nullable().optional(),
    image_subject: z.enum(["person", "group", "product", "venue", "logo", "other"]).nullable().default(null),
    tagline: z.string().default(""),  // 1 kalimat pendek (opsional)
  }),

  // skill + level (0–100) → progress bar. level DIISI USER (bukan ditebak LLM).
  // Tahan banting: terima {name,level} ATAU string biasa (dinaikkan ke {name, level:80}).
  skills: z.array(
    z.union([
      z.string().transform((s) => ({ name: s, level: 80 })),
      z.object({ name: z.string(), level: z.coerce.number().min(0).max(100).catch(80).default(80) }),
    ])
  ).default([]), // 3–6
  // ringkasan profil (LLM buat dari input; 1–2 kalimat) → scene "Profil"
  summary: z.string().default(""),
  // soft skills (LLM turunkan dari pengalaman + karakteristik user) → chips
  soft_skills: z.array(z.string()).default([]),
  // user boleh isi BANYAK; template cherry-pick top-N (urutan = paling impactful dulu, dari LLM)
  experience: z.array(z.string()).default([]),
  highlight: z.object({ label: z.string(), value: z.string() }).nullable().optional(), // KPI (mis. "6 Tahun Pengalaman")
  contact: z.object({
    email: z.string().default(""),
    handle: z.string().default(""),
    cta: z.string().default("Mari Berkolaborasi"),
  }).default({ email: "", handle: "", cta: "Mari Berkolaborasi" }),

  music: z.object({
    provider: z.string().default("gemini_lyria"),
    mood: z.string(),
    prompt: z.string(),
    bpm: z.number().optional(),
    audioUrl: z.string().nullable().optional(),
  }).optional(),
});

export type CvProps = z.infer<typeof cvSchema>;
