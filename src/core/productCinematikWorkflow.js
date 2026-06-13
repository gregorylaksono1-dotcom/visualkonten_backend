const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
const fs = require("fs");
const { getJakartaISOString } = require("../utils");
const { getFalAiKey, getSignedUrl, uploadInputImage, submitWorkflow } = require("../services");
const { callOpenAIImageEdit } = require("./imageGenerationOpenAI");
const { graphToApiPrompt } = require("../lib/comfy-graph-to-api-prompt");

const WORKFLOW_NODE_IDS = {
  VHS_COMBINE: 801,
  loadImage: (i) => 2000 + i,
  prompt: (i) => 2100 + i,
  length: (i) => 2300 + i,
  subgraph: (i) => 2400 + i,
  merge: (j) => 2500 + j,
  audioConcat: (j) => 2800 + j,
  S3_UPLOAD: 9900,
};

function ceilToMultiple(value, multiple = 32) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Ukuran tidak valid: ${value}`);
  }
  return Math.ceil(n / multiple) * multiple;
}

function resolveLtxResolution(options = {}) {
  const width = ceilToMultiple(options.width ?? 720, 32);
  const height = ceilToMultiple(options.height ?? 1280, 32);
  const upscale = ceilToMultiple(options.upscale ?? Math.max(width, height), 32);
  return { width, height, upscale };
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

function applyWorkflowAssetFilenames(workflow, { sceneImageFilenames }) {
  sceneImageFilenames.forEach((filename, i) => {
    const node = workflow.nodes.find((n) => n.id === WORKFLOW_NODE_IDS.loadImage(i));
    if (node && filename) {
      node.widgets_values[0] = filename;
    }
  });
}

function buildProductCinematicWorkflow(scenes, options = {}) {
  if (!scenes?.length) {
    throw new Error("Minimal 1 scene diperlukan.");
  }

  const baseFile =
    options.baseFile ||
    path.join(__dirname, "..", "workflow", "video_ltx2_3_i2v.json");
  const resolution = resolveLtxResolution(options);

  const base = JSON.parse(fs.readFileSync(baseFile, "utf-8"));
  base.definitions.subgraphs.forEach((sg) => {
    // Apply resolution updates inside subgraph nodes if applicable
    const byId = Object.fromEntries((sg.nodes || []).map((n) => [n.id, n]));
    if (byId[330]?.widgets_values) byId[330].widgets_values[0] = resolution.width;
    if (byId[324]?.widgets_values) byId[324].widgets_values[0] = resolution.height;
    if (byId[294]?.widgets_values) byId[294].widgets_values[0] = resolution.upscale;

    // Apply LTX Prompt rewriter configurations
    configureLtxRewriterNodesInSubgraph(sg);

    // Bypass rewriter completely if option is enabled
    if (options.bypassLtxRewriter) {
      bypassLtxRewriterInSubgraph(sg);
    }
  });

  const SUBGRAPH_TYPE = base.definitions.subgraphs[0].id;
  const N = scenes.length;
  const NODE = WORKFLOW_NODE_IDS;

  const XL = -3200;
  const XP = -2340;
  const XAS = -1522;
  const XSG = -1216;
  const XM = -400;
  const XVC = 320;
  const YB = -12;
  const YS = 650;

  let nextLink = 3000;
  const nodes = [];
  const links_ = [];

  const sceneImageBatchLinks = [];
  const sceneAudioLinks = [];

  const fps = options.fps ?? 25;

  scenes.forEach((scene, i) => {
    const Y = YB + i * YS;
    const lkImg = nextLink++;
    const lkStr = nextLink++;
    const lkLen = nextLink++;
    const lkBatch = nextLink++;
    const lkAudio = nextLink++;

    sceneImageBatchLinks.push(lkBatch);
    sceneAudioLinks.push(lkAudio);

    const lengthVal = Math.round(Number(scene.duration_seconds || 5) * fps);

    // 1. LoadImage node
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
      title: `Start Frame — ${scene.title || `Scene ${i+1}`}`,
      properties: { "Node name for S&R": "LoadImage" },
      widgets_values: [scene.image, "image"],
    });

    // 2. prompt primitive string
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

    // 3. length primitive int
    nodes.push({
      id: NODE.length(i),
      type: "PrimitiveInt",
      pos: [XAS, Y + 240],
      size: [225, 80],
      flags: {},
      order: 4 + i * 5,
      mode: 0,
      inputs: [],
      outputs: [
        { name: "INT", type: "INT", slot_index: 0, links: [lkLen] },
      ],
      title: `S${i + 1} length=${lengthVal}f`,
      properties: { "Node name for S&R": "PrimitiveInt" },
      widgets_values: [lengthVal],
    });

    // 4. Subgraph instance node
    nodes.push({
      id: NODE.subgraph(i),
      type: SUBGRAPH_TYPE,
      pos: [XSG, Y],
      size: [400, 578],
      flags: {},
      order: 6 + i * 5,
      mode: 0,
      inputs: [
        { name: "input", type: "IMAGE,MASK", link: lkImg, slot_index: 0 },
        { name: "value", type: "STRING", widget: { name: "value" }, link: lkStr, slot_index: 1 },
        { label: "disable_i2v", name: "value_1", type: "BOOLEAN", widget: { name: "value_1" }, link: null, slot_index: 2 },
        { label: "width", name: "value_2", type: "INT", widget: { name: "value_2" }, link: null, slot_index: 3 },
        { label: "height", name: "value_3", type: "INT", widget: { name: "value_3" }, link: null, slot_index: 4 },
        { label: "length", name: "value_4", type: "INT", widget: { name: "value_4" }, link: lkLen, slot_index: 5 },
        { label: "ckpt_name", name: "ckpt_name", type: "COMBO", widget: { name: "ckpt_name" }, link: null, slot_index: 6 },
        { label: "distilled_lora", name: "lora_name", type: "COMBO", widget: { name: "lora_name" }, link: null, slot_index: 7 },
        { label: "text_encoder", name: "text_encoder", type: "COMBO", widget: { name: "text_encoder" }, link: null, slot_index: 8 },
        { label: "latent_upscale_model", name: "model_name", type: "COMBO", widget: { name: "model_name" }, link: null, slot_index: 9 },
        { label: "lora_name_1", name: "lora_name_1", type: "COMBO", widget: { name: "lora_name_1" }, link: null, slot_index: 10 },
        { label: "fps", name: "value_5", type: "INT", widget: { name: "value_5" }, link: null, slot_index: 11 },
      ],
      outputs: [
        { name: "IMAGE_BATCH", type: "IMAGE", slot_index: 0, links: [lkBatch] },
        { name: "AUDIO", type: "AUDIO", slot_index: 1, links: [lkAudio] },
      ],
      title: `${scene.title || `Scene ${i+1}`} [LTX-2.3]`,
      properties: { proxyWidgets: [], subgraph_id: SUBGRAPH_TYPE },
      widgets_values: {
        value_1: false,
        value_2: resolution.width,
        value_3: resolution.height,
        value_5: fps
      },
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
        target_slot: 1,
        type: "STRING",
      },
      {
        id: lkLen,
        origin_id: NODE.length(i),
        origin_slot: 0,
        target_id: NODE.subgraph(i),
        target_slot: 5,
        type: "INT",
      }
    );
  });

  // Image Merging Loop
  let lastMergeOutputLink;
  if (N === 1) {
    lastMergeOutputLink = sceneImageBatchLinks[0];
    links_.push({
      id: lastMergeOutputLink,
      origin_id: NODE.subgraph(0),
      origin_slot: 0,
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
        origin_slot: 0,
        target_id: mergeId,
        target_slot: 1,
        type: "IMAGE",
      });
      if (j === 0) {
        links_.push({
          id: inputA,
          origin_id: NODE.subgraph(0),
          origin_slot: 0,
          target_id: mergeId,
          target_slot: 0,
          type: "IMAGE",
        });
      }
    }
  }

  // Audio Concatenation Loop
  let lastAudioLink;
  if (N === 1) {
    lastAudioLink = sceneAudioLinks[0];
    links_.push({
      id: lastAudioLink,
      origin_id: NODE.subgraph(0),
      origin_slot: 1,
      target_id: NODE.VHS_COMBINE,
      target_slot: 1,
      type: "AUDIO",
    });
  } else {
    for (let j = 0; j < N - 1; j++) {
      const concatId = NODE.audioConcat(j);
      const inputA = j === 0 ? sceneAudioLinks[0] : lastAudioLink;
      const inputB = sceneAudioLinks[j + 1];
      const outputLink = nextLink++;
      lastAudioLink = outputLink;

      nodes.push({
        id: concatId,
        type: "AudioConcat",
        pos: [XM, YB + j * 180 + 100],
        size: [220, 80],
        flags: {},
        order: 10 + N * 5 + N + j,
        mode: 0,
        inputs: [
          { name: "audio1", type: "AUDIO", link: inputA, slot_index: 0 },
          { name: "audio2", type: "AUDIO", link: inputB, slot_index: 1 },
        ],
        outputs: [
          { name: "audio", type: "AUDIO", links: [outputLink], slot_index: 0 },
        ],
        title: `Concat Audio S${j + 1}+S${j + 2}`,
        properties: { "Node name for S&R": "AudioConcat" },
        widgets_values: ["after"],
      });

      links_.push({
        id: outputLink,
        origin_id: concatId,
        origin_slot: 0,
        target_id: j < N - 2 ? NODE.audioConcat(j + 1) : NODE.VHS_COMBINE,
        target_slot: j < N - 2 ? 0 : 1,
        type: "AUDIO",
      });

      links_.push({
        id: inputB,
        origin_id: NODE.subgraph(j + 1),
        origin_slot: 1,
        target_id: concatId,
        target_slot: 1,
        type: "AUDIO",
      });

      if (j === 0) {
        links_.push({
          id: inputA,
          origin_id: NODE.subgraph(0),
          origin_slot: 1,
          target_id: concatId,
          target_slot: 0,
          type: "AUDIO",
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
      { name: "audio", type: "AUDIO", shape: 7, link: lastAudioLink },
      { name: "meta_batch", type: "VHS_BatchManager", shape: 7, link: null },
      { name: "vae", type: "VAE", shape: 7, link: null },
    ],
    outputs: [{ name: "Filenames", type: "VHS_FILENAMES", links: null }],
    properties: { "Node name for S&R": "VHS_VideoCombine" },
    widgets_values: {
      frame_rate: fps,
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
    _meta: { sceneCount: N, resolution },
  };
}

async function generateProductCinematicPipeline(params) {
  const {
    jobId, userEmail, userId, currentS3ImageUrls, llmResponse, finalJobPrompt, videoQuality, aspectRatio,
    S3_RESOURCE_BUCKET, dynamo, s3, USER_REQUEST_TABLE, requestType
  } = params;

  console.log(`[ProductCinematic] Starting product cinematic multi-scene pipeline for job ${jobId}`);

  let comfyApiKey = params.comfyApiKey;
  let redis = null;

  try {
    const apiKey = await getFalAiKey();
    if (!apiKey) {
      throw new Error("Fal.ai API Key not found in secrets.");
    }

    let size = "1024x1536"; // default 9:16
    if (aspectRatio === "16:9") {
      size = "1536x1024";
    } else if (aspectRatio === "1:1") {
      size = "1024x1024";
    }

    const scenes = llmResponse.scene || llmResponse.scenes || [];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("No scenes found in LLM response for Product Cinematic multi-scene generation.");
    }

    const generatedScenes = [];
    const folder = "generated_image";

    // Generate first frames for each scene (Save to S3, do not upload to ComfyUI yet)
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneId = scene.scene_id || (i + 1);

      if (scene.consistency?.generate_first_frame === false) {
        const imageUrl = currentS3ImageUrls[0];
        console.log(`[ProductCinematic] Scene ${sceneId} generate_first_frame is false. Using user uploaded image directly: ${imageUrl}`);

        generatedScenes.push({
          scene_id: sceneId,
          s3_key: null,
          url: imageUrl
        });
      } else {
        let scenePrompt = scene.image_prompt || finalJobPrompt;
        const negativePrompt = String(scene.image_negative_prompt || scene.negative_prompt || "").trim();
        if (negativePrompt) {
          scenePrompt = `${scenePrompt.trim()}. Avoid: ${negativePrompt}.`;
        }
        console.log(`[ProductCinematic] Generating image for Scene ${sceneId}: "${scenePrompt.slice(0, 80)}..."`);

        // Use the user's uploaded product photo as the primary reference image
        const sceneReferenceUrls = currentS3ImageUrls;

        const { buffer, fallbackUrl } = await callOpenAIImageEdit({
          apiKey,
          prompt: scenePrompt,
          size,
          referenceUrls: sceneReferenceUrls
        });

        const s3Key = `${folder}/${userId || "anonymous"}/${jobId}_scene_${sceneId}.png`;

        await s3.send(new PutObjectCommand({
          Bucket: S3_RESOURCE_BUCKET,
          Key: s3Key,
          Body: buffer,
          ContentType: "image/png"
        }));

        const imgCmd = new GetObjectCommand({ Bucket: S3_RESOURCE_BUCKET, Key: s3Key });
        const signedUrl = fallbackUrl || (await getSignedUrl(s3, imgCmd, { expiresIn: 3600 }));

        generatedScenes.push({
          scene_id: sceneId,
          s3_key: s3Key,
          url: signedUrl
        });
      }
    }

    // Update DynamoDB with generated S3 asset keys first
    const primaryS3Key = generatedScenes.find(gs => gs.s3_key)?.s3_key || null;
    const updateExpr = ["generated_image = :genImg", "generated_scenes = :genScenes", "updated_at = :now"];
    const exprValues = {
      ":genImg": primaryS3Key,
      ":genScenes": generatedScenes.map(gs => ({
        scene_id: gs.scene_id,
        s3_key: gs.s3_key,
        url: gs.url
      })),
      ":now": getJakartaISOString()
    };

    const newImageKeys = [];
    generatedScenes.forEach(gs => {
      if (gs.s3_key) newImageKeys.push(gs.s3_key);
    });

    if (newImageKeys.length > 0) {
      updateExpr.push("s3_keys = list_append(if_not_exists(s3_keys, :empty_list), :newKeys)");
      exprValues[":empty_list"] = [];
      exprValues[":newKeys"] = newImageKeys;
    }

    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET " + updateExpr.join(", "),
      ExpressionAttributeValues: exprValues
    }));

    // Predict ComfyUI filenames and construct workflow
    const sceneImageFilenames = generatedScenes.map(gs => `${jobId}_scene_${gs.scene_id}.png`);

    let w = 720, h = 1280; // default 9:16
    if (videoQuality === "1080p") {
      if (aspectRatio === "16:9") { w = 1920; h = 1080; }
      else if (aspectRatio === "1:1") { w = 1080; h = 1080; }
      else { w = 1080; h = 1920; }
    } else {
      if (aspectRatio === "16:9") { w = 1280; h = 720; }
      else if (aspectRatio === "1:1") { w = 720; h = 720; }
      else { w = 720; h = 1280; }
    }

    const workflowScenes = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const duration = Number(scene.duration_seconds || 5);
      workflowScenes.push({
        title: scene.scene_name || `Scene ${scene.scene_id || (i + 1)}`,
        image: sceneImageFilenames[i],
        duration_seconds: duration,
        prompt: scene.ltx_prompt || scene.prompt || "",
        ltx_negative_prompt: scene.ltx_negative_prompt || scene.negative_prompt || "",
      });
    }

    console.log(`[ProductCinematic] Building dynamic workflow for ${scenes.length} scenes...`);
    const runpod = process.env.RUNPOD === "true";
    const s3FilenamePrefix = `${userId || "anonymous"}_${jobId}`;

    const bypassLtxRewriter = process.env.BYPASS_LTX_REWRITER === "true" ||
      (llmResponse && llmResponse.meta && (llmResponse.meta.bypass_ltx_rewriter === true || llmResponse.meta.bypass_rewriter === true));

    const workflow = buildProductCinematicWorkflow(workflowScenes, {
      baseFile: path.join(__dirname, "..", "workflow", "video_ltx2_3_i2v.json"),
      width: w,
      height: h,
      fps: 25,
      runpod,
      s3FilenamePrefix,
      bypassLtxRewriter
    });

    applyWorkflowAssetFilenames(workflow, {
      sceneImageFilenames
    });

    const apiPrompt = graphToApiPrompt(workflow, { bypassLtxRewriter });

    // Apply scene negative prompts inside the expanded API prompt nodes
    workflowScenes.forEach((scene, i) => {
      const negativePrompt = String(scene.ltx_negative_prompt || "").trim();
      if (!negativePrompt) return;
      const nodeKey = String(WORKFLOW_NODE_IDS.subgraph(i) * 10000 + 247);
      if (apiPrompt[nodeKey]) {
        if (!apiPrompt[nodeKey].inputs) {
          apiPrompt[nodeKey].inputs = {};
        }
        apiPrompt[nodeKey].inputs.text = negativePrompt;
      }
    });

    console.log("[ProductCinematic] Workflow JSON for debugging:\n" + JSON.stringify(apiPrompt, null, 2));

    // Try to pick ComfyUI API Key right before submitting
    if (!comfyApiKey) {
      const { pickComfyApiKey, getComfyApiKeys, getRedis } = require("../services");
      const apiKeysString = await getComfyApiKeys();
      redis = getRedis();
      comfyApiKey = await pickComfyApiKey(apiKeysString, redis);
    }

    if (!comfyApiKey) {
      console.log(`[ProductCinematic] All ComfyUI API keys are busy. Concurrency limit reached.`);
      const err = new Error("All ComfyUI API keys are busy (Concurrency Limit)");
      err.statusCode = 420;
      err.workflow = apiPrompt;
      throw err;
    }

    // Upload generated scene images
    for (let i = 0; i < generatedScenes.length; i++) {
      const gs = generatedScenes[i];
      const imageUrl = gs.url;
      const comfyImageName = sceneImageFilenames[i];
      console.log(`[ProductCinematic] Uploading Scene ${gs.scene_id} image to ComfyUI Cloud...`);
      const returnedName = await uploadInputImage(imageUrl, comfyImageName, comfyApiKey);
      
      const nodeId = String(2000 + i);
      if (apiPrompt[nodeId] && apiPrompt[nodeId].inputs) {
        apiPrompt[nodeId].inputs.image = returnedName;
        console.log(`[ProductCinematic] Updated Node ${nodeId} input image to: ${returnedName}`);
      }
    }

    // Submit Video Job to ComfyUI Cloud
    console.log(`[ProductCinematic] Submitting product cinematic workflow to ComfyUI Cloud...`);
    const videoPromptId = await submitWorkflow(apiPrompt, comfyApiKey);
    console.log(`[ProductCinematic] Submitted successfully. Prompt ID: ${videoPromptId}`);

    // Update status to PROCESSING and set comfy_prompt_id / used_api_key
    await dynamo.send(new UpdateCommand({
      TableName: USER_REQUEST_TABLE,
      Key: { uuid: jobId, user_email: userEmail },
      UpdateExpression: "SET comfy_prompt_id = :vp, #s = :status, used_api_key = :uak, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":vp": videoPromptId,
        ":status": "PROCESSING",
        ":uak": comfyApiKey || null,
        ":now": getJakartaISOString()
      }
    }));

    return videoPromptId;

  } catch (err) {
    console.error(`[ProductCinematic] Error in product cinematic generation pipeline:`, err);
    if (comfyApiKey && redis) {
      try {
        const redisKey = `comfyui_job_${comfyApiKey}`;
        await redis.decr(redisKey);
        console.log(`[ProductCinematic] [Redis] Decremented ${redisKey} due to pipeline failure`);
      } catch (rErr) {
        console.error("[ProductCinematic] [Redis] Error decrementing:", rErr.message);
      }
    }
    throw err;
  }
}

module.exports = {
  buildProductCinematicWorkflow,
  generateProductCinematicPipeline
};
