#!/usr/bin/env node
/**
 * Patches product_only_camera_movement.json for 3 keyframe images:
 * 440 reveal_start, 442 transition_frame (mid ~50%), 441 hero_frame (last).
 */
const fs = require("fs");
const path = require("path");

const wfPath = path.join(__dirname, "../src/workflow/product_only_camera_movement.json");
const wf = JSON.parse(fs.readFileSync(wfPath, "utf8"));

const sg = wf.definitions.subgraphs[0];
sg.state.lastNodeId = 347;
sg.state.lastLinkId = 962;

// --- Top-level LoadImage 442 ---
const load442 = {
  id: 442,
  type: "LoadImage",
  pos: [-2260.006338739375, 1880],
  size: [400, 470],
  flags: {},
  order: 0,
  mode: 0,
  inputs: [],
  outputs: [
    { name: "IMAGE", type: "IMAGE", links: [962] },
    { name: "MASK", type: "MASK", links: null },
  ],
  properties: {
    "Node name for S&R": "LoadImage",
    cnr_id: "comfy-core",
    ver: "0.18.1",
    enableTabs: false,
    hasSecondTab: false,
    secondTabOffset: 80,
    secondTabText: "Send Back",
    secondTabWidth: 65,
    tabWidth: 65,
    tabXOffset: 10,
    ue_properties: {
      input_ue_unconnectable: {},
      version: "7.7",
      widget_ue_connectable: {},
    },
  },
  title: "PRODUCT — transition_frame (Load 442 → mid_frame ~50%)",
  widgets_values: [
    "template_image_speech_to_video_woman_holding_face_oil.png",
    "image",
  ],
};
wf.nodes.push(load442);
wf.last_node_id = 616;
wf.last_link_id = 962;
wf.links.push([962, 442, 0, 478, 12, "IMAGE"]);

// --- Subgraph input: mid_frame (slot 12) ---
sg.inputs.push({
  id: "product-mid-frame-input",
  name: "input_2",
  type: "IMAGE,MASK",
  linkIds: [952],
  localized_name: "input_2",
  label: "mid_frame",
  pos: [-34.775390625, 4000],
});

// --- Subgraph nodes: mid resize / preprocess / math / AddGuide ---
const node345 = {
  id: 345,
  type: "ResizeImageMaskNode",
  pos: [909.99980450719, 5200],
  size: [290, 215.984375],
  flags: {},
  order: 16,
  mode: 0,
  inputs: [
    { localized_name: "input", name: "input", type: "IMAGE,MASK", link: 952 },
    {
      localized_name: "width",
      name: "resize_type.width",
      type: "INT",
      widget: { name: "resize_type.width" },
      link: 953,
    },
    {
      localized_name: "height",
      name: "resize_type.height",
      type: "INT",
      widget: { name: "resize_type.height" },
      link: 954,
    },
  ],
  outputs: [
    {
      localized_name: "resized",
      name: "resized",
      type: "IMAGE,MASK",
      links: [955],
    },
  ],
  properties: {
    "Node name for S&R": "ResizeImageMaskNode",
    cnr_id: "comfy-core",
    ver: "0.7.0",
  },
  title: "Resize mid_frame (transition)",
  widgets_values: ["scale dimensions", 1920, 1088, "center", "lanczos"],
};

const node346 = {
  id: 346,
  type: "LTXVPreprocess",
  pos: [1299.9998800931394, 5200],
  size: [280, 110],
  flags: {},
  order: 47,
  mode: 0,
  inputs: [
    { localized_name: "image", name: "image", type: "IMAGE", link: 955 },
  ],
  outputs: [
    {
      localized_name: "output_image",
      name: "output_image",
      type: "IMAGE",
      links: [956],
    },
  ],
  properties: { "Node name for S&R": "LTXVPreprocess", cnr_id: "comfy-core", ver: "0.7.0" },
  title: "Preprocess mid_frame (transition)",
  widgets_values: [18],
};

const node347 = {
  id: 347,
  type: "ComfyMathExpression",
  pos: [2000, 4540],
  size: [210, 80],
  flags: { collapsed: true },
  order: 50,
  mode: 0,
  inputs: [
    {
      label: "a",
      localized_name: "values.a",
      name: "values.a",
      type: "FLOAT,INT",
      link: 957,
    },
    {
      label: "b",
      localized_name: "values.b",
      name: "values.b",
      shape: 7,
      type: "FLOAT,INT",
      link: null,
    },
  ],
  outputs: [
    { localized_name: "FLOAT", name: "FLOAT", type: "FLOAT", links: null },
    { localized_name: "INT", name: "INT", type: "INT", links: [958] },
  ],
  properties: {
    "Node name for S&R": "ComfyMathExpression",
    cnr_id: "comfy-core",
    ver: "0.16.3",
  },
  title: "Mid transition frame index (~50% length)",
  widgets_values: ["floor(a * 0.5)"],
};

const node341 = {
  id: 341,
  type: "LTXVAddGuide",
  pos: [2360, 4780],
  size: [320, 220],
  flags: {},
  order: 48,
  mode: 0,
  inputs: [
    { localized_name: "positive", name: "positive", type: "CONDITIONING", link: 946 },
    { localized_name: "negative", name: "negative", type: "CONDITIONING", link: 947 },
    { localized_name: "vae", name: "vae", type: "VAE", link: 948 },
    { localized_name: "latent", name: "latent", type: "LATENT", link: 685 },
    { localized_name: "image", name: "image", type: "IMAGE", link: 956 },
    {
      localized_name: "frame_idx",
      name: "frame_idx",
      type: "INT",
      widget: { name: "frame_idx" },
      link: 958,
    },
  ],
  outputs: [
    { localized_name: "positive", name: "positive", type: "CONDITIONING", links: null },
    { localized_name: "negative", name: "negative", type: "CONDITIONING", links: null },
    { localized_name: "latent", name: "latent", type: "LATENT", links: [959] },
  ],
  properties: { "Node name for S&R": "LTXVAddGuide", cnr_id: "comfy-core", ver: "0.7.0" },
  title: "AddGuide transition_frame mid (~50%)",
  widgets_values: [0, 0.5],
};

// Insert before node 301 (after 340)
const idx301 = sg.nodes.findIndex((n) => n.id === 301);
sg.nodes.splice(idx301, 0, node345, node346, node347, node341);

// 340 latent now from 341 mid guide
const node340 = sg.nodes.find((n) => n.id === 340);
node340.inputs.find((i) => i.name === "latent").link = 959;
node340.title = "AddGuide hero_frame (frame_idx -1)";

// 325 latent only feeds mid guide (685 -> 341)
// link 685 already 325 -> was 340, retarget in links array

const sgLinks = sg.links;
const link685 = sgLinks.find((l) => l.id === 685);
link685.target_id = 341;

sgLinks.push(
  { id: 952, origin_id: -10, origin_slot: 12, target_id: 345, target_slot: 0, type: "IMAGE,MASK" },
  { id: 953, origin_id: 330, origin_slot: 0, target_id: 345, target_slot: 1, type: "INT" },
  { id: 954, origin_id: 324, origin_slot: 0, target_id: 345, target_slot: 2, type: "INT" },
  { id: 955, origin_id: 345, origin_slot: 0, target_id: 346, target_slot: 0, type: "IMAGE" },
  { id: 956, origin_id: 346, origin_slot: 0, target_id: 341, target_slot: 4, type: "IMAGE" },
  { id: 957, origin_id: 329, origin_slot: 1, target_id: 347, target_slot: 0, type: "INT" },
  { id: 958, origin_id: 347, origin_slot: 1, target_id: 341, target_slot: 5, type: "INT" },
  { id: 959, origin_id: 341, origin_slot: 2, target_id: 340, target_slot: 3, type: "LATENT" }
);

// Update markdown notes
const note615 = wf.nodes.find((n) => n.id === 615);
if (note615) {
  note615.title = "Product 3-Frame Keyframe Guide";
  note615.widgets_values = [
    "## product_only_camera_movement.json\n\n**440** = `reveal_start_frame` (occluded) → **first_frame**\n\n**442** = `transition_frame` (partial clear) → **mid_frame** (~50%, AddGuide strength 0.5)\n\n**441** = `hero_frame` (clear) → **last_frame** (`frame_idx` -1, strength 0.7)\n\n**614** = ltx_prompt from LLM (`PROMPT_PRODUCT`)\n\nSee `PRODUCT_3FRAME_COMFYUI_TEST.md`",
  ];
}
const note542 = wf.nodes.find((n) => n.id === 542);
if (note542) {
  note542.widgets_values = [
    "**Product-only video (3 keyframe images + optional voiceover)**\n\n## Setup\n\n1. **440** = reveal_start_frame (occluded)\n2. **442** = transition_frame (partial reveal)\n3. **441** = hero_frame (clear product)\n4. **611** = voiceover audio (optional)\n5. **614** = ltx_prompt — phased reveal, no orbit\n\nGenerate **hero_frame** first, then **transition_frame**, then **reveal_start_frame**.\n\nUGC workflow: use `ugc_talent_and_product (API).json` instead.",
  ];
}

fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2) + "\n");
console.log("Patched", wfPath);
