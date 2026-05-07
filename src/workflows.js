/**
 * Workflow Builder for ComfyUI Cloud
 */

"use strict";

const buildWorkflow = (requestType, { prompt, videoQuality, aspectRatio, uploadedFiles }) => {
  const resolutionMap = { 
    "480p": { w: 854, h: 480 }, 
    "720p": { w: 1280, h: 720 }, 
    "1080p": { w: 1920, h: 1080 } 
  };
  const res = resolutionMap[videoQuality] || resolutionMap["720p"];
  let [w, h] = [res.w, res.h];
  if (aspectRatio === "9:16") [w, h] = [h, w];
  else if (aspectRatio === "1:1") w = h = Math.min(w, h);

  const seed = Math.floor(Math.random() * 1000000000000000);

  // uploadedFiles is an object: { image1: "filename1.png", image2: "filename2.png", ... }

  switch (requestType) {
    case "image-to-image":
    case "image-to-image1":
      // Workflow: Qwen Image Edit (API).json
      return {
        "60": { "inputs": { "filename_prefix": "ComfyUI", "images": ["102:8", 0] }, "class_type": "SaveImage" },
        "78": { "inputs": { "image": uploadedFiles.image1 || "input.png" }, "class_type": "LoadImage" },
        "93": { "inputs": { "upscale_method": "lanczos", "megapixels": 1.5, "resolution_steps": 1, "image": ["78", 0] }, "class_type": "ImageScaleToTotalPixels" },
        "102:39": { "inputs": { "vae_name": "qwen_image_vae.safetensors" }, "class_type": "VAELoader" },
        "102:77": { "inputs": { "prompt": "", "clip": ["102:38", 0], "vae": ["102:39", 0], "image": ["78", 0] }, "class_type": "TextEncodeQwenImageEdit" },
        "102:75": { "inputs": { "strength": 1, "model": ["102:66", 0] }, "class_type": "CFGNorm" },
        "102:66": { "inputs": { "shift": 3, "model": ["102:108", 0] }, "class_type": "ModelSamplingAuraFlow" },
        "102:8": { "inputs": { "samples": ["102:3", 0], "vae": ["102:39", 0] }, "class_type": "VAEDecode" },
        "102:38": { "inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default" }, "class_type": "CLIPLoader" },
        "102:76": { "inputs": { "prompt": prompt, "clip": ["102:38", 0], "vae": ["102:39", 0], "image": ["78", 0] }, "class_type": "TextEncodeQwenImageEdit" },
        "102:88": { "inputs": { "pixels": ["78", 0], "vae": ["102:39", 0] }, "class_type": "VAEEncode" },
        "102:89": { "inputs": { "lora_name": "Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1, "model": ["102:37", 0] }, "class_type": "LoraLoaderModelOnly" },
        "102:37": { "inputs": { "unet_name": "qwen_image_edit_fp8_e4m3fn.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader" },
        "102:105": { "inputs": { "value": 1 }, "class_type": "PrimitiveFloat" },
        "102:106": { "inputs": { "value": 20 }, "class_type": "PrimitiveInt" },
        "102:103": { "inputs": { "value": 4 }, "class_type": "PrimitiveInt" },
        "102:107": { "inputs": { "value": 2.5 }, "class_type": "PrimitiveFloat" },
        "102:111": { "inputs": { "value": false }, "class_type": "PrimitiveBoolean" },
        "102:3": {
          "inputs": {
            "seed": seed,
            "steps": ["102:110", 0],
            "cfg": ["102:109", 0],
            "sampler_name": "euler",
            "scheduler": "simple",
            "denoise": 1,
            "model": ["102:75", 0],
            "positive": ["102:76", 0],
            "negative": ["102:77", 0],
            "latent_image": ["102:88", 0]
          },
          "class_type": "KSampler"
        },
        "102:109": { "inputs": { "switch": ["102:111", 0], "on_false": ["102:107", 0], "on_true": ["102:105", 0] }, "class_type": "ComfySwitchNode" },
        "102:110": { "inputs": { "switch": ["102:111", 0], "on_false": ["102:106", 0], "on_true": ["102:103", 0] }, "class_type": "ComfySwitchNode" },
        "102:108": { "inputs": { "switch": ["102:111", 0], "on_false": ["102:37", 0], "on_true": ["102:89", 0] }, "class_type": "ComfySwitchNode" }
      };

    case "image-to-image2":
      // Workflow: Qwen Image Edit 2511 - Material Replacement (API).json
      return {
        "9": { "inputs": { "filename_prefix": "Qwen_Edit_2511", "images": ["170:158", 0] }, "class_type": "SaveImage" },
        "41": { "inputs": { "image": uploadedFiles.image1 || "image1.png" }, "class_type": "LoadImage" },
        "83": { "inputs": { "image": uploadedFiles.image2 || "image2.png" }, "class_type": "LoadImage" },
        "170:145": { "inputs": { "shift": 3.1, "model": ["170:161", 0] }, "class_type": "ModelSamplingAuraFlow" },
        "170:146": { "inputs": { "vae_name": "qwen_image_vae.safetensors" }, "class_type": "VAELoader" },
        "170:147": { "inputs": { "reference_latents_method": "index_timestep_zero", "conditioning": ["170:149", 0] }, "class_type": "FluxKontextMultiReferenceLatentMethod" },
        "170:148": { "inputs": { "reference_latents_method": "index_timestep_zero", "conditioning": ["170:151", 0] }, "class_type": "FluxKontextMultiReferenceLatentMethod" },
        "170:149": { "inputs": { "prompt": "", "clip": ["170:162", 0], "vae": ["170:146", 0], "image1": ["170:160", 0], "image2": ["83", 0] }, "class_type": "TextEncodeQwenImageEditPlus" },
        "170:151": { "inputs": { "prompt": prompt, "clip": ["170:162", 0], "vae": ["170:146", 0], "image1": ["170:160", 0], "image2": ["83", 0] }, "class_type": "TextEncodeQwenImageEditPlus" },
        "170:152": { "inputs": { "strength": 1, "model": ["170:145", 0] }, "class_type": "CFGNorm" },
        "170:153": { "inputs": { "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1, "model": ["170:152", 0] }, "class_type": "LoraLoaderModelOnly" },
        "170:154": { "inputs": { "value": 4 }, "class_type": "PrimitiveFloat" },
        "170:155": { "inputs": { "value": 1 }, "class_type": "PrimitiveFloat" },
        "170:156": { "inputs": { "pixels": ["170:160", 0], "vae": ["170:146", 0] }, "class_type": "VAEEncode" },
        "170:161": { "inputs": { "unet_name": "qwen_image_edit_2511_bf16.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader" },
        "170:162": { "inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default" }, "class_type": "CLIPLoader" },
        "170:163": { "inputs": { "switch": ["170:168", 0], "on_false": ["170:152", 0], "on_true": ["170:153", 0] }, "class_type": "ComfySwitchNode" },
        "170:165": { "inputs": { "value": 4 }, "class_type": "PrimitiveInt" },
        "170:166": { "inputs": { "value": 40 }, "class_type": "PrimitiveInt" },
        "170:168": { "inputs": { "value": true }, "class_type": "PrimitiveBoolean" },
        "170:164": { "inputs": { "switch": ["170:168", 0], "on_false": ["170:154", 0], "on_true": ["170:155", 0] }, "class_type": "ComfySwitchNode" },
        "170:167": { "inputs": { "switch": ["170:168", 0], "on_false": ["170:166", 0], "on_true": ["170:165", 0] }, "class_type": "ComfySwitchNode" },
        "170:169": {
          "inputs": {
            "seed": seed,
            "steps": ["170:167", 0],
            "cfg": ["170:164", 0],
            "sampler_name": "euler",
            "scheduler": "simple",
            "denoise": 1,
            "model": ["170:163", 0],
            "positive": ["170:148", 0],
            "negative": ["170:147", 0],
            "latent_image": ["170:156", 0]
          },
          "class_type": "KSampler"
        },
        "170:158": { "inputs": { "samples": ["170:169", 0], "vae": ["170:146", 0] }, "class_type": "VAEDecode" },
        "170:160": { "inputs": { "image": ["41", 0] }, "class_type": "FluxKontextImageScale" }
      };

    case "text-to-video":
      return {
        "1": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["2", 1] } },
        "2": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "model.safetensors" } }
      };

    case "image-to-video":
      return {
        "1": { "class_type": "LoadImage", "inputs": { "image": uploadedFiles.image1 || "input.png" } },
        "2": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["3", 1] } }
      };

    case "multi-shot-video":
      return {
        "483": { "inputs": { "image": uploadedFiles.image1 || "character.png" }, "class_type": "LoadImage" },
        "1185": { "inputs": { "image": uploadedFiles.image2 || "product.png" }, "class_type": "LoadImage" },
        "1244": { 
          "inputs": { 
            "image0": ["483", 0], 
            "image1": ["1185", 0] 
          }, 
          "class_type": "BatchImagesNode" 
        },
        "1239": {
          "inputs": {
            "model": "kling-v3-omni",
            "prompt": prompt || "addictive hook ad",
            "aspect_ratio": aspectRatio || "9:16",
            "duration": 9,
            "quality": videoQuality || "1080p",
            "mode": "3 storyboards",
            "storyboard_1_prompt": "\"My skin hits different\"",
            "storyboard_1_duration": 3,
            "storyboard_2_prompt": "\"I love this shit\", ambient sounds",
            "storyboard_2_duration": 3,
            "storyboard_3_prompt": "product packshot, ambient sounds",
            "storyboard_3_duration": 3,
            "negative_prompt": true,
            "seed": seed,
            "control_after_generate": "randomize",
            "reference_images": ["1244", 0]
          },
          "class_type": "KlingOmniProImageToVideoNode"
        },
        "1237": {
          "inputs": {
            "video": ["1239", 0],
            "filename_prefix": "multi_shot_video"
          },
          "class_type": "SaveVideo"
        }
      };

    default:
      return {};
  }
};

module.exports = { buildWorkflow };
