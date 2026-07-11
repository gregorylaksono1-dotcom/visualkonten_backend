"use strict";

const { generateVeoVideo } = require("./videoGenerationVeo");
const { generateSeedanceVideo } = require("./videoGenerationSeedance");

/**
 * Facade router to trigger video generation task on Kie.ai based on the model family
 */
async function generateComfyUIVideo(params) {
  const requestType = params.request_type || "";
  const isSeedance = requestType === "CHASER_1" || String(requestType).toUpperCase() === "CHASER_1";

  if (isSeedance) {
    return await generateSeedanceVideo(params);
  } else {
    return await generateVeoVideo(params);
  }
}

module.exports = {
  generateComfyUIVideo
};
