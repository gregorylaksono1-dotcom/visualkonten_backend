# UGC-P 2-Frame ComfyUI Test (manual)

**Production (UGC-P):** **`ugc_talent_and_product (API).json`** — see `UGC_TALENT_AND_PRODUCT_COMFYUI_TEST.md`.

**Legacy (unchanged):** `ugc_product_camera_movement (API).json` / `product_only_camera_movement.json`.

For single-image UGC store jobs, use **`Generate UGC Video With Voice Clone (API).json`** (`UGC-S`).

## LLM output → two images

| JSON field | ComfyUI node | LTX role |
|------------|--------------|----------|
| `image_generation.talent_frame` | **Load Image 440** (`first_frame`) | Frame 0 — talent UGC talking + product |
| `image_generation.product_frame` | **Load Image 441** (`last_frame`) | Frame -1 — product hero (dominant) |

Generate **product_frame first** (anchor product identity), then **talent_frame** (same scene_lock in full sentences).

## Wiring (pre-wired in API JSON)

1. **440** → Resize 297 → Preprocess 334 → **LTXVImgToVideoInplace 325** (first frame seed).
2. **441** → Resize **337** → Preprocess **338** → **LTXVAddGuide 340** (`frame_idx` **-1**, `strength` **0.7**).
3. **326** ConcatAVLatent: `video_latent` from **340** (not 325 alone).
4. **614** / **478:319**: `ltx_prompt` — 3 phases (A talent 0–40%, B transition 40–55%, C product motion 55–100%).
5. **611**: TTS audio (lip-sync phase A).

## Prompt rules

- Same environment/light in both still frames (`scene_lock`).
- No orbit in `ltx_prompt`.
- Transition talent → product is **gradual** (phase B), not an instant cut before 55% of duration.
