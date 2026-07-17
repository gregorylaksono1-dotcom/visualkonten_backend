"use strict";

const { generateGrokVideo } = require("./videoGenerationGrok");

/**
 * Facade router to trigger video generation task on Kie.ai.
 *
 * Active model: Grok Imagine Video 1.5 (grok-imagine-video-1-5-preview)
 *
 * Other available implementations (kept for future use):
 *   - ./videoGenerationVeo      → Google Veo 3.1 (veo3_lite)
 *   - ./videoGenerationSeedance → ByteDance Seedance 1.5 Pro (used for CHASER_1)
 */
async function generateComfyUIVideo(params) {
  return await generateGrokVideo(params);
}

module.exports = {
  generateComfyUIVideo
};
