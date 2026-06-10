"use strict";

const fs = require("fs");
const path = require("path");

const WORKFLOW_NODE_IDS = {
  LOAD_AUDIO: 611,
  AUDIO_PAD: 834,
  VHS_COMBINE: 801,
  loadImage: (i) => 2000 + i,
  prompt: (i) => 2100 + i,
  audioStart: (i) => 2200 + i,
  duration: (i) => 2300 + i,
  subgraph: (i) => 2400 + i,
  merge: (j) => 2500 + j,
  S3_UPLOAD: 9900,
};

const RESOLUTION_PRESETS = {
  "720p": { width: 720, height: 1280, upscale: 1536 },
  "1080p": { width: 1056, height: 1888, upscale: 2304 },
};

function ceilToMultiple(value, multiple = 32) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Ukuran tidak valid: ${value}`);
  }
  return Math.ceil(n / multiple) * multiple;
}

function resolveLtxResolution(options = {}) {
  const presetKey = String(options.resolution || "720p").toLowerCase();
  const preset = RESOLUTION_PRESETS[presetKey] || RESOLUTION_PRESETS["720p"];

  const width = ceilToMultiple(options.width ?? preset.width, 32);
  const height = ceilToMultiple(options.height ?? preset.height, 32);
  const hasCustomResolution = options.width != null || options.height != null;
  const defaultUpscale = hasCustomResolution
    ? Math.max(width, height)
    : preset.upscale;
  const upscale = ceilToMultiple(options.upscale ?? defaultUpscale, 32);

  return { width, height, upscale, presetKey };
}

function removeCameramanLoraNode(subgraph) {
  if (!Array.isArray(subgraph?.nodes) || !Array.isArray(subgraph?.links)) return;

  const nodes = subgraph.nodes;
  const links = subgraph.links;
  const linkById = new Map(links.map((lk) => [Number(lk.id), lk]));

  const cameramanNodes = nodes.filter((n) => {
    if (n?.type !== "LoraLoaderModelOnly" || !Array.isArray(n.widgets_values)) return false;
    const loraName = String(n.widgets_values[0] || "").toLowerCase();
    return loraName.includes("cameraman");
  });

  for (const node of cameramanNodes) {
    const nodeId = Number(node.id);
    const modelInput = (node.inputs || []).find((inp) => inp?.name === "model" && inp.link != null);
    if (!modelInput) continue;

    const upstream = linkById.get(Number(modelInput.link));
    if (!upstream) continue;
    const upstreamOriginId = Number(upstream.origin_id);
    const upstreamOriginSlot = Number(upstream.origin_slot ?? 0);

    // Rewire all outgoing links to use the upstream model directly.
    for (const lk of links) {
      if (Number(lk.origin_id) !== nodeId) continue;
      lk.origin_id = upstreamOriginId;
      lk.origin_slot = upstreamOriginSlot;
    }
  }

  const removeNodeIds = new Set(cameramanNodes.map((n) => Number(n.id)));
  subgraph.nodes = nodes.filter((n) => !removeNodeIds.has(Number(n.id)));
  subgraph.links = links.filter(
    (lk) =>
      !removeNodeIds.has(Number(lk.origin_id)) && !removeNodeIds.has(Number(lk.target_id))
  );
}

function removeDetailerLoraNode(subgraph) {
  if (!Array.isArray(subgraph?.nodes) || !Array.isArray(subgraph?.links)) return;

  const nodes = subgraph.nodes;
  const links = subgraph.links;
  const linkById = new Map(links.map((lk) => [Number(lk.id), lk]));

  const detailerNodes = nodes.filter((n) => {
    if (n?.type !== "LoraLoaderModelOnly" || !Array.isArray(n.widgets_values)) return false;
    const loraName = String(n.widgets_values[0] || "").toLowerCase();
    return loraName.includes("detailer");
  });

  for (const node of detailerNodes) {
    const nodeId = Number(node.id);
    const modelInput = (node.inputs || []).find((inp) => inp?.name === "model" && inp.link != null);
    if (!modelInput) continue;

    const upstream = linkById.get(Number(modelInput.link));
    if (!upstream) continue;
    const upstreamOriginId = Number(upstream.origin_id);
    const upstreamOriginSlot = Number(upstream.origin_slot ?? 0);

    // Rewire all outgoing links to use the upstream model directly.
    for (const lk of links) {
      if (Number(lk.origin_id) !== nodeId) continue;
      lk.origin_id = upstreamOriginId;
      lk.origin_slot = upstreamOriginSlot;
    }
  }

  const removeNodeIds = new Set(detailerNodes.map((n) => Number(n.id)));
  subgraph.nodes = nodes.filter((n) => !removeNodeIds.has(Number(n.id)));
  subgraph.links = links.filter(
    (lk) =>
      !removeNodeIds.has(Number(lk.origin_id)) && !removeNodeIds.has(Number(lk.target_id))
  );
}

/**
 * Durasi total audio + sedikit padding untuk node AudioPad.
 * @param {Array<{ audioStart: number, duration: number }>} scenes
 */
function computeAudioPad(scenes, paddingSec = 0.5) {
  if (!scenes.length) return 22;
  const end = scenes.reduce(
    (max, s) => Math.max(max, Number(s.audioStart) + Number(s.duration)),
    0
  );
  return Math.ceil(end + paddingSec);
}

/**
 * @param {object} workflow - graph workflow dari buildMultiSceneWorkflow
 * @param {{ audioFilename: string, sceneImageFilenames: string[] }} assets
 */
function applyWorkflowAssetFilenames(workflow, { audioFilename, sceneImageFilenames }) {
  const loadAudio = workflow.nodes.find((n) => n.id === WORKFLOW_NODE_IDS.LOAD_AUDIO);
  if (loadAudio && audioFilename) {
    loadAudio.widgets_values[0] = audioFilename;
  }

  sceneImageFilenames.forEach((filename, i) => {
    const node = workflow.nodes.find((n) => n.id === WORKFLOW_NODE_IDS.loadImage(i));
    if (node && filename) {
      node.widgets_values[0] = filename;
    }
  });
}

/**
 * Bangun workflow graph multi-scene (format ComfyUI editor + subgraph).
 *
 * @param {Array<{ title, image, audioStart, duration, prompt, talkvid? }>} scenes
 * @param {{ baseFile?: string, audioFile?: string, audioPad?: number }} options
 */
function buildMultiSceneWorkflow(scenes, options = {}) {
  if (!scenes?.length) {
    throw new Error("Minimal 1 scene diperlukan.");
  }

  const baseFile =
    options.baseFile ||
    path.join(__dirname, "..", "workflow", "base1scene.json");
  const audioFile = options.audioFile || "audio.wav";
  const audioPad = options.audioPad ?? computeAudioPad(scenes);
  const resolution = resolveLtxResolution(options);

  const base = JSON.parse(fs.readFileSync(baseFile, "utf-8"));
  base.definitions.subgraphs.forEach((sg) => {
    const byId = Object.fromEntries((sg.nodes || []).map((n) => [n.id, n]));
    if (byId[330]?.widgets_values) byId[330].widgets_values[0] = resolution.width;
    if (byId[324]?.widgets_values) byId[324].widgets_values[0] = resolution.height;
    if (byId[294]?.widgets_values) byId[294].widgets_values[0] = resolution.upscale;

    removeCameramanLoraNode(sg);
    removeDetailerLoraNode(sg);

    // Apply LTX Prompt rewriter fixes (sampling_mode, use_image, seed)
    configureLtxRewriterNodesInSubgraph(sg);

    // Bypass rewriter completely if option is enabled
    if (options.bypassLtxRewriter) {
      bypassLtxRewriterInSubgraph(sg);
    }
  });
  const SUBGRAPH_TYPE = base.definitions.subgraphs[0].id;
  const SUBGRAPH_TYPE_NOTV = base.definitions.subgraphs[1].id;

  const N = scenes.length;
  const NODE = WORKFLOW_NODE_IDS;

  const XL = -3200;
  const XP = -2340;
  const XAS = -1522;
  const XSG = -1216;
  const XM = -400;
  const XVC = 320;
  const YAUD = -215;
  const YB = -12;
  const YS = 650;

  let nextLink = 3000;
  const nodes = [];
  const links_ = [];

  const LK_LOAD_TO_PAD = nextLink++;
  nodes.push({
    id: NODE.LOAD_AUDIO,
    type: "LoadAudio",
    pos: [-1464, YAUD],
    size: [340, 152],
    flags: {},
    order: 0,
    mode: 0,
    inputs: [],
    outputs: [
      { name: "AUDIO", type: "AUDIO", slot_index: 0, links: [LK_LOAD_TO_PAD] },
    ],
    title: "VO Audio — shared all scenes",
    properties: { "Node name for S&R": "LoadAudio" },
    widgets_values: [audioFile, null, null],
  });

  const LK_PAD_TO_VHS = nextLink++;
  const padOutputLinkIds = [LK_PAD_TO_VHS];

  nodes.push({
    id: NODE.AUDIO_PAD,
    type: "AudioPad",
    pos: [-973, YAUD],
    size: [270, 136],
    flags: {},
    order: 1,
    mode: 0,
    inputs: [{ name: "audio", type: "AUDIO", link: LK_LOAD_TO_PAD }],
    outputs: [],
    properties: { "Node name for S&R": "AudioPad" },
    widgets_values: [0, audioPad],
  });
  links_.push({
    id: LK_LOAD_TO_PAD,
    origin_id: NODE.LOAD_AUDIO,
    origin_slot: 0,
    target_id: NODE.AUDIO_PAD,
    target_slot: 0,
    type: "AUDIO",
  });

  const sceneImageBatchLinks = [];

  scenes.forEach((scene, i) => {
    const Y = YB + i * YS;
    const lkImg = nextLink++;
    const lkStr = nextLink++;
    const lkAuS = nextLink++;
    const lkDur = nextLink++;
    const lkAudio = nextLink++;
    const lkBatch = nextLink++;

    padOutputLinkIds.push(lkAudio);
    sceneImageBatchLinks.push(lkBatch);

    nodes.push({
      id: NODE.loadImage(i),
      type: "LoadImage",
      pos: [XL, Y + 300],
      size: [380, 460],
      flags: {},
      order: 2 + i * 5,
      mode: 0,
      inputs: [],
      outputs: [
        { name: "IMAGE", type: "IMAGE", slot_index: 0, links: [lkImg] },
        { name: "MASK", type: "MASK", slot_index: 1, links: [] },
      ],
      title: `Start Frame — ${scene.title}`,
      properties: { "Node name for S&R": "LoadImage" },
      widgets_values: [scene.image, "image"],
    });

    nodes.push({
      id: NODE.prompt(i),
      type: "PrimitiveStringMultiline",
      pos: [XP, Y],
      size: [420, 220],
      flags: {},
      order: 3 + i * 5,
      mode: 0,
      inputs: [],
      outputs: [
        { name: "STRING", type: "STRING", slot_index: 0, links: [lkStr] },
      ],
      title: `S${i + 1} ltx_prompt`,
      properties: { "Node name for S&R": "PrimitiveStringMultiline" },
      widgets_values: [scene.prompt],
    });

    nodes.push({
      id: NODE.audioStart(i),
      type: "PrimitiveFloat",
      pos: [XAS, Y + 240],
      size: [225, 80],
      flags: {},
      order: 4 + i * 5,
      mode: 0,
      inputs: [],
      outputs: [
        { name: "FLOAT", type: "FLOAT", slot_index: 0, links: [lkAuS] },
      ],
      title: `S${i + 1} audio_start=${scene.audioStart}s`,
      properties: { "Node name for S&R": "PrimitiveFloat" },
      widgets_values: [scene.audioStart],
    });

    nodes.push({
      id: NODE.duration(i),
      type: "PrimitiveFloat",
      pos: [XAS + 230, Y + 240],
      size: [225, 80],
      flags: {},
      order: 5 + i * 5,
      mode: 0,
      inputs: [],
      outputs: [
        { name: "FLOAT", type: "FLOAT", slot_index: 0, links: [lkDur] },
      ],
      title: `S${i + 1} duration=${scene.duration}s (${Math.round(scene.duration * 24) + 1}f)`,
      properties: { "Node name for S&R": "PrimitiveFloat" },
      widgets_values: [scene.duration],
    });

    const sgType =
      scene.talkvid !== false ? SUBGRAPH_TYPE : SUBGRAPH_TYPE_NOTV;
    nodes.push({
      id: NODE.subgraph(i),
      type: sgType,
      pos: [XSG, Y],
      size: [400, 578],
      flags: {},
      order: 6 + i * 5,
      mode: 0,
      inputs: [
        { name: "input", type: "IMAGE,MASK", link: lkImg, slot_index: 0 },
        { name: "audio", type: "AUDIO", link: lkAudio, slot_index: 1 },
        {
          name: "value",
          type: "STRING",
          widget: { name: "value" },
          link: lkStr,
          slot_index: 2,
        },
        {
          label: "width",
          name: "value_1",
          type: "INT",
          widget: { name: "value_1" },
          link: null,
          slot_index: 3,
        },
        {
          label: "height",
          name: "value_2",
          type: "INT",
          widget: { name: "value_2" },
          link: null,
          slot_index: 4,
        },
        {
          label: "fps",
          name: "value_3",
          type: "INT",
          widget: { name: "value_3" },
          link: null,
          slot_index: 5,
        },
        {
          name: "start_index",
          type: "FLOAT",
          widget: { name: "start_index" },
          link: lkAuS,
          slot_index: 6,
        },
        {
          name: "value_4",
          type: "FLOAT",
          widget: { name: "value_4" },
          link: lkDur,
          slot_index: 7,
        },
        {
          label: "distilled_lora",
          name: "lora_name",
          type: "COMBO",
          widget: { name: "lora_name" },
          link: null,
          slot_index: 8,
        },
        {
          label: "upscale_model",
          name: "model_name",
          type: "COMBO",
          widget: { name: "model_name" },
          link: null,
          slot_index: 9,
        },
        {
          label: "id-lora",
          name: "lora_name_1",
          type: "COMBO",
          widget: { name: "lora_name_1" },
          link: null,
          slot_index: 10,
        },
      ],
      outputs: [
        { name: "VIDEO", type: "VIDEO", slot_index: 0, links: [] },
        { name: "IMAGE_BATCH", type: "IMAGE", slot_index: 1, links: [lkBatch] },
      ],
      title: `${scene.title}${scene.talkvid !== false ? " [talkvid]" : " [no talkvid]"}`,
      properties: { proxyWidgets: [], subgraph_id: sgType },
      widgets_values: [],
    });

    links_.push(
      {
        id: lkImg,
        origin_id: NODE.loadImage(i),
        origin_slot: 0,
        target_id: NODE.subgraph(i),
        target_slot: 0,
        type: "IMAGE",
      },
      {
        id: lkStr,
        origin_id: NODE.prompt(i),
        origin_slot: 0,
        target_id: NODE.subgraph(i),
        target_slot: 2,
        type: "STRING",
      },
      {
        id: lkAuS,
        origin_id: NODE.audioStart(i),
        origin_slot: 0,
        target_id: NODE.subgraph(i),
        target_slot: 6,
        type: "FLOAT",
      },
      {
        id: lkDur,
        origin_id: NODE.duration(i),
        origin_slot: 0,
        target_id: NODE.subgraph(i),
        target_slot: 7,
        type: "FLOAT",
      },
      {
        id: lkAudio,
        origin_id: NODE.AUDIO_PAD,
        origin_slot: 0,
        target_id: NODE.subgraph(i),
        target_slot: 1,
        type: "AUDIO",
      }
    );
  });

  let lastMergeOutputLink;

  if (N === 1) {
    lastMergeOutputLink = sceneImageBatchLinks[0];
    links_.push({
      id: lastMergeOutputLink,
      origin_id: NODE.subgraph(0),
      origin_slot: 1,
      target_id: NODE.VHS_COMBINE,
      target_slot: 0,
      type: "IMAGE",
    });
  } else {
    for (let j = 0; j < N - 1; j++) {
      const mergeId = NODE.merge(j);
      const inputA = j === 0 ? sceneImageBatchLinks[0] : lastMergeOutputLink;
      const inputB = sceneImageBatchLinks[j + 1];
      const outputLink = nextLink++;
      lastMergeOutputLink = outputLink;

      const labelA = j === 0 ? "S1" : `S1…S${j + 1}`;
      const labelB = `S${j + 2}`;

      nodes.push({
        id: mergeId,
        type: "VHS_MergeImages",
        pos: [XM, YB + j * 180],
        size: [280, 90],
        flags: {},
        order: 10 + N * 5 + j,
        mode: 0,
        inputs: [
          { name: "images_A", type: "IMAGE", link: inputA, slot_index: 0 },
          { name: "images_B", type: "IMAGE", link: inputB, slot_index: 1 },
        ],
        outputs: [
          { name: "IMAGE", type: "IMAGE", links: [outputLink], slot_index: 0 },
        ],
        title: `Merge ${labelA}+${labelB}`,
        properties: { "Node name for S&R": "VHS_MergeImages" },
        widgets_values: {
          merge_strategy: "match A",
          scale_method: "nearest-exact",
          crop: "disabled",
        },
      });

      links_.push({
        id: outputLink,
        origin_id: mergeId,
        origin_slot: 0,
        target_id: j < N - 2 ? NODE.merge(j + 1) : NODE.VHS_COMBINE,
        target_slot: 0,
        type: "IMAGE",
      });

      links_.push({
        id: inputB,
        origin_id: NODE.subgraph(j + 1),
        origin_slot: 1,
        target_id: mergeId,
        target_slot: 1,
        type: "IMAGE",
      });
      if (j === 0) {
        links_.push({
          id: inputA,
          origin_id: NODE.subgraph(0),
          origin_slot: 1,
          target_id: mergeId,
          target_slot: 0,
          type: "IMAGE",
        });
      }
    }
  }

  const vhsCombineNode = {
    id: NODE.VHS_COMBINE,
    type: "VHS_VideoCombine",
    pos: [XVC, YB + Math.floor(N / 2) * YS],
    size: [487, 334],
    flags: {},
    order: 99,
    mode: 0,
    inputs: [
      { name: "images", type: "IMAGE", link: lastMergeOutputLink },
      { name: "audio", type: "AUDIO", shape: 7, link: LK_PAD_TO_VHS },
      { name: "meta_batch", type: "VHS_BatchManager", shape: 7, link: null },
      { name: "vae", type: "VAE", shape: 7, link: null },
    ],
    outputs: [{ name: "Filenames", type: "VHS_FILENAMES", links: null }],
    properties: { "Node name for S&R": "VHS_VideoCombine" },
    widgets_values: {
      frame_rate: 24,
      loop_count: 0,
      filename_prefix: "ComfyUI",
      format: "video/h264-mp4",
      pix_fmt: "yuv420p",
      crf: 19,
      save_metadata: true,
      trim_to_audio: false,
      pingpong: false,
      save_output: true,
      videopreview: { hidden: false, paused: false, params: {} },
    },
  };

  if (options.runpod) {
    const lkS3Upload = nextLink++;
    vhsCombineNode.outputs[0].links = [lkS3Upload];
    nodes.push(vhsCombineNode);

    nodes.push({
      id: NODE.S3_UPLOAD,
      type: "SaveVideoFilesS3",
      pos: [XVC + 550, YB + Math.floor(N / 2) * YS],
      size: [300, 150],
      flags: {},
      order: 100,
      mode: 0,
      inputs: [
        { name: "filenames", type: "VHS_FILENAMES", link: lkS3Upload }
      ],
      outputs: [],
      title: "Upload Video to S3",
      properties: { "Node name for S&R": "SaveVideoFilesS3" },
      widgets_values: [
        options.s3FilenamePrefix || "VideoFiles"
      ]
    });

    links_.push({
      id: lkS3Upload,
      origin_id: NODE.VHS_COMBINE,
      origin_slot: 0,
      target_id: NODE.S3_UPLOAD,
      target_slot: 0,
      type: "VHS_FILENAMES"
    });
  } else {
    nodes.push(vhsCombineNode);
  }
  links_.push({
    id: LK_PAD_TO_VHS,
    origin_id: NODE.AUDIO_PAD,
    origin_slot: 0,
    target_id: NODE.VHS_COMBINE,
    target_slot: 1,
    type: "AUDIO",
  });

  const audioPadNode = nodes.find((n) => n.id === NODE.AUDIO_PAD);
  audioPadNode.outputs = [
    {
      name: "AUDIO",
      type: "AUDIO",
      links: padOutputLinkIds,
      slot_index: 0,
    },
  ];

  const seenLinkIds = new Set();
  const uniqueLinks = links_.filter((lk) => {
    if (seenLinkIds.has(lk.id)) return false;
    seenLinkIds.add(lk.id);
    return true;
  });

  return {
    id: base.id,
    revision: (base.revision ?? 0) + 1,
    last_node_id: Math.max(...nodes.map((n) => n.id)) + 1,
    last_link_id: nextLink,
    nodes,
    links: uniqueLinks,
    groups: [],
    definitions: base.definitions,
    config: base.config ?? {},
    extra: base.extra ?? {},
    version: base.version ?? "1.0",
    _meta: { sceneCount: N, audioPad, resolution },
  };
}

function printSceneSummary(scenes) {
  scenes.forEach((s, i) => {
    const frames = Math.round(s.duration * 24) + 1;
    console.log(
      `  S${i + 1}  audio_start=${s.audioStart}s  dur=${s.duration}s  frames=${frames}  talkvid=${s.talkvid !== false}  img="${s.image}"`
    );
  });
}

function applySceneNegativePrompts(apiPrompt, scenes) {
  scenes.forEach((scene, i) => {
    const negativePrompt = String(
      scene.ltx_negative_prompt ?? scene.negative_prompt ?? ""
    ).trim();
    if (!negativePrompt) return;

    const nodeKey = String(WORKFLOW_NODE_IDS.subgraph(i) * 10000 + 314);
    if (!apiPrompt[nodeKey]) return;

    if (!apiPrompt[nodeKey].inputs) {
      apiPrompt[nodeKey].inputs = {};
    }
    apiPrompt[nodeKey].inputs.text = negativePrompt;
  });
}

function configureLtxRewriterNodesInSubgraph(sg) {
  if (!sg || !Array.isArray(sg.nodes)) return;
  for (const node of sg.nodes) {
    if (node.type !== "TextGenerateLTX2Prompt") continue;
    if (Array.isArray(node.widgets_values)) {
      if (node.widgets_values.length > 2) node.widgets_values[2] = "off";
      if (node.widgets_values.length > 8) node.widgets_values[8] = 0;
      if (node.widgets_values.length > 9) node.widgets_values[9] = 0;
      if (node.widgets_values.length > 11) node.widgets_values[11] = false;
    } else if (node.widgets_values && typeof node.widgets_values === "object") {
      node.widgets_values.sampling_mode = "off";
      node.widgets_values.use_image = false;
      node.widgets_values.seed = 0;
      node.widgets_values.seed_control_before_generate = 0;
    }
  }
}

function bypassLtxRewriterInSubgraph(sg) {
  if (!sg || !Array.isArray(sg.nodes) || !Array.isArray(sg.links)) return;
  const rewriterNodes = sg.nodes.filter(n => n.type === "TextGenerateLTX2Prompt");
  if (!rewriterNodes.length) return;

  for (const rewriter of rewriterNodes) {
    const rewriterId = rewriter.id;
    const promptInputIdx = Array.isArray(rewriter.inputs) 
      ? rewriter.inputs.findIndex(inp => inp && inp.name === "prompt")
      : -1;
    if (promptInputIdx === -1) continue;

    const inputLink = sg.links.find(lk => lk.target_id === rewriterId && lk.target_slot === promptInputIdx);
    if (!inputLink) continue;

    const sourceNodeId = inputLink.origin_id;
    const sourceSlot = inputLink.origin_slot;
    const outputLinks = sg.links.filter(lk => lk.origin_id === rewriterId && lk.origin_slot === 0);

    for (const outLink of outputLinks) {
      outLink.origin_id = sourceNodeId;
      outLink.origin_slot = sourceSlot;
    }

    const inputLinkIdx = sg.links.indexOf(inputLink);
    if (inputLinkIdx !== -1) sg.links.splice(inputLinkIdx, 1);

    const rewriterIdx = sg.nodes.indexOf(rewriter);
    if (rewriterIdx !== -1) sg.nodes.splice(rewriterIdx, 1);
  }
}

module.exports = {
  WORKFLOW_NODE_IDS,
  ceilToMultiple,
  resolveLtxResolution,
  computeAudioPad,
  buildMultiSceneWorkflow,
  applyWorkflowAssetFilenames,
  applySceneNegativePrompts,
  printSceneSummary,
};
