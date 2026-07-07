#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "../src/workflow/ugc_talent_and_product (API).json");
const dest = path.join(__dirname, "../src/workflow/product_only_camera_movement (API).json");

const wf = JSON.parse(fs.readFileSync(src, "utf8"));

wf["440"]._meta.title = "PRODUCT reveal_start_frame (Load 440 → first_frame)";
wf["441"]._meta.title = "PRODUCT hero_frame (Load 441 → last_frame)";

wf["442"] = {
  inputs: { image: "template_image_speech_to_video_woman_holding_face_oil.png" },
  class_type: "LoadImage",
  _meta: { title: "PRODUCT transition_frame (Load 442 → mid_frame ~50%)" },
};

wf["478:325"]._meta.title = "LTXVImgToVideoInplace first_frame (reveal_start)";
wf["478:337"]._meta.title = "Resize last_frame (hero_frame)";
wf["478:338"]._meta.title = "LTXVPreprocess last_frame (hero_frame)";
wf["478:341"]._meta.title = "AddGuide transition_frame mid (~50%)";
wf["478:340"]._meta.title = "AddGuide hero_frame (frame_idx -1)";
wf["478:340"].inputs.strength = 0.7;

wf["478:345"] = {
  inputs: {
    resize_type: "scale dimensions",
    "resize_type.width": ["478:330", 0],
    "resize_type.height": ["478:324", 0],
    "resize_type.crop": "center",
    scale_method: "lanczos",
    input: ["442", 0],
  },
  class_type: "ResizeImageMaskNode",
  _meta: { title: "Resize mid_frame (transition)" },
};

wf["478:346"] = {
  inputs: {
    img_compression: 18,
    image: ["478:345", 0],
  },
  class_type: "LTXVPreprocess",
  _meta: { title: "LTXVPreprocess mid_frame (transition)" },
};

// Mid guide uses transition image, not hero
wf["478:341"].inputs.image = ["478:346", 0];

if (wf["478:601"]) {
  wf["478:601"].inputs.strength_model = 1;
  wf["478:601"]._meta.title = "TalkVid LoRA (product voiceover)";
}

fs.writeFileSync(dest, JSON.stringify(wf, null, 2) + "\n");
console.log("Wrote", dest);
