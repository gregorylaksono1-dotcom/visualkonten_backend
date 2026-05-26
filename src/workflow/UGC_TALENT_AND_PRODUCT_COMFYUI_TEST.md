# UGC talent → product (production workflow)

## Files

| File | Use |
|------|-----|
| **`ugc_talent_and_product (API).json`** | Backend `UGC-P` 2-frame video (production) |
| **`ugc_talent_and_product.json`** | ComfyUI UI / manual test |
| `ugc_product_camera_movement (API).json` | Legacy — kept unchanged |
| `product_only_camera_movement.json` | Product-only ads — unchanged |

## LLM → images

| Field | Node | Role |
|-------|------|------|
| `image_generation.talent_frame` | **440** | first_frame — medium UGC + product |
| `image_generation.product_frame` | **441** | last_frame — **progressive** closer (§1c `PROMPT_UGC_PRODUCT`) |

Generate **product_frame** first, then **talent_frame** (both prompts fully standalone).

## Workflow tweaks vs legacy `ugc_product_camera_movement`

1. **TalkVid LoRA** strength **0.55** (was 1.0) — less face lock through whole clip.
2. **First frame** `LTXVImgToVideoInplace` strength **0.5** (was 0.6).
3. **Mid AddGuide** `478:341` at **~50%** of latent length (`floor(length * 0.5)`), product image, strength **0.5** — pulls transition earlier.
4. **Last AddGuide** `478:340` at **frame -1**, strength **0.8**, chained after mid guide.

## Prompt

- `PROMPT_UGC_PRODUCT` §1c progressive keyframes + §2c phased `ltx_prompt` (lip-sync phase A only).
- ComfyUI reads **`ltx_prompt`** only; second marks are guidance — keyframe continuity matters most.

## Manual test

1. Load **`ugc_talent_and_product.json`** in ComfyUI (or API JSON on cloud).
2. Set **440** = talent image, **441** = product image, **611** = TTS, **614** = `ltx_prompt`.
3. Expect transition to product-heavy framing from **~40–55%** of duration, not only the last second.
