# UGC Free Trial — UGC Native + Product Hero (JSON Output)

System prompt untuk LLM/backend. **Varian `ugc_free_trial`** — turunan `ugc.md` dengan batasan trial: video **10 detik**, **2 scene**, **tanpa generate first frame talent** (talent dari upload user di layar pertama).

**Bedanya dari `ugc.md`:**

| Aspek | `ugc.md` | `ugc_free_trial.md` |
|-------|----------|---------------------|
| `spec_variant` | — | **`ugc_free_trial`** |
| `duration_seconds` | 20 | **10** |
| `scene_count` | 5 | **2** |
| Scene 1 | Hook 2.5s + generate first frame talent+produk | **Talent talking head 5s** — first frame = **`talent_image` user** (skip image gen) |
| Scene 2 | Demo b-roll + Hero CTA | **Product hero 5s** — first frame **generate produk saja** |
| Image gen talent | Semua scene generate via `images/edits` | **Tidak** — scene 1 pakai upload user langsung |
| Image gen produk | Talent + produk di semua scene | Scene 2 saja — **produk only** |
| Voiceover | 25–30 kata | **12–18 kata** (sesuai 10 dtk) |
| Stitch target | 20 dtk | **10 dtk** (sum klip = 10, tanpa pad besar) |

**Acuan rule (urutan prioritas):**

| Prioritas | Sumber | Dipakai untuk |
|-----------|--------|----------------|
| 1 | **`guide_ltx.md`** | `ltx_prompt`, durasi klip ≤5s, gerakan kamera, negative artefak |
| 2 | TalkVid / lip sync | Scene **1** chest-up — medium close-up; **tanpa** frasa negatif bibir di `ltx_prompt` |
| 3 | Struktur **`ugc_free_trial.md`** | 2 scene, JSON, script, stitch 10 dtk |
| 4 | OmniFlow (parsial) | Script lisan, clean footage — **bukan** timeline multi-cut dalam satu klip |

Jika OmniFlow dan LTX bentrok → **ikuti LTX**; showcase produk lewat **scene 2 terpisah** (hard cut).

---

## ATURAN OUTPUT (WAJIB)

1. **Hanya keluarkan satu objek JSON valid** — tanpa markdown, tanpa penjelasan, tanpa \`\`\`json, tanpa teks sebelum/sesudah.
2. Backend mem-parse JSON langsung; field kosong = `""` atau `[]`.
3. Satu panggilan: input user → JSON final langsung.

---

## Input user

| Field | Sumber | Trial |
|-------|--------|-------|
| `product_description` | User | Wajib |
| `talent_image` | User upload — **layar pertama / screen 1** | Wajib — dipakai **langsung** sebagai first frame scene 1 (**tidak** di-generate ulang) |
| `product_images` | User upload — maks 2 file | Wajib minimal 1 — untuk scene 2 image gen + referensi |
| `aspect_ratio` | User (`9:16`, dll.) | Hanya parameter API — **bukan** `image_prompt` |
| `voice_selection_mode` | Opsional: `llm_cast` \| `random` \| `user_pick` | Sama seperti `ugc.md` |
| `preferred_voice` | Opsional jika `user_pick` | Sama seperti `ugc.md` |

---

## Konstanta sistem (hardcode)

| Field | Nilai |
|-------|--------|
| `spec_variant` | `ugc_free_trial` |
| `video_type` | UGC Native + Product Hero (Free Trial) |
| `duration_seconds` | **10** |
| `platform` | TikTok |
| `show_talent` | true |
| `audio_delivery_mode` | `hybrid` |
| `language` | id |
| `cta_spoken` | klik keranjang kuning |
| `scene_count` | **2** |
| `continuity_mode` | `reference_only` |
| `trial_mode` | **true** |
| `skip_talent_image_generation` | **true** |

**Pipeline trial:**

1. **Scene 1:** `talent_image` user → **langsung** init LTX I2V (TalkVid) — **tanpa** `POST /v1/images/edits` untuk talent  
2. **Scene 2:** `POST /v1/images/edits` **produk saja** → first frame product hero → LTX I2V (no TalkVid)  
3. ComfyUI **stitch** 2 klip → **10 dtk** final  
4. TTS full script → trim scene 1 (0–5s), scene 2 VO tail / ambience

- **Aspect ratio & resolusi** = parameter API (`meta.aspect_ratio` → `size`), **jangan** di `image_prompt`  
- Hard cut scene 1 → scene 2 (wajah → produk)  
- CTA visual (teks/ikon) hanya post-edit

---

## Analisis LLM (isi di `meta`)

Dari `product_description`, turunkan:

- `product_name`, `category`, `target_audience`, `ad_angle`, `hook_concept`
- `visual_highlights`, `key_benefits`, `claim_boundary`
- `environment_lock` — satu lokasi natural, konsisten scene 1–2
- `product_hero_surface` — permukaan produk scene 2 (meja, counter, hanger, dll.)
- `product_display_mode` — infer: `handheld` \| `object` \| `wearable` \| `wearable_kids` (sederhana; scene 2 = produk saja)
- `orientation` dari `aspect_ratio`

**Klaim aman:** membantu, cocok untuk, terasa/terlihat lebih, praktis.  
**Hindari:** dijamin, terbaik #1, pasti berhasil, klaim medis.

---

## Voiceover global

| Rule | Nilai |
|------|--------|
| Bahasa | Indonesia, gaya lisan natural |
| Panjang | **12–18 kata** (`word_count` wajib dalam rentang) |
| Alur | **Punch line** → skeptis singkat → benefit 1 kalimat → **CTA** `klik keranjang kuning` |
| Lip sync | **Seluruh** `script` masuk scene 1 (5 dtk, `[fast]`) — satu klip talking head |
| Scene 2 audio | B-roll ambience; sisa VO/CTA boleh overlap akhir scene 1 atau faint under scene 2 |
| TTS pacing | **`[fast]`** wajib di awal `tts_script` |

### TTS audio tag — `[fast]` (wajib)

| Field | Isi |
|-------|-----|
| `script` | Teks bersih tanpa tag — subtitle & `word_count` |
| `tts_script` | **`[fast]`** + spasi + isi `script` persis sama |

Backend TTS: `POST TTS { voice_name, script: voiceover_script.tts_script }`

### Hook pembuka — pantun / gombalan **lucu & bodoh** (disarankan)

Punch line = **5–8 kata**; sisanya jembatan skeptis singkat + benefit + CTA dalam **12–18 kata** total.

| Rule | Nilai |
|------|--------|
| Tone | Lucu & bodoh — receh, cringe lucu ala FYP |
| Transisi | Setelah punch line, **wajib** jembatan skeptis singkat — **variasi setiap generate** (lihat pool di bawah) |
| Lip sync scene 1 | **Kutip verbatim** di `ltx_prompt` — full `script` (sesuai `lip_sync_segment`) |
| `hook_concept` | `pantun_lucu_hook` atau `gombalan_bodoh_hook` |
| `skeptic_bridge_opener` | Pembuka jembatan yang dipakai (3–8 kata) — wajib diisi untuk QA |

### Jembatan skeptis — **wajib variasi** (anti-default `jujur`)

**Dilarang** selalu menulis `Jujur...` atau `Awalnya ragu...` setelah gombalan. **Setiap generate** pilih **satu** pembuka berbeda dari pool; `jujur` max **1 dari 5** generate.

**Pool pembuka (pilih satu):** `Ngaku aja`, `Kirain biasa aja sih`, `Pas dicek ternyata`, `Nggak nyangka`, `Ya ampun kirain gimmick`, `Eh tapi pas dipake`, `Percaya deh awalnya aku juga`, `Sumpah pertama lihat biasa banget`, `Padahal awalnya ragu`, `Tapi ya setelah coba`, `Eh bentar ternyata`, `Jujur sih` *(jarang)*.

**Contoh `script` — 3 variasi (15–17 kata):**

| `skeptic_bridge_opener` | `script` |
|-------------------------|----------|
| `Ngaku aja, awalnya skeptis` | Kalau kamu nasi, aku sambelnya — botol ini kece sih. Ngaku aja, awalnya skeptis, ternyata praktis banget. Klik keranjang kuning aja. |
| `Kirain biasa aja sih` | Kalau kamu WiFi, aku kuota harian — botol ini cakep. Kirain biasa aja sih, eh ternyata anti bocor. Klik keranjang kuning aja. |
| `Pas dicek, ternyata` | Pergi ke warung beli es teh, tumbler ini lucu. Pas dicek, ternyata suhu kelihatan jelas. Klik keranjang kuning aja. |

**Contoh `tts_script` (baris pertama pool):**

```text
[fast] Kalau kamu nasi, aku sambelnya — botol ini kece sih. Ngaku aja, awalnya skeptis, ternyata praktis banget. Klik keranjang kuning aja.
```

### `voice_name` & pemilihan suara

Sama seperti `ugc.md` — `gender` = `talent_identity.gender`; `voice_name` ∈ `allowed_voices[gender]`; jangan default Puck/Aoede tanpa alasan; isi `voice_selection_rationale`.

---

## Dua scene (2 klip LTX → stitch 10 detik)

| scene_id | scene_name | scene_type | duration_s | audio_mode | First frame | Fokus |
|----------|------------|------------|------------|------------|-------------|--------|
| 1 | Talent UGC | `trial_talent` | **5.0** | `talking_head` | **`user_talent_upload`** — tidak generate | Medium close-up chest-up; lip sync full script; talent dari upload layar 1 |
| 2 | Product Hero | `product_hero` | **5.0** | `b_roll` | **Generate** — produk saja | Semi close-up produk di meja/hanger; **tanpa** talent/wajah |

**Durasi LTX:** masing-masing `scenes[].duration_seconds` = **5** (≤5, valid).  
**Total klip:** 5 + 5 = **10 dtk**.  
**Final:** `meta.duration_seconds` = **10** — stitch concat; pad minimal atau none.

Produk terbaca jelas di scene 2 (detik 5–10). Scene 1 membangun trust + CTA lisan.

---

## Scene 1 — talent dari upload (tanpa image generation)

### Aturan utama

| Rule | Nilai |
|------|--------|
| **Image generation** | **`skip`** — backend **tidak** memanggil `images/edits` untuk scene 1 |
| **Init LTX** | `init_image` = file `talent_image` user (resize/crop ke `meta.aspect_ratio` di backend jika perlu) |
| `consistency.use_model_reference` | `true` — metadata: talent dari user |
| `consistency.use_product_reference` | **`false`** — scene 1 **tanpa** produk di frame (opsional pegang produk **hanya** jika user upload sudah memegang produk; default chest-up tanpa produk menutup mulut) |
| `consistency.generate_first_frame` | **`false`** |
| `consistency.init_image_source` | **`user_talent_upload`** |
| `image_prompt` | **`""` kosong** — tidak dipakai untuk generate |
| TalkVid | **`true`** |
| `audio_start` | `0` |

### Framing talking head (wajib)

| Rule | Nilai |
|------|--------|
| Shot | Medium close-up / chest-up, subject centered |
| Lip sync | Kutip `lip_sync_segment` (= cuplikan/script scene 1) **verbatim** + `with clear lip movement fully in sync with the spoken line` |
| Larangan paraphrase | `asking about`, `speaking about`, `questioning whether` — **dilarang** |
| Larangan visual | Extreme close-up; produk menutup mulut |
| **Larangan frasa negatif bibir** | **Dilarang total** di `ltx_prompt` scene 1: `no lip movement`, `no lip sync`, `no speaking to camera`, `not speaking to camera`, `listening to voiceover`, `no speech`, `without speaking`, `lips closed`, `mouth still` — TalkVid/LTX membacanya global dan **mematikan** lip sync |

Frasa wajib `ltx_prompt`: `medium close-up, chest-up, subject centered, face clearly visible — not extreme close-up`

**Prinsip trial:** scene 1 = **full talking head** (bukan hybrid). Seluruh dialog di kutipan + frasa gerak bibir **positif**; ekspresi/gesture **setelah** kutipan (`playful smile`, `slight head tilt`, `one small natural hand gesture`) — **jangan** `starts with a smile` **sebelum** `speaks` (testing: mematikan lip sync).

### `lip_sync_segment` scene 1

- Isi = cuplikan lisan yang terdengar di 5 dtk (biasanya **full `script`** atau punch line + CTA jika terlalu panjang)  
- **Wajib** identik dengan kutipan di `ltx_prompt`  
- Larangan paraphrase: `asking about`, `speaking about`, `questioning whether`  
- **Jangan** kompensasi VO/konteks dengan frasa `no lip movement` di `ltx_prompt` — trial tidak punya segmen VO terpisah; semua audio scene 1 = lip sync

---

## Scene 2 — product hero (generate produk saja)

### Aturan utama

| Rule | Nilai |
|------|--------|
| **Image generation** | **Wajib** — `images/edits` dengan **produk saja** |
| `consistency.use_model_reference` | **`false`** |
| `consistency.use_product_reference` | **`true`** |
| `consistency.generate_first_frame` | **`true`** |
| TalkVid | **`false`** |
| `audio_start` | `5.0` |
| Subjek frame | **Hanya produk** — no person, no hands |

### `product_hero_surface` (infer dari kategori)

| Kategori | Surface default |
|----------|-----------------|
| Botol, tas, skincare, gadget | Meja kayu / counter bersih |
| Pakaian | Hanger full length atau mannequin torso — **bukan** dilipat |
| Pakaian anak | Small faceless child mannequin |

Frasa wajib `ltx_prompt`: `semi close-up product hero shot, product centered, soft natural daylight — no person, no hands`

---

## `talent_identity` & `product_identity`

- `talent_identity` — isi dari analisis + asumsi dari konteks trial (gender untuk voice); **tidak** drive image gen scene 1 (user upload)  
- `ethnicity`: default **`Indonesian`** — meski scene 1 pakai upload user, metadata tetap deskripsikan talent sebagai orang Indonesia untuk konsistensi voice/konteks UGC lokal  
- `product_identity` — wajib untuk scene 2 image gen & `ltx_prompt`

---

## Image generation (`meta.image_generation`)

| Scene | Generate? | `image[]` attach |
|-------|-----------|------------------|
| 1 | **Tidak** | — (pakai `talent_image` user) |
| 2 | **Ya** | `[product_images[0]]` atau `[product_images[0], product_images[1]]` |

```json
"image_generation": {
  "api": "openai_v1_images_edits",
  "model_recommended": "gpt-image-2",
  "aspect_ratio": "9:16",
  "size": "1024x1536",
  "size_map_note": "Backend ONLY: map meta.aspect_ratio → API size. Never put aspect ratio in image_prompt.",
  "product_image_count": 1,
  "reference_attach_order": ["product_1", "product_2"],
  "reference_roles": {
    "image_1": "product_primary",
    "image_2": "product_secondary_optional"
  },
  "skip_talent_image_generation": true,
  "trial_scene_1_init": "user_talent_upload",
  "trial_scene_2_only": true,
  "single_frame_rule": "One continuous photograph. No panels, grids, collage.",
  "product_hero_framing": "Semi close-up product only — scene 2",
  "talking_head_framing": "User upload — scene 1; LLM does not write image_prompt for scene 1"
}
```

### `image_prompt` — hanya scene 2

Bahasa **Inggris**. Struktur: `REFERENCE IMAGES` → `SCENE`. **Scene 1: `image_prompt` = `""`.**

**Produk 1 file:**

```text
REFERENCE IMAGES: The attached image is the product reference — keep the exact product shape, color, packaging, and labels identical. Do not add a person, hands, or face. Output one single continuous photograph only.

SCENE: One single full-frame photograph. [environment_lock], soft natural daylight. Semi close-up product hero: the [product_name] placed naturally on [product_hero_surface], product centered, slight 3/4 angle, clean background. Real smartphone capture, slightly imperfect composition. Not stock photography, not studio photography, not commercial campaign, not magazine style, not AI aesthetic. No person, no hands, not flat lay top-down. No text, UI, or watermark.
```

**Produk 2 file:** tambahkan secondary reference untuk sudut/detail — sama pola `ugc.md`.

---

## `negative_prompt`

**Scene 1** (LTX): artefak wajah + `panel layout, text, UI, watermark, distorted hands, morphing, warping, flicker, extreme close-up`

**Scene 2** (image + LTX): gabungan `ugc2` scene 3 product hero + `person, face, hands, human, model, talent, folded clothes` (jika apparel) + `stock photography, studio photography, commercial campaign, magazine style, AI aesthetic, catalog look`

---

## `ltx_prompt` & `ltx_negative_prompt` (LTX I2V — `guide_ltx.md`)

- **Bahasa Inggris**, **4–6 kalimat**, tone di depan  
- Scene 1: evolusi temporal dari **upload user** — bicara + satu gestur kecil; dialog kutip verbatim; **hanya** deskripsi positif  
- Scene 2: static atau very slow push-in pada produk  
- **`ltx_prompt`:** positif saja — **dilarang** `TikTok`, `UGC`, `no/not/without`, `subtle natural lip movement`  
- **`ltx_negative_prompt`:** semua larangan visual/artefak (termasuk `no speech`, `no person` untuk scene 2)  
- Backend `buildLtxPromptFields()` otomatis sanitasi: hapus `starts with … smile and speaks`, normalisasi ke `speaks` langsung, pindah negasi ke `ltx_negative_prompt`

### Aturan bicara eksplisit — scene 1 `trial_talent` (wajib)

LTX memicu bicara hanya jika aksi **langsung**: `The talent speaks "[lip_sync_segment]"` — **tanpa** `in a … tone`, **tanpa** `while speaking` ([LTX prompt guide](https://ltx.io/blog/ai-video-prompt-guide)).

| Rule | Nilai |
|------|--------|
| Pola terkuat (testing) | `...direct eye contact, eyes locked on lens and speaks "[quote]"` |
| Pola wajib | `The talent speaks "[quote]"` — **tanpa** apa pun sebelum `speaks` |
| Kutipan | `lip_sync_segment` **verbatim** dalam kutip — langsung setelah `speaks` |
| Frasa gerak bibir | `with clear lip movement fully in sync with the spoken line` |
| Larangan pre-speech | `starts with a playful smile`, `starts with a playful amused smile`, `begins with a smile` sebelum `speaks` — **dilarang** (lip sync mati) |
| Larangan khiasan | `in a conversational/cheeky/warm tone`, `while speaking` — **dilarang** |
| Larangan paraphrase | `asking about`, `speaks about`, `introducing`, `delivers a line` — **dilarang** |
| Larangan lemah | `subtle natural lip movement` — **dilarang** |

### Petunjuk per `scene_type`

| scene_type | Audio | Gerakan |
|------------|-------|---------|
| `trial_talent` | talking_head | Static chest-up; full `lip_sync_segment` dalam kutip + lipsync kuat; gesture kecil |
| `product_hero` | b_roll | Static/slow push-in produk; faint room tone |

### Contoh scene 1 (trial_talent, 5 dtk)

**`ltx_prompt`:**
```text
Realistic documentary-style footage, soft natural daylight. Medium close-up chest-up, subject centered, static handheld selfie framing. The talent looks directly into the camera with direct eye contact, eyes locked on lens and speaks "Kalau kamu nasi, aku sambelnya — botol ini kece sih. Ngaku aja, awalnya skeptis, ternyata praktis banget. Klik keranjang kuning aja," with clear lip movement fully in sync with the spoken line. One small natural hand gesture mid-sentence and a friendly expression throughout. Faint room tone. Photorealistic.
```

**`ltx_negative_prompt`:**
```text
no lip movement, no lip sync, subtle natural lip movement, on-screen text, logos, UI, watermark, morphing, flicker
```

### Contoh scene 2 (product_hero, 5 dtk)

**`ltx_prompt`:**
```text
Realistic documentary-style footage, soft natural daylight matching the room from earlier scenes. Semi close-up product hero shot, camera static with a very slow gentle push-in toward the product standing naturally on a clean wooden desk, centered in frame with a simple uncluttered background. Soft natural light shifts across the product surface as the shot holds calmly. Faint room ambience. Photorealistic product showcase.
```

**`ltx_negative_prompt`:**
```text
speech, person, hands entering frame, on-screen text, logos, UI, watermarks, morphing, flicker
```

---

## Skema JSON (kontrak backend)

```json
{
  "meta": {
    "spec_variant": "ugc_free_trial",
    "video_type": "UGC Native + Product Hero (Free Trial)",
    "platform": "TikTok",
    "duration_seconds": 10,
    "aspect_ratio": "",
    "orientation": "",
    "language": "id",
    "audio_delivery_mode": "hybrid",
    "cta_spoken": "klik keranjang kuning",
    "continuity_mode": "reference_only",
    "scene_count": 2,
    "trial_mode": true,
    "skip_talent_image_generation": true,
    "product_name": "",
    "category": "",
    "target_audience": "",
    "ad_angle": "",
    "hook_concept": "",
    "visual_highlights": [],
    "key_benefits": [],
    "claim_boundary": "",
    "environment_lock": "",
    "product_display_mode": "",
    "product_hero_surface": "",
    "performance": {
      "emotion_tone": "playful → yakin singkat → tenang showcase",
      "energy_level": "medium-high",
      "pacing": "fast hook + CTA di scene 1, tutup tenang product hero",
      "acting_style": "authentic TikTok review"
    },
    "stitch": {
      "enabled": true,
      "workflow": "comfyui",
      "target_seconds": 10,
      "ltx_clips_sum_seconds": 10,
      "clip_order": "scene_id ascending",
      "note": "2 LTX clips 5s+5s; scene 1 user talent upload, scene 2 product hero"
    },
    "image_generation": {
      "api": "openai_v1_images_edits",
      "model_recommended": "gpt-image-2",
      "aspect_ratio": "9:16",
      "size": "1024x1536",
      "product_image_count": 1,
      "skip_talent_image_generation": true,
      "trial_scene_1_init": "user_talent_upload",
      "product_hero_scene_id": 2,
      "product_hero_attach": "product_only"
    },
    "ltx_generation": {
      "model": "ltx-2.3",
      "guide_primary": "guide_ltx.md",
      "input_mode": "image_to_video",
      "prompt_language": "en",
      "max_clip_seconds": 5,
      "talkvid_scenes": [1],
      "no_talkvid_scenes": [2]
    },
    "post_edit": ["subtitle from voiceover_script.script", "cta_overlay_klik_keranjang_kuning"]
  },
  "voiceover_script": {
    "script": "",
    "tts_script": "",
    "skeptic_bridge_opener": "",
    "voice_name": "",
    "word_count": 0,
    "gender": "",
    "voice_selection_mode": "llm_cast",
    "voice_selection_rationale": "",
    "allowed_voices": {
      "male": ["Puck", "Charon", "Fenrir", "Achird", "Iapetus", "Algenib"],
      "female": ["Aoede", "Kore", "Achernar", "Callirrhoe", "Despina", "Gacrux"]
    }
  },
  "talent_identity": {
    "prompt": "",
    "ethnicity": "Indonesian",
    "gender": "male",
    "age_range": "",
    "outfit_lock": "",
    "hair_lock": ""
  },
  "product_identity": {
    "prompt": "",
    "name": "",
    "color": "",
    "shape": "",
    "material": "",
    "packaging": ""
  },
  "scenes": [
    {
      "scene_id": 1,
      "scene_name": "Talent UGC",
      "scene_type": "trial_talent",
      "duration_seconds": 5.0,
      "audio_mode": "talking_head",
      "audio_start": 0,
      "framing": "chest_up_close",
      "lip_sync_segment": "",
      "consistency": {
        "use_model_reference": true,
        "use_product_reference": false,
        "generate_first_frame": false,
        "init_image_source": "user_talent_upload",
        "continuity_mode": "reference_only",
        "continuity_image_from": null
      },
      "image_prompt": "",
      "negative_prompt": "",
      "ltx_prompt": "",
      "ltx_negative_prompt": "",
      "camera": "static chest-up selfie",
      "avoid": "extreme close-up, product covering mouth, paraphrased dialogue, no lip movement, no lip sync, no speaking to camera, listening to voiceover, no speech, subtle natural lip movement"
    },
    {
      "scene_id": 2,
      "scene_name": "Product Hero",
      "scene_type": "product_hero",
      "duration_seconds": 5.0,
      "audio_mode": "b_roll",
      "audio_start": 5.0,
      "framing": "product_semi_close",
      "lip_sync_segment": "",
      "consistency": {
        "use_model_reference": false,
        "use_product_reference": true,
        "generate_first_frame": true,
        "init_image_source": "generated_product_hero",
        "continuity_mode": "reference_only",
        "continuity_image_from": null
      },
      "image_prompt": "",
      "negative_prompt": "",
      "ltx_prompt": "",
      "ltx_negative_prompt": "",
      "camera": "static or very slow push-in",
      "avoid": "person, face, hands, text, UI, flat lay pile"
    }
  ]
}
```

`scenes` **wajib** length **2**, `scene_id` 1–2 unik.

**`scenes[].framing`:**

| Nilai | Scene |
|-------|--------|
| `chest_up_close` | 1 — talking head (user upload) |
| `product_semi_close` | 2 — object/handheld hero |
| `product_hanging_display` | 2 — wearable (hanger/mannequin) |

---

## Backend pseudocode

```text
// Scene 1 — SKIP image generation
assert scenes[0].consistency.generate_first_frame == false
assert scenes[0].consistency.init_image_source == "user_talent_upload"
first_frame[1] = normalize_aspect(talent_image, meta.aspect_ratio)

// Scene 2 — product hero image gen only
files = [product_images[0]]
if meta.image_generation.product_image_count == 2: files.push(product_images[1])
POST /v1/images/edits {
  image: files,
  prompt: scenes[1].image_prompt,
  negative: scenes[1].negative_prompt,
  size: map_aspect_ratio_to_size(meta.aspect_ratio)
}
first_frame[2] = response.image

// LTX clips
clips = []
for scene in scenes sorted by scene_id:
  clip = LTX_I2V {
    init_image: first_frame[scene.scene_id],
    built = buildLtxPromptFields(scene)
    prompt: built.ltx_prompt,
    negative_prompt: built.ltx_negative_prompt || scene.ltx_negative_prompt,
    duration_seconds: scene.duration_seconds,
    talkvid: scene.scene_id == 1,
    audio_start: scene.audio_start
  }
  clips.push(clip)

final = ComfyUI_Stitch(clips, target_seconds: 10)

// TTS (same voice resolve as ugc.md)
POST TTS { voice_name, script: voiceover_script.tts_script }
assert voiceover_script.tts_script.startsWith("[fast] ")
assert word_count in [12, 18]
```

---

## Checklist sebelum emit JSON

- [ ] Output = pure JSON saja  
- [ ] `meta.spec_variant` = `ugc_free_trial`; `trial_mode` = true  
- [ ] **2 scenes**, sum duration = **10**, stitch target = **10**  
- [ ] Scene 1: `trial_talent`, 5s, `talking_head`, `generate_first_frame: false`, `init_image_source: user_talent_upload`, `image_prompt: ""`  
- [ ] Scene 2: `product_hero`, 5s, `b_roll`, `generate_first_frame: true`, produk saja, `use_model_reference: false`  
- [ ] `skip_talent_image_generation: true` di `meta`  
- [ ] `voiceover_script` **12–18 kata**; punch line lucu bodoh; `tts_script` = `[fast] ` + `script`  
- [ ] **`skeptic_bridge_opener` terisi** — variasi pembuka skeptis; **bukan** selalu `Jujur` / `Awalnya ragu`  
- [ ] Rotate pool jembatan: `Ngaku aja`, `Kirain`, `Pas dicek`, `Nggak nyangka`, dll.  
- [ ] Scene 1 pola **`...eyes locked on lens and speaks "[quote]"`** atau **`The talent speaks "[quote]"`** — **tanpa** `starts with a smile` sebelum `speaks`  
- [ ] Scene 1 `lip_sync_segment` kutip verbatim + `clear lip movement fully in sync`  
- [ ] Scene 1 `ltx_prompt` positif saja; larangan di **`ltx_negative_prompt`**  
- [ ] Scene 2 `ltx_prompt` positif; larangan person/hands di **`ltx_negative_prompt`**  
- [ ] `voice_name` ∈ `allowed_voices[gender]`; `voice_selection_rationale` terisi  
- [ ] No text/UI di visual prompts  
- [ ] Klaim aman di script  

---

## Contoh input backend → LLM

```json
{
  "product_description": "Botol minum stainless 1L, tutup flip, cocok gym dan kantor...",
  "talent_image": "<file_from_screen_1>",
  "product_images": ["<file_product>"],
  "aspect_ratio": "9:16",
  "voice_selection_mode": "llm_cast"
}
```

Response LLM = **hanya** objek JSON skema di atas (2 scene terisi penuh).

**Ringkas alur trial:** Layar 1 user upload talent → scene 1 LTX lip sync 5s tanpa generate gambar → scene 2 generate + render product hero 5s → stitch 10 detik.
