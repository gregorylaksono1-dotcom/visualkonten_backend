# Prompt refactor — 3-layer modular, 1× LLM

Prompt lama (`PROMPT_UGC_*`) dipecah ke file terpisah per fase. Saat runtime, ketiga layer **digabung** jadi satu system prompt → **satu panggilan LLM** (sama biaya/latensi dengan monolitik).

File lama di `prompt/` tetap ada sebagai fallback saat `USE_PROMPT_REFACTOR` tidak aktif.

## Alur (internal ke LLM)

```
User input
    → Phase 1 planning (visual, lighting, camera, mood, pacing)
    → Phase 2 script (voiceover, CTA, overlays)
    → Phase 3 composer (final JSON pipeline)
         ↓
    Hanya JSON Phase 3 yang dikembalikan
```

## Variants

| Folder | Menggantikan | Catatan |
|--------|--------------|---------|
| `ugc_product/` | `PROMPT_UGC_PRODUCT` | Talking head + produk, `{selling_mode}` |
| `ugc_store_offline/` | `PROMPT_UGC_STORE_OFFLINE` | Kunjungan toko fisik + tas belanja |
| `ugc_store_online/` | `PROMPT_UGC_STORE_ONLINE` | Promo e-commerce, opsi Pixar 3D |
| `product_no_talent/` | `PROMPT_PRODUCT` | Iklan produk tanpa talent |

## Aktifkan

```bash
USE_PROMPT_REFACTOR=true
```

SAM deploy: `--parameter-overrides UsePromptRefactor=true`

Worker: `core/ugcLlm.js` → `runPromptRefactor()` → `buildMergedSystemPrompt()`:
`MERGE_ORCHESTRATOR` + `WORD_COUNT` + `GEMINI_VOICES` + layer1 + layer2 + layer3.

Lihat `manifest.json` untuk daftar file per variant.
