const fs = require("fs");
const path = require("path");

/**
 * Builds a dynamic ComfyUI workflow for multiple scenes using Seedance,
 * sequentially merging their frames and concatenating their audio tracks.
 *
 * @param {Array} scenes - List of scenes: [{ image: "filename.png", prompt: "prompt text", duration: 4, talkvid: false }]
 * @param {Object} options - Options: { resolution: "720p", aspectRatio: "9:16" }
 * @returns {Object} ComfyUI workflow JSON
 */
function buildSeedanceWorkflow(scenes, options = {}) {
  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("At least one scene is required for Seedance workflow.");
  }

  const baseFile = path.join(__dirname, "..", "workflow", "seedance_base.json");
  if (!fs.existsSync(baseFile)) {
    throw new Error(`Base Seedance workflow template not found at: ${baseFile}`);
  }

  const baseWorkflow = JSON.parse(fs.readFileSync(baseFile, "utf-8"));

  const nodes = [];
  const links = [];

  const resolution = options.resolution || "720p";
  const aspectRatio = options.aspectRatio || "9:16";

  let nextNodeId = 1;
  let nextLinkId = 1;

  const sceneComponents = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    
    // Allocate IDs for the scene generation block
    const loadImageId = nextNodeId++;
    const bytedanceId = nextNodeId++;
    const getComponentsId = nextNodeId++;

    const imgLinkId = nextLinkId++;
    const vidLinkId = nextLinkId++;

    const duration = Number(scene.duration || 4);
    const randomSeed = Math.floor(Math.random() * 1000000000);

    // 1. LoadImage node
    nodes.push({
      id: loadImageId,
      type: "LoadImage",
      pos: [2160, 450 + i * 400],
      size: [283, 340],
      flags: {},
      order: i * 3,
      mode: 0,
      inputs: [],
      outputs: [
        { name: "IMAGE", type: "IMAGE", links: [imgLinkId] },
        { name: "MASK", type: "MASK", links: null }
      ],
      properties: {
        "Node name for S&R": "LoadImage",
        "cnr_id": "comfy-core",
        "ver": "0.9.2"
      },
      widgets_values: [
        scene.image || "input.png",
        "image"
      ]
    });

    // 2. ByteDanceImageToVideoNode
    const isTalkvid = scene.talkvid === true;
    const modelName = isTalkvid ? "seedance-1-5-pro-251215" : "seedance-1-0-pro-fast-251015";
    const generateAudio = isTalkvid;

    console.log(`[PIPELINE_LOG] [GENERATE_SCENE] Scene ID: ${scene.scene_id || (i + 1)}, Model ID: ${modelName}, Duration: ${duration}s, Talkvid: ${isTalkvid}`);
    
    nodes.push({
      id: bytedanceId,
      type: "ByteDanceImageToVideoNode",
      pos: [2540, 450 + i * 400],
      size: [433, 730],
      flags: {},
      order: i * 3 + 1,
      mode: 0,
      inputs: [
        { name: "image", type: "IMAGE", link: imgLinkId }
      ],
      outputs: [
        { name: "VIDEO", type: "VIDEO", links: [vidLinkId] }
      ],
      properties: {
        "Node name for S&R": "ByteDanceImageToVideoNode",
        "cnr_id": "comfy-core",
        "ver": "0.9.2"
      },
      widgets_values: [
        modelName,
        scene.prompt || "",
        resolution,
        aspectRatio,
        duration,
        randomSeed,
        "randomize",
        false, // camera_fixed
        false,
        generateAudio
      ],
      color: "#432",
      bgcolor: "#653"
    });

    // Allocate links for GetVideoComponents outputs
    const imagesOutLinkId = nextLinkId++;
    const audioOutLinkId = nextLinkId++;
    const fpsOutLinkId = nextLinkId++;

    // 3. GetVideoComponents node
    nodes.push({
      id: getComponentsId,
      type: "GetVideoComponents",
      pos: [3050, 450 + i * 400],
      size: [225, 120],
      flags: {},
      order: i * 3 + 2,
      mode: 0,
      inputs: [
        { name: "video", type: "VIDEO", link: vidLinkId }
      ],
      outputs: [
        { name: "images", type: "IMAGE", links: [imagesOutLinkId] },
        { name: "audio", type: "AUDIO", links: [audioOutLinkId] },
        { name: "fps", type: "FLOAT", links: [fpsOutLinkId] },
        { name: "bit_depth", type: "INT", links: null }
      ],
      properties: {
        "Node name for S&R": "GetVideoComponents"
      },
      widgets_values: []
    });

    links.push([imgLinkId, loadImageId, 0, bytedanceId, 0, "IMAGE"]);
    links.push([vidLinkId, bytedanceId, 0, getComponentsId, 0, "VIDEO"]);

    sceneComponents.push({
      imagesLinkId: imagesOutLinkId,
      audioLinkId: audioOutLinkId,
      fpsLinkId: fpsOutLinkId,
      getComponentsId: getComponentsId
    });
  }

  // Sequentially merge all scenes
  let currentImagesLinkId = sceneComponents[0].imagesLinkId;
  let currentAudioLinkId = sceneComponents[0].audioLinkId;
  const firstFpsLinkId = sceneComponents[0].fpsLinkId;

  let lastMergeId = sceneComponents[0].getComponentsId;
  let lastMergeSlot = 0;
  let lastConcatId = sceneComponents[0].getComponentsId;
  let lastConcatSlot = 1;

  // Connect subsequent scenes
  for (let j = 1; j < scenes.length; j++) {
    const mergeId = nextNodeId++;
    const concatId = nextNodeId++;

    const nextImagesLinkId = nextLinkId++;
    const nextAudioLinkId = nextLinkId++;

    // VHS_MergeImages node
    nodes.push({
      id: mergeId,
      type: "VHS_MergeImages",
      pos: [3350 + j * 300, 400],
      size: [280, 90],
      flags: {},
      order: nextNodeId,
      mode: 0,
      inputs: [
        { name: "images_A", type: "IMAGE", link: currentImagesLinkId },
        { name: "images_B", type: "IMAGE", link: sceneComponents[j].imagesLinkId }
      ],
      outputs: [
        { name: "IMAGE", type: "IMAGE", links: [nextImagesLinkId] }
      ],
      title: `Merge Scenes 1..${j} with Scene ${j + 1}`,
      properties: { "Node name for S&R": "VHS_MergeImages" },
      widgets_values: {
        merge_strategy: "match A",
        scale_method: "nearest-exact",
        crop: "disabled"
      }
    });

    links.push([currentImagesLinkId, lastMergeId, lastMergeSlot, mergeId, 0, "IMAGE"]);
    links.push([sceneComponents[j].imagesLinkId, sceneComponents[j].getComponentsId, 0, mergeId, 1, "IMAGE"]);

    // AudioConcat node
    nodes.push({
      id: concatId,
      type: "AudioConcat",
      pos: [3350 + j * 300, 600],
      size: [270, 131],
      flags: {},
      order: nextNodeId,
      mode: 0,
      inputs: [
        { name: "audio1", type: "AUDIO", link: currentAudioLinkId },
        { name: "audio2", type: "AUDIO", link: sceneComponents[j].audioLinkId }
      ],
      outputs: [
        { name: "AUDIO", type: "AUDIO", links: [nextAudioLinkId] }
      ],
      title: `Concat Audio 1..${j} with Audio ${j + 1}`,
      properties: { "Node name for S&R": "AudioConcat" },
      widgets_values: [
        "after"
      ]
    });

    links.push([currentAudioLinkId, lastConcatId, lastConcatSlot, concatId, 0, "AUDIO"]);
    links.push([sceneComponents[j].audioLinkId, sceneComponents[j].getComponentsId, 1, concatId, 1, "AUDIO"]);

    currentImagesLinkId = nextImagesLinkId;
    currentAudioLinkId = nextAudioLinkId;

    lastMergeId = mergeId;
    lastMergeSlot = 0;
    lastConcatId = concatId;
    lastConcatSlot = 0;
  }

  // Final stitching nodes
  const createVideoId = nextNodeId++;
  const saveVideoId = nextNodeId++;
  const finalVideoLinkId = nextLinkId++;

  let finalAudioLinkId = currentAudioLinkId;
  let finalAudioOriginId = lastConcatId;
  let finalAudioOriginSlot = lastConcatSlot;

  // If voiceover audio file is provided, load it and override final audio track
  if (options.audioFile) {
    const loadAudioId = nextNodeId++;
    const voiceoverLinkId = nextLinkId++;
    nodes.push({
      id: loadAudioId,
      type: "LoadAudio",
      pos: [3400 + scenes.length * 300, 300],
      size: [340, 152],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [
        { name: "AUDIO", type: "AUDIO", slot_index: 0, links: [voiceoverLinkId] }
      ],
      title: "Voiceover Audio",
      properties: { "Node name for S&R": "LoadAudio" },
      widgets_values: [options.audioFile, null, null]
    });
    finalAudioLinkId = voiceoverLinkId;
    finalAudioOriginId = loadAudioId;
    finalAudioOriginSlot = 0;
  }

  // CreateVideo node
  nodes.push({
    id: createVideoId,
    type: "CreateVideo",
    pos: [3400 + scenes.length * 300, 500],
    size: [270, 136],
    flags: {},
    order: nextNodeId,
    mode: 0,
    inputs: [
      { name: "images", type: "IMAGE", link: currentImagesLinkId },
      { name: "audio", type: "AUDIO", link: finalAudioLinkId },
      { name: "fps", type: "FLOAT", link: firstFpsLinkId }
    ],
    outputs: [
      { name: "VIDEO", type: "VIDEO", links: [finalVideoLinkId] }
    ],
    properties: {
      "Node name for S&R": "CreateVideo"
    },
    widgets_values: [
      30,
      8
    ]
  });

  links.push([currentImagesLinkId, lastMergeId, lastMergeSlot, createVideoId, 0, "IMAGE"]);
  links.push([finalAudioLinkId, finalAudioOriginId, finalAudioOriginSlot, createVideoId, 1, "AUDIO"]);
  links.push([firstFpsLinkId, sceneComponents[0].getComponentsId, 2, createVideoId, 2, "FLOAT"]);

  // SaveVideo node
  nodes.push({
    id: saveVideoId,
    type: "SaveVideo",
    pos: [3750 + scenes.length * 300, 500],
    size: [730, 1450],
    flags: {},
    order: nextNodeId + 1,
    mode: 0,
    inputs: [
      { name: "video", type: "VIDEO", link: finalVideoLinkId }
    ],
    outputs: [
      { name: "video", type: "VIDEO", links: null }
    ],
    properties: {
      "cnr_id": "comfy-core",
      "ver": "0.9.2"
    },
    widgets_values: [
      "video/seedance",
      "auto",
      "auto"
    ]
  });

  links.push([finalVideoLinkId, createVideoId, 0, saveVideoId, 0, "VIDEO"]);

  // Build the final workflow structure
  return {
    id: baseWorkflow.id || "seedance-dynamic-workflow",
    revision: 0,
    last_node_id: nextNodeId,
    last_link_id: nextLinkId,
    nodes: nodes,
    links: links,
    groups: [],
    config: {},
    extra: baseWorkflow.extra || {},
    version: 0.4
  };
}

module.exports = { buildSeedanceWorkflow };
