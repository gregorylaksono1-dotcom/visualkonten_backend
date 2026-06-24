"use strict";

/**
 * pacing.js — in-ComfyUI "fast-cut" pacing stage for the multi-scene LTX workflow.
 *
 * WHAT IT DOES (v1, cheap ops only, runs on the decoded IMAGE batch BEFORE the
 * single final VHS_VideoCombine encode — so no double transcode, crops happen on
 * hi-res frames):
 *   For each PRODUCT scene (talkvid === false) it splices a small node chain
 *   between the scene's subgraph IMAGE_BATCH output (slot 1) and the merge chain:
 *
 *     subgraph(i).IMAGE_BATCH ─┬─ GetImageRangeFromBatch (Beat A, wide)        ─────────────┐
 *                              └─ GetImageRangeFromBatch (Beat B) ─ ImageCrop ─ ImageScale ─┤
 *                                                                          VHS_MergeImages(A,B) ─→ merge chain
 *
 *   Result: one 5s clip reads as 2 beats (a jump-cut + a punch-in "fake angle"),
 *   the middle is dropped to tighten pace. No new first frames, no extra LTX gen.
 *
 *   TALKVID scenes (talkvid !== false) are BYPASSED untouched — lip-sync stays intact.
 *
 * GATING: pacing only runs when options.pacing.enabled === true. The CALLER sets
 *   this true for product_ad jobs only, and leaves it off for industrial (whose
 *   continuous VO would desync if product-scene frame counts changed).
 *
 * AUDIO: not touched here. For product_ad the baked SFX track becomes irrelevant
 *   (music is added later in the TikTok editor), so a slightly shortened video is fine.
 *
 * ── NODES USED (verify installed) ───────────────────────────────────────────────
 *   - GetImageRangeFromBatch   → ComfyUI-KJNodes      (NEW dependency to install)
 *   - ImageCrop                → ComfyUI core
 *   - ImageScale               → ComfyUI core
 *   - VHS_MergeImages          → ComfyUI-VideoHelperSuite (already installed)
 *   - VHS_SelectEveryNthImage  → ComfyUI-VideoHelperSuite (optional speed-up, off by default)
 *
 * ── WIDGET ORDER ASSUMPTIONS (double-check against your ComfyUI object_info) ─────
 *   - GetImageRangeFromBatch widgets: [start_index, num_frames]   (images = input link)
 *   - ImageCrop              widgets: [width, height, x, y]       (image  = input link)
 *   - ImageScale             widgets: [upscale_method, width, height, crop]
 *   - VHS_MergeImages        widgets (object form, mirrors your existing usage):
 *                                     { merge_strategy, scale_method, crop }
 *   If your graphToApiPrompt maps widgets by object_info these orders just need to
 *   match the node defs; if anything misfires, this comment block is where to look.
 */

// Node-id allocator for pacing nodes. 7000+ range is free vs your existing ids
// (loadImage 2000+i, prompt 2100+i, audioStart 2200+i, duration 2300+i,
//  subgraph 2400+i, merge 2500+j, VHS_COMBINE 801, S3 9900).
const PACE_NODE_ID = (i, k) => 7000 + i * 20 + k;

const DEFAULT_PACING = {
    enabled: false,
    beatAFrac: 0.45,   // Beat A = first 45% of the clip
    beatBStartFrac: 0.58, // Beat B starts at 58% (the ~13% gap between is the "cut")
    cropScale: 0.8,    // punch-in crop = 80% of frame, scaled back to full → ~1.25x zoom
    panFrac: 0.06,     // alternate horizontal offset of the punch-in per scene, for variety
    scaleMethod: "lanczos",
    speedupEveryNth: 0, // 0/1 = off. 2 = drop every other frame on this scene (extra tighten)
};

function evenRound(v) {
    return Math.max(2, Math.round(v / 2) * 2);
}

/**
 * Build the pacing node chain for one scene and return its producer handle.
 *
 * @param {{ nodes: any[], links: any[], alloc: () => number }} ctx
 * @param {{
 *   sceneIndex: number,
 *   subgraphNode: any,     // the already-pushed NODE.subgraph(i) object (mutated for fan-out)
 *   srcSlot: number,       // IMAGE_BATCH output slot on the subgraph (1)
 *   width: number, height: number,
 *   frames: number,        // total frames in this scene's batch (e.g. 121)
 *   pacing: object,
 *   posX?: number, posY?: number,
 * }} p
 * @returns {{ nodeId: number, slot: number, link: number }} producer feeding the merge chain
 */
function buildPacingNodes(ctx, p) {
    const { nodes, links, alloc } = ctx;
    const cfg = { ...DEFAULT_PACING, ...(p.pacing || {}) };
    const i = p.sceneIndex;
    const W = p.width;
    const H = p.height;
    const F = Math.max(8, p.frames | 0);

    const id = (k) => PACE_NODE_ID(i, k);
    const X = p.posX ?? -900;
    const Y0 = p.posY ?? 0;

    // Frame ranges for the two beats (drop the middle → snap cut).
    const numA = Math.max(2, Math.round(F * cfg.beatAFrac));
    const startB = Math.min(F - 2, Math.round(F * cfg.beatBStartFrac));
    const numB = Math.max(2, F - startB);

    // Punch-in crop box for Beat B (alternate the horizontal anchor per scene).
    const cropW = evenRound(W * cfg.cropScale);
    const cropH = evenRound(H * cfg.cropScale);
    const maxX = W - cropW;
    const maxY = H - cropH;
    const centerX = Math.round(maxX / 2);
    const dir = i % 2 === 0 ? 1 : -1; // even scenes pan right of center, odd pan left
    const x = Math.min(maxX, Math.max(0, centerX + dir * Math.round(W * cfg.panFrac)));
    const y = Math.min(maxY, Math.max(0, Math.round(maxY / 2)));

    // Links
    const lkA = alloc();   // subgraph → rangeA.images
    const lkB = alloc();   // subgraph → rangeB.images
    const lkAout = alloc();// rangeA → merge.images_A
    const lkBout = alloc();// rangeB → crop.image
    const lkCrop = alloc();// crop → scale.image
    const lkScale = alloc();// scale → merge.images_B
    const lkOut = alloc(); // merge → (consumer wired by the merge chain)

    // Fan out the subgraph IMAGE_BATCH output to BOTH range nodes.
    // (Replaces the single original subgraph→merge link.)
    const sgOut = p.subgraphNode.outputs[p.srcSlot];
    sgOut.links = [lkA, lkB];

    // Beat A — wide, first slice
    nodes.push({
        id: id(0),
        type: "GetImageRangeFromBatch",
        pos: [X, Y0],
        size: [250, 110],
        flags: {},
        order: 40 + i * 10 + 0,
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: lkA, slot_index: 0 }],
        outputs: [
            { name: "IMAGE", type: "IMAGE", slot_index: 0, links: [lkAout] },
            { name: "MASK", type: "MASK", slot_index: 1, links: [] },
        ],
        title: `S${i + 1} Beat A (0..${numA})`,
        properties: { "Node name for S&R": "GetImageRangeFromBatch" },
        widgets_values: [0, numA],
    });

    // Beat B — second slice (gets the punch-in)
    nodes.push({
        id: id(1),
        type: "GetImageRangeFromBatch",
        pos: [X, Y0 + 130],
        size: [250, 110],
        flags: {},
        order: 40 + i * 10 + 1,
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: lkB, slot_index: 0 }],
        outputs: [
            { name: "IMAGE", type: "IMAGE", slot_index: 0, links: [lkBout] },
            { name: "MASK", type: "MASK", slot_index: 1, links: [] },
        ],
        title: `S${i + 1} Beat B (${startB}..${startB + numB})`,
        properties: { "Node name for S&R": "GetImageRangeFromBatch" },
        widgets_values: [startB, numB],
    });

    // Crop (punch-in) on Beat B
    nodes.push({
        id: id(2),
        type: "ImageCrop",
        pos: [X + 270, Y0 + 130],
        size: [250, 130],
        flags: {},
        order: 40 + i * 10 + 2,
        mode: 0,
        inputs: [{ name: "image", type: "IMAGE", link: lkBout, slot_index: 0 }],
        outputs: [{ name: "IMAGE", type: "IMAGE", slot_index: 0, links: [lkCrop] }],
        title: `S${i + 1} punch-in crop`,
        properties: { "Node name for S&R": "ImageCrop" },
        widgets_values: [cropW, cropH, x, y],
    });

    // Scale cropped frames back up to full WxH (= the zoom-in)
    nodes.push({
        id: id(3),
        type: "ImageScale",
        pos: [X + 540, Y0 + 130],
        size: [250, 130],
        flags: {},
        order: 40 + i * 10 + 3,
        mode: 0,
        inputs: [{ name: "image", type: "IMAGE", link: lkCrop, slot_index: 0 }],
        outputs: [{ name: "IMAGE", type: "IMAGE", slot_index: 0, links: [lkScale] }],
        title: `S${i + 1} rescale → ${W}x${H}`,
        properties: { "Node name for S&R": "ImageScale" },
        widgets_values: [cfg.scaleMethod, W, H, "disabled"],
    });

    // Concat Beat A + (punched-in) Beat B
    const mergeNodeId = id(4);
    nodes.push({
        id: mergeNodeId,
        type: "VHS_MergeImages",
        pos: [X + 810, Y0 + 60],
        size: [280, 90],
        flags: {},
        order: 40 + i * 10 + 4,
        mode: 0,
        inputs: [
            { name: "images_A", type: "IMAGE", link: lkAout, slot_index: 0 },
            { name: "images_B", type: "IMAGE", link: lkScale, slot_index: 1 },
        ],
        outputs: [{ name: "IMAGE", type: "IMAGE", slot_index: 0, links: [lkOut] }],
        title: `S${i + 1} pacing A+B`,
        properties: { "Node name for S&R": "VHS_MergeImages" },
        widgets_values: {
            merge_strategy: "match A",
            scale_method: "nearest-exact",
            crop: "disabled",
        },
    });

    // Internal links
    links.push(
        { id: lkA, origin_id: p.subgraphNode.id, origin_slot: p.srcSlot, target_id: id(0), target_slot: 0, type: "IMAGE" },
        { id: lkB, origin_id: p.subgraphNode.id, origin_slot: p.srcSlot, target_id: id(1), target_slot: 0, type: "IMAGE" },
        { id: lkBout, origin_id: id(1), origin_slot: 0, target_id: id(2), target_slot: 0, type: "IMAGE" },
        { id: lkCrop, origin_id: id(2), origin_slot: 0, target_id: id(3), target_slot: 0, type: "IMAGE" },
        { id: lkAout, origin_id: id(0), origin_slot: 0, target_id: mergeNodeId, target_slot: 0, type: "IMAGE" },
        { id: lkScale, origin_id: id(3), origin_slot: 0, target_id: mergeNodeId, target_slot: 1, type: "IMAGE" }
    );

    let producer = { nodeId: mergeNodeId, slot: 0, link: lkOut };

    // Optional extra tighten: drop every Nth frame of the whole paced clip.
    if (cfg.speedupEveryNth && cfg.speedupEveryNth >= 2) {
        const lkSpeedIn = lkOut;
        const lkSpeedOut = alloc();
        const speedId = id(5);
        // re-point merge output into the speed node
        nodes.find((n) => n.id === mergeNodeId).outputs[0].links = [lkSpeedIn];
        nodes.push({
            id: speedId,
            type: "VHS_SelectEveryNthImage",
            pos: [X + 1110, Y0 + 60],
            size: [260, 90],
            flags: {},
            order: 40 + i * 10 + 5,
            mode: 0,
            inputs: [{ name: "images", type: "IMAGE", link: lkSpeedIn, slot_index: 0 }],
            outputs: [
                { name: "IMAGE", type: "IMAGE", slot_index: 0, links: [lkSpeedOut] },
                { name: "count", type: "INT", slot_index: 1, links: [] },
            ],
            title: `S${i + 1} speed x${cfg.speedupEveryNth}`,
            properties: { "Node name for S&R": "VHS_SelectEveryNthImage" },
            // widgets: [select_every_nth, skip_first_images]
            widgets_values: [cfg.speedupEveryNth, 0],
        });
        links.push({ id: lkSpeedIn, origin_id: mergeNodeId, origin_slot: 0, target_id: speedId, target_slot: 0, type: "IMAGE" });
        producer = { nodeId: speedId, slot: 0, link: lkSpeedOut };
    }

    return producer;
}

/**
 * Resolve a producer { nodeId, slot, link } for every scene.
 * Paced (product) scenes get the pacing chain; talkvid scenes pass through unchanged.
 *
 * @returns {Array<{nodeId:number, slot:number, link:number}>}
 */
function resolveSceneProducers({ scenes, nodes, links, alloc, NODE, resolution, pacing, sceneImageBatchLinks, layout = {} }) {
    const enabled = !!(pacing && pacing.enabled);
    const YB = layout.YB ?? -12;
    const YS = layout.YS ?? 650;
    const XPACE = layout.XPACE ?? -900;

    // The subgraph's IMAGE_BATCH frames are POST-upscale, not width×height.
    // Derive the real output frame size: scale width/height by (upscale / longer-edge).
    const longerEdge = Math.max(resolution.width, resolution.height);
    const sf = (resolution.upscale || longerEdge) / longerEdge;
    const outW = Math.round((resolution.width * sf) / 2) * 2;
    const outH = Math.round((resolution.height * sf) / 2) * 2;

    return scenes.map((scene, i) => {
        const passthrough = {
            nodeId: NODE.subgraph(i),
            slot: 1,
            link: sceneImageBatchLinks[i],
        };
        // Bypass: pacing disabled, or this is a talkvid scene (protect lip-sync).
        if (!enabled || scene.talkvid !== false) return passthrough;

        const subgraphNode = nodes.find((n) => n.id === NODE.subgraph(i));
        if (!subgraphNode) return passthrough;

        const frames = Math.round((scene.duration || 5) * 24) + 1;
        return buildPacingNodes(
            { nodes, links, alloc },
            {
                sceneIndex: i,
                subgraphNode,
                srcSlot: 1,
                width: outW,
                height: outH,
                frames,
                pacing,
                posX: XPACE,
                posY: YB + i * YS,
            }
        );
    });
}

/**
 * Pacing-aware rewrite of your merge chain. Same VHS_MergeImages cascade as before,
 * but reads inputs from `sceneProducers` (which may be a subgraph OR a pacing chain).
 *
 * @returns {number} lastMergeOutputLink — wire this into VHS_COMBINE images input.
 */
function buildMergeChain({ sceneProducers, nodes, links, alloc, NODE, layout = {} }) {
    const N = sceneProducers.length;
    const XM = layout.XM ?? -400;
    const YB = layout.YB ?? -12;

    if (N === 1) {
        const p0 = sceneProducers[0];
        links.push({
            id: p0.link,
            origin_id: p0.nodeId,
            origin_slot: p0.slot,
            target_id: NODE.VHS_COMBINE,
            target_slot: 0,
            type: "IMAGE",
        });
        return p0.link;
    }

    let lastMergeOutputLink;
    for (let j = 0; j < N - 1; j++) {
        const mergeId = NODE.merge(j);
        const prodA = sceneProducers[0];
        const prodB = sceneProducers[j + 1];
        const inputA = j === 0 ? prodA.link : lastMergeOutputLink;
        const inputB = prodB.link;
        const outputLink = alloc();
        lastMergeOutputLink = outputLink;

        const labelA = j === 0 ? "S1" : `S1…S${j + 1}`;
        const labelB = `S${j + 2}`;

        nodes.push({
            id: mergeId,
            type: "VHS_MergeImages",
            pos: [XM, YB + j * 180],
            size: [280, 90],
            flags: {},
            order: 200 + j,
            mode: 0,
            inputs: [
                { name: "images_A", type: "IMAGE", link: inputA, slot_index: 0 },
                { name: "images_B", type: "IMAGE", link: inputB, slot_index: 1 },
            ],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [outputLink], slot_index: 0 }],
            title: `Merge ${labelA}+${labelB}`,
            properties: { "Node name for S&R": "VHS_MergeImages" },
            widgets_values: {
                merge_strategy: "match A",
                scale_method: "nearest-exact",
                crop: "disabled",
            },
        });

        // merge output → next merge (or VHS)
        links.push({
            id: outputLink,
            origin_id: mergeId,
            origin_slot: 0,
            target_id: j < N - 2 ? NODE.merge(j + 1) : NODE.VHS_COMBINE,
            target_slot: 0,
            type: "IMAGE",
        });

        // producer B → this merge (slot 1)
        links.push({
            id: inputB,
            origin_id: prodB.nodeId,
            origin_slot: prodB.slot,
            target_id: mergeId,
            target_slot: 1,
            type: "IMAGE",
        });

        // producer A → first merge (slot 0)
        if (j === 0) {
            links.push({
                id: inputA,
                origin_id: prodA.nodeId,
                origin_slot: prodA.slot,
                target_id: mergeId,
                target_slot: 0,
                type: "IMAGE",
            });
        }
    }
    return lastMergeOutputLink;
}

module.exports = {
    PACE_NODE_ID,
    DEFAULT_PACING,
    buildPacingNodes,
    resolveSceneProducers,
    buildMergeChain,
};