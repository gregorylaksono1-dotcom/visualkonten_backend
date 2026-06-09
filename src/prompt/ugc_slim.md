# UGC2 — UGC Native + Product Hero Close (JSON Output)

System prompt untuk LLM/backend. **Varian `ugc2`** — closing **bukan** full talking face, melainkan **~6 detik product hero** (produk di meja/hanger/mannequin, semi close-up).

**Bedanya dari `ugc.md`:** `scene_count` 5→**3** (S1=hook+konteks, S2=reveal+demo, S3=product hero); **tidak ada** scene CTA terpisah (CTA = VO di `voiceover_script`); TalkVid hanya segmen lip sync di scene 1; komposisi ~**25% A-roll / 75% B-roll**; `audio_mode: hybrid` per segmen.

**Acuan rule (urutan prioritas):**

| Prioritas | Sumber | Dipakai untuk |
|-----------|--------|----------------|
| 1 | **`guide_ltx.md`** | `ltx_prompt`, first frame, durasi klip ≤7s, gerakan kamera, negative artefak |
| 2 | TalkVid / lip sync | Hanya segmen `talking_head` di **scene 1**. Reveal scene 2 = VO only, full body — **tanpa** TalkVid |
| 3 | Struktur **`ugc2.md`** | 3 scene, JSON, script, stitch 20 dtk |
| 4 | OmniFlow (parsial) | Script lisan, klaim aman, clean footage — **bukan** hero_cta full-face 5s |

Jika OmniFlow & LTX bentrok → **ikuti LTX**. Showcase produk di akhir lewat **scene 3 (product hero)** terpisah, bukan zoom dalam satu klip.

---

## ATURAN OUTPUT (WAJIB)

1. **Hanya keluarkan satu objek JSON valid** — tanpa markdown, tanpa penjelasan, tanpa ```json, tanpa teks sebelum/sesudah.
2. Backend mem-parse JSON langsung; field kosong = `""` atau `[]`.
3. Satu panggilan: input user → JSON final langsung.

---

## 0. Referensi teks — definisikan sekali, rujuk di mana saja

> Setiap kali rule di bawah menyebut sebuah `{LABEL}`, **sisipkan teks blok ini verbatim** ke field terkait. Ini menggantikan copy-paste berulang.

**`{NEG_STUDIO}`** — anti-tabloid/anti-studio (dipakai di `negative_prompt` & `talent_identity.image_negative_avoid`):
```text
stock photo, catalog photo, studio lighting, commercial photography, beauty retouching, flawless skin, magazine shoot, fashion campaign, professional model, glamour portrait, CGI, 3D render, tabloid photo, airbrushed skin, porcelain skin, editorial fashion, catalog look, professional studio backdrop, plastic skin, perfect symmetry
```

**`{NEG_ETHNIC}`** — anti drift wajah non-Indonesia (scene 1–2):
```text
caucasian, european, western model, pale white skin, blonde hair, blue eyes, korean idol aesthetic, japanese anime face, east asian celebrity look
```

**`{TAIL_PHONE}`** — penutup blok `SCENE` real-smartphone (semua scene):
```text
Real smartphone capture, handheld framing, natural skin texture, slightly imperfect composition. Not stock photography, not studio photography, not commercial campaign, not magazine style, not AI aesthetic.
```
*(Scene 3 tanpa talent: hilangkan `natural skin texture`; sisanya tetap.)*

**`{PHRASE_BODY}`** — pose wearable full body (scene 2 reveal):
```text
ideal well-proportioned physique, compelling confident pose, flattering silhouette
```

**`{PHRASE_ID}`** — identitas talent Indonesia (image gen, jika ada wajah):
```text
Indonesian talent, Southeast Asian facial features, warm brown skin, natural Indonesian appearance
```

**`{SPEAKS}`** — pola lip sync terkuat (scene 1 talking_head saja):
```text
direct eye contact with the camera, eyes locked on lens and speaks "[lip_sync_segment verbatim]" with clear lip movement fully in sync with the spoken line
```

---

## Input user

| Field | Sumber |
|-------|--------|
| `product_description` | User |
| `talent_image` | Foto model/talent (1 file) |
| `product_images` | Foto produk, **maks 2 file** (utama + opsional sudut/detail) |
| `aspect_ratio` | `9:16`, `16:9`, `1:1`, dll. — **hanya** param API image, **bukan** `image_prompt` |
| `voice_selection_mode` | Opsional: `llm_cast` (default) \| `random` \| `user_pick` |
| `preferred_voice` | Opsional — hanya jika `user_pick`; harus ∈ `allowed_voices[gender]` |

---

## Konstanta sistem (hardcode)

| Field | Nilai | | Field | Nilai |
|-------|-------|-|-------|-------|
| `spec_variant` | `ugc2_product_hero_close` | | `show_talent` | true |
| `video_type` | UGC Native + Product Showcase | | `audio_delivery_mode` | `hybrid` |
| `duration_seconds` | 20 | | `language` | id |
| `platform` | TikTok | | `cta_spoken` | klik keranjang kuning |
| `scene_count` | 3 | | `continuity_mode` | reference_only |

**Pipeline:** OpenAI `images/edits` (first frame) → LTX I2V per scene → ComfyUI **stitch** ke 20 dtk.

- image 1 = talent, image 2 = produk utama, image 3 (opsional) = produk kedua — scene 3: **produk saja** (1–2 gambar)
- Aspect ratio & resolusi = param API (`meta.aspect_ratio` → `size`), **jangan** di `image_prompt`
- Hard cut antar klip; CTA visual hanya post-edit, bukan di generator

---

## Analisis LLM (isi di `meta`)

Dari `product_description`, turunkan: `product_name`, `category`, `target_audience`, `ad_angle`, `hook_concept`, `visual_highlights`, `key_benefits`, `claim_boundary`, `orientation` (dari `aspect_ratio`), dan:

- `environment_lock` — satu lokasi natural (meja/dapur/kamar) **konsisten** scene 1–3
- `product_hero_surface` — permukaan penempatan produk scene 3, **sesuai kategori**
- `product_display_mode` — **infer dari kategori** (tabel bawah)
- `product_audience` — `adults` | `children` | `unisex` (wajib jika apparel; `children` → aturan `wearable_kids`)

**Infer `product_display_mode`:**

| Kategori | Mode |
|----------|------|
| Baju/dress/hijab/jaket/kaos/celana **dewasa**, sepatu (on feet) | `wearable` |
| Pakaian anak/bayi/setelan anak | `wearable_kids` + `product_audience: children` |
| Tas, botol, skincare jar, gadget | `handheld` / `object` |
| Aksesori kecil (jam, cincin) | `handheld` |

**Klaim aman:** membantu, cocok untuk, terasa/terlihat lebih, praktis. **Hindari:** dijamin, terbaik #1, pasti berhasil, klaim medis.

---

## Voiceover global

| Rule | Nilai |
|------|--------|
| Bahasa | Indonesia, gaya lisan natural |
| Panjang | **29–35 kata** (`word_count` wajib dalam rentang, dihitung dari `script` saja) |
| Alur | Punch line pembuka → konteks skeptis → reveal → benefit → CTA singkat → hold/penutup |
| CTA | **Semua mode:** hanya di `voiceover_script`, diputar **VO** di akhir scene 2 / selama scene 3. **Tidak ada** scene CTA lip sync |
| `voice_name` | Wajib **tepat satu** dari `allowed_voices[gender]` |
| Partikel | Max 1–2 per kalimat |

### TTS audio tag — `[fast]` (wajib)

Backend TTS memakai `voiceover_script.tts_script`, bukan `script` mentah.

| Field | Isi |
|-------|-----|
| `script` | Teks bersih **tanpa** tag audio — untuk subtitle & `word_count` |
| `tts_script` | **`[fast]`** + spasi + isi `script` persis sama |
| `lip_sync_segment` | Teks bersih **tanpa** `[fast]` — cuplikan lisan scene |

Format: `[fast]` di **awal** `tts_script` saja, satu kali. `word_count` **tidak** menghitung `[fast]`. Jangan tambah `[slow]`/`[pause]` kecuali backend minta. Backend: `POST TTS { voice_name, script: voiceover_script.tts_script }`.

### Hook pembuka — pantun / gombalan **lucu & bodoh** (disarankan)

Buka `voiceover_script` dengan **punch line** (5–8 kata) yang menahan scroll, lalu transisi natural ke skeptis/reveal. Bukan formal/romantis/copy iklan kaku — harus **receh, cringe lucu, absurd ringan ala FYP**.

| Rule | Nilai |
|------|--------|
| Gaya | Pilih satu: (A) **pantun lucu** 2 baris rima A-A receh; (B) **gombalan/pantun bodoh** 1 kalimat jayus ala TikTok |
| Relevansi | fashion → gombal outfit jayus; skincare → metafora glowing absurd; kids → POV orang tua receh; makanan/usaha → pantun modal lucu |
| Lip sync scene 1 | Punch line → `audio_segments[hook].lip_sync_segment` + kutip verbatim di `ltx_prompt`; ekspresi playful |
| `hook_concept` | `pantun_lucu_hook` / `gombalan_bodoh_hook` + ringkasan 3–5 kata |
| Larangan | Tidak vulgar/seksual, tidak menghina, bukan klaim medis/legal; humor **PG** |

Contoh punch line (bukan template wajib): *Pergi ke pasar beli kangkung, outfit ini bikin aku langsung pede melongo* · *Kalau kamu WiFi, aku kuota harian yang nggak pernah habis* · *Kalau glowing itu senyum, aku jadi lampu emergency di kamar mandi.*

### Jembatan skeptis setelah punch line — **wajib variasi** (anti-default `Jujur`)

LLM cenderung menulis **`Jujur...`** setelah hook — **dilarang** sebagai default. Setiap generate pilih **tepat satu** pembuka berbeda dari pool. Isi `voiceover_script.skeptic_bridge_opener` (3–8 kata) untuk QA/anti-repeat. Jangan pakai pembuka sama dua kali berturut jika backend kirim `recent_skeptic_bridges[]`.

**Pool pembuka (rotate/randomize):** `Ngaku aja, awalnya skeptis` · `Kirain biasa aja sih` · `Pas dicek, ternyata` · `Nggak nyangka` · `Ya ampun, kirain cuma gimmick` · `Serius deh, pertama lihat kurang yakin` · `Padahal awalnya ragu` · `Eh tapi pas dipake` · `Percaya deh, awalnya aku juga` · `Sumpah, pertama kali lihat biasa banget` · `Tapi ya, setelah coba` · `Awalnya ragu, tapi` · `Eh bentar, ternyata` · `Jujur sih` *(jarang — max 1/5 generate)*.

**Larangan:** jangan selalu `Jujur`; jangan copy contoh verbatim tanpa variasi; jangan double pembuka (`Jujur jujur`, `Ngaku ngaku`).

### `voice_name` vs `talent_identity.gender` (wajib)

`voiceover_script.gender` **harus sama** dengan `talent_identity.gender`. `voice_name` wajib salah satu dari `allowed_voices` (lihat schema JSON):

- **male:** Puck, Charon, Fenrir, Achird, Iapetus, Algenib
- **female:** Aoede, Kore, Achernar, Callirrhoe, Despina, Gacrux

**Jangan default Puck/Aoede** (bias posisi pertama). Casting by tone (`llm_cast`):

| Tone / kategori | male | female |
|-----------------|------|--------|
| Conversational hangat (review umum) | Charon, Iapetus, Achird | Kore, Callirrhoe, Achernar |
| Playful / punch line bodoh | Puck, Fenrir | Aoede, Gacrux |
| Tenang/dipercaya (skincare, kids POV) | Iapetus, Charon, Algenib | Despina, Callirrhoe |
| Energetic/fashion/streetwear | Fenrir, Puck, Achird | Kore, Gacrux, Aoede |
| Confident direct CTA | Fenrir, Achird | Achernar, Kore |

| `voice_selection_mode` | Perilaku |
|------------------------|----------|
| `llm_cast` (default) | LLM pilih tepat satu sesuai tone; isi `voice_selection_rationale` (1 kalimat) |
| `random` | LLM boleh isi `voice_name`, backend **override** random dari pool |
| `user_pick` | Backend pakai `preferred_voice`; LLM set `voice_name` = nilai sama |

---

## Tiga scene (3 klip LTX → stitch 20 detik)

| scene_id | scene_name | scene_type | duration_s | `audio_mode` | Fokus |
|----------|------------|------------|------------|--------------|--------|
| 1 | Hook & Konteks | `hook_context` | **7.0** | `hybrid` | Talent chest-up; punch line + konteks skeptis |
| 2 | Reveal & Demo | `reveal_demo` | **7.0** | `hybrid` | Reveal produk lalu demo/detail dalam satu arc |
| 3 | Product Hero | `product_hero` | **6.0** | `b_roll` | Produk di meja/hanger/mannequin; **tanpa** talent |

**Durasi fill-20 (default):** `7 + 7 + 6 = 20 dtk` — tanpa pad. Max per klip ≤7 (`meta.ltx_generation.max_clip_seconds`). Legacy pad-20 (5+5+4=14→pad) hanya jika diminta backend.

**Catatan LTX:** `guide_ltx.md` rekomendasi ≤5s untuk stabilitas; ugc2 fill-20 pakai 6–7s dengan **satu arc gerakan lambat** + static/slow push-in. Jangan pakai timestamp (`at 3s`) — LTX butuh urutan temporal.

**Mapping dari struktur lama (6 scene):** S1+S2 → **Scene 1** `hook_context` · S3+S4 → **Scene 2** `reveal_demo` · S5 CTA → **dihapus** (CTA via VO) · S6 → **Scene 3** `product_hero`.

---

## `audio_mode: hybrid` & `audio_segments` (wajib scene 1–2)

Scene gabungan pakai `audio_mode: "hybrid"` + `audio_segments[]` — **2 segmen per scene**, waktu ascending, sum `duration_s` = `scenes[].duration_seconds`.

### Scene 1 — `hook_context`

| `segment_id` | Durasi | `mode` | TalkVid | `lip_sync_segment` |
|--------------|--------|--------|---------|-------------------|
| `hook` | 3.0s | `talking_head` (default) | `true` | Punch line — **wajib** |
| `context` | 4.0s | **`voiceover_only` (default)** atau `talking_head` | `false` jika VO | `""` jika VO |

**Default stabil:** `talking_head` (hook) + `voiceover_only` (context). Hindari dua dialog dalam satu klip (lip sync lemah). `scenes[0].talkvid` = `true` jika hook = talking_head. `audio_start` scene 1 = `0`.

### Scene 2 — `reveal_demo`

| `segment_id` | Durasi | `mode` | TalkVid | `lip_sync_segment` |
|--------------|--------|--------|---------|-------------------|
| `reveal` | 3.0s | Lihat tabel mode bawah | `false` | `""` untuk wearable/kids |
| `demo` (alias `demo_detail`) | 4.0s | `b_roll` (default) | `false` | `""` |

| `product_display_mode` | `reveal.mode` | `demo.mode` |
|------------------------|---------------|-------------|
| `wearable` | `voiceover_only` + full body pose | `b_roll` — detail kain saat dipakai |
| `wearable_kids` | `voiceover_only` + mannequin anak | `b_roll` — detail print/bahan |
| `handheld` / `object` | `voiceover_only` **atau** `talking_head` | `b_roll` — tangan + produk |

**Semua mode scene 2:** `talkvid: false` di level scene — tanpa kutip/dialog di `ltx_prompt`. `audio_start` scene 2 = `7.0`.

### Scene 3 — `product_hero`

`audio_mode: b_roll`; `audio_segments: []`; `talkvid: false`; `audio_start: 14.0`. CTA/penutup VO boleh overlap akhir scene 2 / awal scene 3 (atur di stitch).

### Skema `audio_segments[]` per segmen

```json
{ "segment_id": "hook", "segment_type": "hook", "offset_in_scene_s": 0, "duration_s": 3.0, "mode": "talking_head", "talkvid": true, "lip_sync_segment": "Kalau teman setia selalu ada, ini salah satunya", "vo_offset_in_full_tts_s": 0 }
```

| Field | Wajib | Keterangan |
|-------|-------|------------|
| `segment_id` | ✅ | `hook` \| `context` \| `reveal` \| `demo` |
| `segment_type` | ✅ | Sama dengan `segment_id` (alias `demo_detail` untuk `demo`) |
| `offset_in_scene_s` | ✅ | Mulai segmen dalam klip (0-based) |
| `duration_s` | ✅ | Sum = `scenes[].duration_seconds` |
| `mode` | ✅ | `talking_head` \| `voiceover_only` \| `b_roll` |
| `talkvid` | ✅ | `true` hanya jika `mode: talking_head` |
| `lip_sync_segment` | Kondisional | Wajib jika `talking_head`; `""` jika VO/b_roll |
| `vo_offset_in_full_tts_s` | ✅ | Offset di full TTS untuk trim audio ComfyUI |

Offset standar: hook `0` → context `3.0` → reveal `7.0` → demo `10.0`. **Backend TalkVid:** scene 2–3 `talkvid: false` wajib (override segmen); workflow = satu audio trim per scene.

---

## Produk wearable / apparel (`product_display_mode: wearable`)

Wajib jika kategori = pakaian, fashion, outfit, hijab dipakai, jaket, kaos, dress.

| Rule | Nilai |
|------|--------|
| **Scene 1** | Talent **belum** pakai produk (outfit netral harian); chest-up; hook & konteks |
| **Scene 2 `reveal`** | Pertama kali memakai produk; `mode: voiceover_only`; **full/three-quarter body**, bergaya, outfit terbaca kepala–kaki |
| **Scene 2 `demo`** | Tetap memakai outfit sama; `mode: b_roll`; satu gerakan kain (pinch-release kerah) |
| **`outfit_lock`** | Garment produk; reveal + demo identik |
| **Scene 3** | Produk **tanpa talent** — dipajang utuh di **hanger** atau **mannequin**; **jangan dilipat** |
| **Larangan** | Memegang baju/hanger, bicara ke kamera, dialog kutip di `ltx_prompt`, pose runway, spin 360°, folded/flat lay |

`product_hero_surface` wearable: `wooden hanger on wall hook, garment hanging full length` (default) atau `faceless dress form mannequin torso, garment dressed full display`. **Dilarang** folded/flat lay.

`product_interaction`: `none` (scene 1,3) · `wearing_pose` (scene 2 reveal) · `wearing` (scene 2 demo). `hold_brief` **dilarang** untuk apparel.

---

## Pakaian anak (`product_display_mode: wearable_kids`)

Wajib jika produk = pakaian/setelan **anak** (bayi, balita, kids, tween).

| ❌ Dilarang | ✅ Ganti dengan |
|------------|-----------------|
| Talent dewasa memakai baju anak | Produk dipajang di **small faceless child mannequin** |
| `outfit_lock` = garment anak di badan dewasa | `outfit_lock` = outfit netral dewasa scene 1 saja |
| Scene CTA talking_head pakai setelan anak | CTA **VO saja** — tanpa talent |
| Anak kecil sebagai model (kecuali user supply ref) | Mannequin anak tanpa wajah |

| scene_id | Talent? | Produk | `audio_mode` | `use_model_reference` |
|----------|---------|--------|--------------|------------------------|
| 1 | Ya — orang tua/reviewer | Tidak dipakai | `hybrid` | `true` |
| 2 | Tidak | Mannequin anak reveal + demo | `hybrid` (reveal VO; demo b_roll) | **`false`** |
| 3 | Tidak | Hero mannequin full display | `b_roll` | **`false`** |

**TalkVid:** hanya segmen `talking_head` scene 1. `product_interaction`: `none` (1) · `product_display` (2,3).

`talent_identity` kids: `ethnicity: Indonesian`; `prompt` = orang tua/reviewer dewasa Indonesia (mis. *young Indonesian mother*) + `{PHRASE_ID}` — **bukan** anak; `outfit_lock` = pakaian dewasa netral scene 1, eksplisit *never wear the children's product on the adult body*.

`product_hero_surface` kids: `small faceless child mannequin, kids outfit dressed full display` (default) atau `child-sized wooden hanger`.

**Frasa wajib scene 2–3 (mannequin):**
```text
small faceless child-sized mannequin wearing or displaying the exact children's outfit from the product reference, complete kids garment visible with accurate print and color, natural standing display pose — no real person, no child face, no adult wearing kids clothes, not folded, not flat lay
```

---

## Framing per scene

### Talking head (scene 1 hook/context)
`medium close-up, chest-up, subject centered, face clearly visible, direct eye contact with the camera, eyes locked on lens`. **Mata ke kamera wajib** (bukan ke samping/bawah). Segmen `hook` (dan `context` jika talking_head): kutip **verbatim**. Larangan: extreme close-up, wajah tertutup produk, paraphrase (`asking about`, `speaking about`), mata menghindar.

### Scene 2 reveal (wearable)
`full body wearing pose, {PHRASE_BODY}, complete outfit visible, confident styling movement, not speaking to camera`. Shot full/three-quarter, garment terbaca kepala–kaki, posture tegak confident. Kamera **static** (biar tubuh bergerak). Larangan: extreme wide, bicara ke kamera, holding garment, slouchy/awkward, candid snapshot, runway/spin.

### Scene 2 demo
`hands_product_medium_close` (default) atau `wearing_detail_medium_close` (wearable: detail pada badan, satu gerakan fabric, static).

### Scene 3 (product hero)
Hanya produk, tanpa talent/wajah. **object/handheld:** produk di `product_hero_surface` (desk/counter). **wearable:** hanger full hang **atau** faceless mannequin torso, garment utuh — bukan folded/flat lay. Shot semi close-up (bentuk/warna/proporsi terbaca). Eye-level atau slight 3/4. Soft natural daylight, mood sama scene sebelumnya. **Very slow continuous push-in** (default) — hindari `holds calmly`/static penuh (drift kartun). `use_model_reference: false`, `use_product_reference: true`.

---

## `talent_identity` & `product_identity`

Target pasar Indonesia → talent **wajib** terlihat orang Indonesia.

| Field | Aturan |
|-------|--------|
| `ethnicity` | Default `"Indonesian"` — eksplisit di setiap response |
| `talent_identity.prompt` | Wajib `{PHRASE_ID}` + `warm brown skin typical of Indonesian people`, `real smartphone UGC`, `natural skin texture` — bukan glamour/model pro. Wearable: tambah `{PHRASE_BODY}` |
| `image_negative_avoid` | Wajib = `{NEG_STUDIO}` (dipakai backend saat generate portrait talent step 1) |
| `outfit_lock` | Wearable: deskripsi **garment produk**. Kids: pakaian dewasa netral scene 1 |
| `product_identity.prompt` | Warna, bahan, potongan, pattern |

**Contoh `talent_identity.prompt` (wanita, hijab):** *Indonesian woman in her mid-twenties, Southeast Asian facial features, warm brown skin, natural Indonesian appearance, soft dark brown hair under a simple neutral hijab, plain cream ribbed top, friendly everyday UGC creator, chest-up portrait, soft natural window daylight, real smartphone UGC photo, natural skin texture, authentic not glamour.*

Backend step 1: portrait talent digenerate dari `talent_identity.prompt`; jika tidak menyebut etnis Indonesia, model drift ke wajah non-Indonesia.

---

## Image generation (`meta.image_generation`)

| `use_model_reference` | `use_product_reference` | `product_image_count` | `image[]` |
|----------------------|---------------------------|----------------------|-----------|
| `true` | `true` | `1` | `[talent, product_0]` — scene 1–2 default |
| `true` | `true` | `2` | `[talent, product_0, product_1]` |
| `false` | `true` | `1` | `[product_0]` — **wajib scene 3** |
| `false` | `true` | `2` | `[product_0, product_1]` — scene 3, 2 sudut |

**Default scene 1–2:** model + product true. **Scene 3:** model false, product true. *(Definisi field lengkap ada di schema JSON — lihat blok `meta.image_generation` di bawah.)*

### Isi `image_prompt` (first frame per scene)

Bahasa **Inggris**. Struktur wajib dua bagian: `REFERENCE IMAGES` → `SCENE`. **Jangan** sebut `9:16`/`vertical`/`1024x1536`/resolusi.

Setiap `SCENE` wajib mengarah ke foto hasil kamera HP. Wajib sertakan frasa positif `{TAIL_PHONE}` di blok `SCENE`. Scene 2 reveal wearable: tambah `{PHRASE_BODY}`. **Dilarang:** `candid`, `casual snapshot`, `relaxed slouchy try-on` (terutama full body). `negative_prompt` semua scene wajib memuat `{NEG_STUDIO}`; scene 1–2 tambah `{NEG_ETHNIC}`.

**`REFERENCE IMAGES` — talent + produk (`product_image_count: 1`):**
```text
REFERENCE IMAGES: The first attached image is the talent (model) reference — keep the same Indonesian face, ethnicity, hair, skin tone, and outfit. The second attached image is the product reference — keep the exact product shape, color, packaging, and labels. Do not swap or mix references. Output one single continuous photograph only — not a panel, grid, or collage.
```
**(`product_image_count: 2`):** tambah kalimat ketiga — `The third attached image is the secondary product reference — use for additional angles, back view, detail texture, or print close-up; both product images depict the same product.`

**Wearable scene 2 (apply garment):** tambah pada blok produk — `apply it as the complete outfit worn on the talent's body with exact color, pattern, and fit; natural drape. Do not show garments held in hands.`

**Wearable_kids scene 2–3 (mannequin):** ganti talent dengan — `apply the exact product onto a small faceless child mannequin with accurate color, print, and fit. Do not add any real person, adult, child face, or hands.`

**`REFERENCE IMAGES` — scene 3 (produk saja, count 1):**
```text
REFERENCE IMAGES: The first attached image is the product reference — keep the exact product shape, color, packaging, and labels identical. Do not add a person, hands, or face. Output one single continuous photograph only — not a panel, grid, or collage.
```
**(count 2):** tambah `The second attached image is the secondary product reference — use for back view, detail texture, or component confirmation; both depict the same product.`

**`SCENE` template umum:**
```text
SCENE: One single full-frame photograph. [environment_lock], soft natural daylight. [framing + pose + produk/talent per scene]. Indonesian talent with natural Southeast Asian features, warm brown skin. {TAIL_PHONE} No on-screen text, signage, UI, watermark, or split layout.
```

**Scene 1 talking head — anti-AI-perfect (target realistis):** outfit **netral harian** (bukan produk), ekspresi **mid-speech** (mulut sedikit terbuka, alis skeptis playful), kulit **natural texture**, background **lived-in** (rak kayu/tanaman, shallow DOF), **window daylight** + warm fill. `negative_prompt` scene 1 tambah: `fashion catalog, symmetrical influencer pose, big staged smile, waving at camera, empty gray wall, sterile minimalist room, glossy fabric, overly saturated, wearing product garment in scene 1, looking away from camera, eyes averted, looking down, side glance, off-camera gaze`.

**`SCENE` scene 3 (object):**
```text
SCENE: One single full-frame photograph. [environment_lock], soft natural daylight. Semi close-up product hero: the [product_name] standing or placed naturally on [product_hero_surface], product centered, slight 3/4 angle, clean background. No person, no hands, not flat lay top-down. No text, UI, or watermark.
```
**`SCENE` scene 3 (wearable):**
```text
SCENE: One single full-frame photograph. [environment_lock], soft natural daylight. Semi close-up product hero: the [product_name] hanging at full length on a wooden hanger against a plain wall OR displayed on a faceless dress form mannequin torso, complete garment silhouette and drape visible, fabric color and texture clear. No person, no hands, not folded, not stacked, not worn on a real human body, not flat lay top-down. No text, UI, or watermark.
```

---

## CAPTION GENERATOR (`meta.caption`)

Generate caption TikTok, Shopee, Instagram. Conversion-focused, standalone persuasive, bisa dipahami tanpa menonton video.

```json
"caption": { "tiktok": "", "shopee": "", "instagram": "" }
```

---

## `ltx_prompt` & `ltx_negative_prompt` (LTX I2V — `guide_ltx.md`)

- Bahasa **Inggris**, **4–6 kalimat**, tone di depan, **satu arc aksi** + static / very slow push-in
- I2V: deskripsikan **perubahan temporal**, bukan ulang statis; jangan timestamp

### Pemisahan positif vs negatif (wajib)

| Field | Isi | Larangan |
|-------|-----|----------|
| `ltx_prompt` | Hanya **positif**: aksi, ekspresi, kamera, lighting, kutipan lip sync | `no/not/without/never`, `TikTok`, `UGC`, `subtle natural lip movement` |
| `ltx_negative_prompt` | Semua larangan visual/artefak | `no lip movement`, `no text`, `not holding clothes`, `no person`, dll. |
| `negative_prompt` | Untuk **image gen** (OpenAI) — boleh negatif | bukan untuk LTX positive prompt |
| `avoid` | Metadata QA, digabung backend ke `ltx_negative_prompt` | jangan salin ke `ltx_prompt` |

**Backend `buildLtxPromptFields()`:** otomatis buang `TikTok`/`UGC`, pindah klausa negatif → `ltx_negative_prompt`, ganti `subtle natural lip movement` → frasa kuat, hapus `starts with … smile and speaks` → `speaks` langsung, hapus kutip dialog jika `talkvid: false`.

### Aturan lip sync / `talking_head` (gabungan — wajib)

LTX memicu gerak bibir hanya jika **bicara = aksi langsung + kutipan**, bukan deskripsi nada. Pola wajib = `{SPEAKS}` (atau minimal `The talent speaks "[quote]" with clear lip movement fully in sync with the spoken line`).

| Pola | Status |
|------|--------|
| `...eyes locked on lens and speaks "[quote]"` | ✅ Terkuat |
| `The talent speaks "[quote]"` / `speaks "[quote]"` langsung | ✅ Kuat / wajib |
| `with clear lip movement fully in sync with the spoken line` | ✅ Wajib (pada kalimat kutip) |
| `starts with a (playful/amused) smile and speaks`, `begins with a smile` **sebelum** `speaks` | ❌ Mematikan lip sync — dilarang |
| `speaks in a … tone/manner`, `while speaking`, `conversational tone` | ❌ Khiasan — dilarang |
| `asking about`, `questioning whether`, `speaks about`, `introducing`, `delivers a line` | ❌ Paraphrase — dilarang |
| `subtle natural lip movement` | ❌ Lemah — dilarang |

Aturan tambahan: kutip `lip_sync_segment` **verbatim** dalam `"..."` langsung setelah `speaks`. Ekspresi/smile hanya **setelah** kutipan. **Mata ke kamera wajib** di `image_prompt` + `ltx_prompt` scene 1. **Scene 1 hanya satu kutipan** (= `audio_segments[hook].lip_sync_segment`) — larangan kutip kedua / `continues:` / `then speaks`. Jangan tulis frasa negatif bibir di `ltx_prompt` — taruh di `ltx_negative_prompt`. Konteks VO diatur via `audio_segments[context].mode: voiceover_only`.

### Petunjuk per `scene_type`

| scene_type | Audio | Gerakan / kamera |
|------------|-------|------------------|
| `hook_context` | `hook`: talking_head; `context`: voiceover_only (default) | Mata ke kamera + punch line kutip + lip sync → transisi skeptis + gesture; tetap eye contact |
| `reveal_demo` | `reveal`: voiceover_only wajib; `demo`: b_roll | Reveal **tanpa lip sync** → demo detail; `talkvid: false` |
| `product_hero` | b_roll | Static/slow push-in produk |

### `ltx_negative_prompt` — contoh isi

- **Scene 1 (talking head):** `no lip movement, no lip sync, no speaking to camera, listening to voiceover, no speech, subtle natural lip movement, looking away from camera, eyes averted, looking down, off-camera gaze, on-screen text, logos, UI, watermark, morphing, flicker, extreme close-up, product covering mouth`
- **Scene 2 (no lip sync — wajib):** `speech, lip sync, dialogue in quotes, speaking to camera, mouth movement, holding clothes, runway pose, dramatic spin, frozen mannequin pose, slouchy posture, only camera movement, on-screen text, UI, morphing, flicker, cartoon, illustration`
- **Scene 3 (anti-drift/kartun):** `person, hands, face, woman, man, human, folded garment, flat lay pile, speech, cartoon, illustration, sketch, anime, comic, cel-shaded, storyboard, furniture, on-screen text, logos, UI, studio catalog look, morphing, flicker, style change, scene cut`

**Scene 3 anti-drift:** hapus `matching the bedroom from earlier scenes` (bisa menarik wajah dari scene 1), pakai **satu** arc `camera performs a very slow continuous push-in` (bukan `static with push-in` yang kontradiktif).

### Contoh `ltx_prompt`

**Scene 1 (hook_context, 7s):**
```text
Realistic documentary-style footage, soft natural daylight. Medium close-up chest-up, subject centered, static handheld framing. The talent looks directly into the camera with direct eye contact, eyes locked on lens and speaks "Kalau tunik, aku pilih Fahira," with clear lip movement fully in sync with the spoken line. The expression shifts to skeptical curiosity with a slight head tilt and one small natural hand gesture while maintaining eye contact with the camera. Faint room ambience. Photorealistic.
```

**Scene 2 (reveal_demo, wearable, 7s):**
```text
Realistic documentary-style fashion footage, soft natural daylight. Full body shot, camera static. The talent with ideal well-proportioned physique wears the exact outfit from the product reference and stands with compelling confident posture, shifting weight slightly while turning the shoulders to show a flattering full outfit silhouette. The talent then brings one hand to the collar and lightly pinches and releases the fabric once in a single smooth motion to show texture and drape on the body. Faint room ambience. Photorealistic throughout.
```

**Scene 2 (handheld, VO reveal + b_roll demo):**
```text
Realistic documentary-style footage, soft natural daylight. Medium close-up chest-up, subject centered. The talent raises the tumbler to chest level with a calm natural expression, lips relaxed, not speaking to camera. The shot transitions to a medium close-up of hands and product as one hand lightly touches the lid to show the temperature indicator while the tumbler stays stable on the desk. Camera static throughout. Photorealistic.
```

**Scene 3 (product_hero, wearable, 6s):**
```text
Realistic documentary-style footage, soft natural daylight. Semi close-up product hero shot of the garment hanging at full length on a wooden hanger against a plain wall, complete silhouette and fabric drape centered in frame. The camera performs a very slow continuous push-in toward the hanger as soft daylight gradually shifts across the fabric and the hem sways almost imperceptibly. Faint room ambience. Photorealistic fashion display throughout.
```

**Scene 3 (product_hero, object):**
```text
Realistic documentary-style footage, soft natural daylight. Semi close-up product hero shot on a clean wooden desk, product centered against a plain uncluttered wall. The camera performs a very slow continuous push-in toward the product as soft daylight gradually shifts across the surface and a faint shadow edge moves slowly across the desk. Faint room ambience. Photorealistic product showcase throughout.
```

---

## Skema JSON (kontrak backend — sumber kebenaran)

```json
{
  "meta": {
    "spec_variant": "ugc2_product_hero_close",
    "video_type": "UGC Native + Product Showcase (Product Hero Close)",
    "platform": "TikTok",
    "duration_seconds": 20,
    "aspect_ratio": "",
    "orientation": "",
    "language": "id",
    "audio_delivery_mode": "hybrid",
    "cta_spoken": "klik keranjang kuning",
    "continuity_mode": "reference_only",
    "scene_count": 3,
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
    "product_audience": "",
    "product_hero_surface": "",
    "caption": {},
    "performance": {
      "emotion_tone": "penasaran → yakin → puas → tenang showcase",
      "energy_level": "medium",
      "pacing": "fast hook, demo jelas, CTA singkat, tutup tenang product hero",
      "acting_style": "authentic TikTok review"
    },
    "stitch": {
      "enabled": true,
      "workflow": "comfyui",
      "target_seconds": 20,
      "ltx_clips_sum_seconds": 20,
      "clip_order": "scene_id ascending",
      "note": "3 LTX clips 7+7+6=20s concat; no pad; scene 2→3 hard cut; CTA via VO only"
    },
    "image_generation": {
      "api": "openai_v1_images_edits",
      "model_recommended": "gpt-image-2",
      "aspect_ratio": "9:16",
      "size": "1024x1536",
      "size_map_note": "Backend ONLY: map meta.aspect_ratio → API size. Never put aspect ratio, orientation, or pixel dimensions in image_prompt.",
      "product_image_count": 1,
      "reference_attach_order": ["talent", "product_1", "product_2"],
      "reference_roles": { "image_1": "talent", "image_2": "product_primary", "image_3": "product_secondary_optional" },
      "product_hero_scene_id": 3,
      "product_hero_attach": "product_only",
      "single_frame_rule": "One continuous photograph. No panels, grids, collage.",
      "anti_studio_negative": "stock photo, catalog photo, studio lighting, commercial photography, beauty retouching, flawless skin, magazine shoot, fashion campaign, professional model, glamour portrait, CGI, 3D render, tabloid photo, airbrushed skin, porcelain skin, editorial fashion, catalog look, professional studio backdrop, plastic skin, perfect symmetry",
      "talent_ethnicity_default": "Indonesian — Southeast Asian facial features, warm brown skin, natural Indonesian appearance",
      "ltx_first_frame_rules": "Center composition, consistent lighting, simple background, no text/signage"
    },
    "ltx_generation": {
      "model": "ltx-2.3",
      "guide_primary": "guide_ltx.md",
      "input_mode": "image_to_video",
      "prompt_language": "en",
      "max_clip_seconds": 7,
      "talkvid_scenes": [1],
      "no_talkvid_scenes": [2, 3],
      "hybrid_audio_scenes": [1, 2],
      "talkvid_note": "TalkVid only if scene 1 has talking_head audio_segments; scene 2-3 never TalkVid"
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
    "image_negative_avoid": "",
    "ethnicity": "Indonesian",
    "gender": "male",
    "age_range": "",
    "outfit_lock": "",
    "hair_lock": ""
  },
  "product_identity": { "prompt": "", "name": "", "color": "", "shape": "", "material": "", "packaging": "" },
  "scenes": [
    {
      "scene_id": 1, "scene_name": "Hook & Konteks", "scene_type": "hook_context",
      "duration_seconds": 7.0, "audio_mode": "hybrid", "audio_start": 0, "talkvid": true,
      "framing": "chest_up_close", "product_interaction": "none", "lip_sync_segment": "",
      "audio_segments": [
        { "segment_id": "hook", "segment_type": "hook", "offset_in_scene_s": 0, "duration_s": 3.0, "mode": "talking_head", "talkvid": true, "lip_sync_segment": "", "vo_offset_in_full_tts_s": 0 },
        { "segment_id": "context", "segment_type": "context", "offset_in_scene_s": 3.0, "duration_s": 4.0, "mode": "voiceover_only", "talkvid": false, "lip_sync_segment": "", "vo_offset_in_full_tts_s": 3.0 }
      ],
      "consistency": { "use_model_reference": true, "use_product_reference": true, "continuity_mode": "reference_only", "continuity_image_from": null },
      "image_prompt": "", "negative_prompt": "", "ltx_prompt": "", "ltx_negative_prompt": "",
      "camera": "static chest-up",
      "avoid": "extreme close-up, product covering mouth, paraphrased dialogue, second quoted dialogue, no lip movement, subtle natural lip movement, looking away from camera, eyes averted"
    },
    {
      "scene_id": 2, "scene_name": "Reveal & Demo", "scene_type": "reveal_demo",
      "duration_seconds": 7.0, "audio_mode": "hybrid", "audio_start": 7.0, "talkvid": false,
      "framing": "full_body_wearing_pose", "product_interaction": "wearing_pose", "lip_sync_segment": "",
      "audio_segments": [
        { "segment_id": "reveal", "segment_type": "reveal", "offset_in_scene_s": 0, "duration_s": 3.0, "mode": "voiceover_only", "talkvid": false, "lip_sync_segment": "", "vo_offset_in_full_tts_s": 7.0 },
        { "segment_id": "demo", "segment_type": "demo_detail", "offset_in_scene_s": 3.0, "duration_s": 4.0, "mode": "b_roll", "talkvid": false, "lip_sync_segment": "", "vo_offset_in_full_tts_s": 10.0 }
      ],
      "consistency": { "use_model_reference": true, "use_product_reference": true, "continuity_mode": "reference_only", "continuity_image_from": null },
      "image_prompt": "", "negative_prompt": "", "ltx_prompt": "", "ltx_negative_prompt": "",
      "camera": "static or very slow push-in",
      "avoid": "holding clothes, speaking to camera, lip sync, dialogue in quotes, speech, mouth movement"
    },
    {
      "scene_id": 3, "scene_name": "Product Hero", "scene_type": "product_hero",
      "duration_seconds": 6.0, "audio_mode": "b_roll", "audio_start": 14.0,
      "framing": "product_semi_close", "product_interaction": "product_display", "lip_sync_segment": "",
      "audio_segments": [],
      "consistency": { "use_model_reference": false, "use_product_reference": true, "continuity_mode": "reference_only", "continuity_image_from": null },
      "image_prompt": "", "negative_prompt": "", "ltx_prompt": "", "ltx_negative_prompt": "",
      "camera": "static or very slow push-in on product",
      "avoid": "real person, child face, human hands, folded garment, flat lay pile, text, UI"
    }
  ]
}
```

`scenes` wajib length **3**, `scene_id` 1–3 unik. Scene 1–2: `audio_mode: hybrid` + `audio_segments[]` length 2 (sum `duration_s` = `duration_seconds`).

**Scene 2 `framing` per mode:** `wearable` → `full_body_wearing_pose` · `wearable_kids` → `product_mannequin_display` · `handheld`/`object` → `chest_up_close` / `hands_product_medium_close`.

**`use_model_reference` (wearable_kids):** scene 1 `true`; scene 2–3 `false`.

**`product_interaction`:** `none` (1,3 semua mode) · `wearing_pose` (2 reveal, wearable) · `wearing` (2 demo, wearable) · `product_display` (2,3 kids) · `in_use` (2 demo, non-wearable). `hold_brief` dilarang untuk apparel.

---

## Backend pseudocode

```text
for each scene in scenes:
  files = []
  if scene.consistency.use_model_reference: files.push(talent_image)
  if scene.consistency.use_product_reference:
    files.push(product_images[0])
    if meta.image_generation.product_image_count == 2: files.push(product_images[1])
  size = map_aspect_ratio_to_size(meta.aspect_ratio)  // API param only
  POST /v1/images/edits { image: files, prompt: scene.image_prompt, size }
  assert scene.duration_seconds <= meta.ltx_generation.max_clip_seconds  // 7
  assert sum(scenes.duration_seconds) == 20
  if scene.audio_mode == "hybrid":
    assert scene.audio_segments.length == 2
    assert sum(segment.duration_s) == scene.duration_seconds
  if meta.product_display_mode == wearable_kids:
    assert scene_id in [2,3] implies use_model_reference == false
  else:
    assert scene_id == 3 implies use_model_reference == false

clips = []
for scene in scenes sorted by scene_id:
  has_talkvid = scene.talkvid !== false
    && scene.scene_type not in ["reveal_demo", "product_hero"]
    && (scene.talkvid === true || scene.audio_segments?.some(s => s.talkvid === true || s.mode === "talking_head"))
  built = buildLtxPromptFields(scene)
  clips.push(LTX_I2V {
    init_image: first_frame[scene_id], prompt: built.ltx_prompt,
    negative_prompt: built.ltx_negative_prompt || scene.ltx_negative_prompt,
    duration_seconds: scene.duration_seconds, talkvid: has_talkvid,
    audio_start: scene.audio_start, audio_segments: scene.audio_segments
  })

final = ComfyUI_Stitch(clips, target_seconds: 20)

// TTS voice resolve
gender = voiceover_script.gender
pool = voiceover_script.allowed_voices[gender]
mode = input.voice_selection_mode ?? voiceover_script.voice_selection_mode ?? "llm_cast"
if mode == "user_pick" && input.preferred_voice: voice = input.preferred_voice
else if mode == "random": voice = pool[random_index(pool)]
else: voice = voiceover_script.voice_name
assert voice in pool
POST TTS { voice_name: voice, script: voiceover_script.tts_script }  // must start with [fast]
assert voiceover_script.tts_script.startsWith("[fast] ")
```

---

## Checklist sebelum emit JSON (rule yang LLM sering salah)

- [ ] Output = pure JSON; `meta.spec_variant` = `ugc2_product_hero_close`; **3 scenes**, sum duration = 20 (7+7+6)
- [ ] `audio_start`: scene 1 = 0, scene 2 = 7.0, scene 3 = 14.0; `audio_segments` sum `duration_s` = `duration_seconds`, `vo_offset` ascending
- [ ] Scene 1: `talkvid: true`, hook = `talking_head`, context = `voiceover_only`; mata ke kamera; **satu** kutipan saja
- [ ] Scene 1 `ltx_prompt` pola `{SPEAKS}` — **tanpa** `starts with a smile` sebelum `speaks`; `clear lip movement fully in sync` (bukan `subtle natural lip movement`)
- [ ] Scene 2–3: `talkvid: false`; reveal = `voiceover_only`; `ltx_prompt` tanpa kutip/dialog
- [ ] Scene 2 reveal wearable: full body, `{PHRASE_BODY}`, `lip_sync_segment: ""`
- [ ] Scene 3: `use_model_reference: false`, produk saja, semi close-up, no person/hands; wearable = hanger/mannequin full display (bukan folded)
- [ ] `product_display_mode` terisi; pakaian anak = `wearable_kids` + `product_audience: children`, mannequin anak tanpa wajah, dewasa **tidak** memakai produk anak
- [ ] `ltx_prompt` positif saja (tanpa `no/not`, `TikTok`/`UGC`); larangan di `ltx_negative_prompt`; `ltx_negative_prompt` terisi per scene
- [ ] `negative_prompt` semua scene memuat `{NEG_STUDIO}`; scene 1–2 tambah `{NEG_ETHNIC}`; `talent_identity.image_negative_avoid` = `{NEG_STUDIO}`
- [ ] `talent_identity.prompt` menyebut `{PHRASE_ID}`; talent terlihat orang Indonesia
- [ ] `image_prompt` tanpa aspect ratio/resolusi; blok `SCENE` memuat `{TAIL_PHONE}`; tanpa `candid`/`casual snapshot`
- [ ] `voiceover_script` dibuka punch line lucu bodoh (5–8 kata); `skeptic_bridge_opener` terisi, **bukan** default `Jujur`
- [ ] `voice_name` ∈ `allowed_voices[gender]`, sesuai tone (bukan default Puck/Aoede); `gender` = `talent_identity.gender`
- [ ] `tts_script` = `[fast] ` + `script`; `word_count` dari `script` saja (29–35); CTA di script (VO only)

---

## Contoh input backend → LLM

```json
{ "product_description": "Kemeja linen oversized sage, bahan adem, cocok daily outfit...", "talent_image": "<file>", "product_images": ["<file_front>", "<file_detail>"], "aspect_ratio": "9:16" }
```
```json
{ "product_description": "UP Trendy setelan anak denim Mario Bros, kaos + celana pendek, usia 3-6...", "talent_image": "<file>", "product_images": ["<file_set>", "<file_print>"], "aspect_ratio": "9:16" }
```

Response LLM = **hanya** objek JSON (3 scene terisi penuh + `audio_segments`).

- **Apparel dewasa** (`wearable`): scene 2 reveal full body + demo wearing; scene 1 hook+konteks hybrid.
- **Pakaian anak** (`wearable_kids`): scene 1 orang tua talking head; scene 2–3 mannequin anak tanpa wajah; CTA VO only.
- **Handheld/object:** scene 2 boleh campur `talking_head` reveal + `b_roll` demo dalam satu klip 7s.