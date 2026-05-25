# Product 2-Frame ComfyUI Test (manual)

Workflow: **`product_only_camera_movement.json`**

For UGC talking-head jobs, use **`Generate UGC Video With Voice Clone.json`** (single image, unchanged).

## LLM output → two images

| JSON field | ComfyUI node | LTX role |
|------------|--------------|----------|
| `image_generation.reveal_start_frame` | **Load Image 440** (first_frame) | Frame 0 — occluded start |
| `image_generation.hero_frame` | **Load Image 441** (last_frame) | Frame -1 — clear hero |

Generate **hero_frame first** (anchor identity from product reference), then **reveal_start_frame** (same angle/lighting + foreground blur).

## Wiring inside subgraph (pre-wired in JSON)

1. **first_frame** → Resize 297 → LTXVPreprocess 334 → **LTXVImgToVideoInplace 325** (frame 0).
2. **last_frame** → Resize **337** → LTXVPreprocess **338** → Preview **339** (cek hero).
3. **LTXVAddGuide 340** (`frame_idx` **-1**, `strength` **0.7**): hero image → latent setelah first-frame seed → **LTXVConcatAVLatent 326**.
4. **ltx_prompt** (node 614): timeline 3 fase — A hold reveal (0–15%), B gradual clear (15–45%), C camera motion (45–100%) dengan detik eksplisit; no snap; no orbit.

## Prompt rules

- Single product, same angle in both frames.
- No orbit / circular camera in ltx_prompt.
- Reveal is **compositing/occlusion**, not camera wrap around product.
