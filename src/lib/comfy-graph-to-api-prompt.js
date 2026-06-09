"use strict";

/**
 * Convert ComfyUI workflow graph format (nodes + links + definitions.subgraphs)
 * into API prompt dict. This expands subgraph nodes so Comfy /prompt can run
 * without relying on subgraph UUID class types being registered as node types.
 */
function graphToApiPrompt(workflowGraph) {
  if (!workflowGraph || !Array.isArray(workflowGraph.nodes) || !Array.isArray(workflowGraph.links)) {
    throw new Error("Workflow graph tidak valid: butuh fields nodes[] dan links[].");
  }

  const outerLinkById = new Map();
  for (const lk of workflowGraph.links) {
    if (!lk || lk.id == null) continue;
    outerLinkById.set(Number(lk.id), lk);
  }

  const subgraphDefs = new Map();
  for (const sg of workflowGraph.definitions?.subgraphs || []) {
    if (sg?.id) subgraphDefs.set(String(sg.id), sg);
  }

  const orderedNodes = [...workflowGraph.nodes].sort((a, b) => {
    const ao = Number(a?.order ?? 0);
    const bo = Number(b?.order ?? 0);
    if (ao !== bo) return ao - bo;
    return Number(a?.id ?? 0) - Number(b?.id ?? 0);
  });

  const prompt = {};
  const subgraphOutputRefs = new Map(); // "<subgraphNodeId>:<slot>" -> [sourceNodeId, sourceSlot]
  const outerNodeById = new Map(
    orderedNodes.filter((n) => n?.id != null).map((n) => [Number(n.id), n])
  );

  // 1) Expand subgraph nodes.
  for (const node of orderedNodes) {
    if (!node || node.id == null || !node.type) continue;
    const sgDef = subgraphDefs.get(String(node.type));
    if (!sgDef) continue;

    expandSubgraphNode({
      subgraphNode: node,
      subgraphDef: sgDef,
      outerLinkById,
      prompt,
      subgraphOutputRefs,
    });
  }

  // 2) Convert regular outer nodes, rewiring links from subgraph outputs.
  for (const node of orderedNodes) {
    if (!node || node.id == null || !node.type) continue;
    if (subgraphDefs.has(String(node.type))) continue;
    if (isRerouteType(node.type)) continue;

    const nodeId = String(node.id);
    const entry = convertNodeToPromptEntry(node, (linkId) => {
      const lk = resolveLinkThroughReroutes(
        Number(linkId),
        outerLinkById,
        outerNodeById
      );
      if (!lk) {
        throw new Error(`Link ${linkId} tidak ditemukan untuk node ${nodeId}.`);
      }
      const subOutKey = `${String(lk.origin_id)}:${Number(lk.origin_slot ?? 0)}`;
      const remap = subgraphOutputRefs.get(subOutKey);
      if (remap) return remap;
      return [String(lk.origin_id), Number(lk.origin_slot ?? 0)];
    });

    prompt[nodeId] = {
      inputs: entry.inputs,
      class_type: node.type,
    };
  }

  return prompt;
}

function expandSubgraphNode({
  subgraphNode,
  subgraphDef,
  outerLinkById,
  prompt,
  subgraphOutputRefs,
}) {
  const sgLinks = Array.isArray(subgraphDef.links)
    ? subgraphDef.links
    : (subgraphDef.state?.links || []);
  const sgNodes = Array.isArray(subgraphDef.nodes)
    ? subgraphDef.nodes
    : (subgraphDef.state?.nodes || []);

  const sgLinkById = new Map();
  for (const lk of sgLinks) {
    if (lk?.id != null) sgLinkById.set(Number(lk.id), lk);
  }
  const sgNodeById = new Map(
    sgNodes.filter((n) => n?.id != null).map((n) => [Number(n.id), n])
  );

  const internalIdMap = new Map(); // internal node id -> prompt node id string
  for (const n of sgNodes) {
    if (!n || n.id == null) continue;
    const mappedId = Number(subgraphNode.id) * 10000 + Number(n.id);
    internalIdMap.set(Number(n.id), String(mappedId));
  }

  // Map each "subgraph input link id" to outer source ref.
  const externalInputByLinkId = new Map();
  const outerWidgetValuesByInput = extractWidgetInputValues(subgraphNode);
  for (const sgInput of subgraphDef.inputs || []) {
    const inputName = sgInput?.name;
    if (!inputName) continue;
    const outerInput = (subgraphNode.inputs || []).find((x) => x?.name === inputName);
    if (!outerInput) continue;
    let sourceRef = null;
    if (outerInput.link != null) {
      const outerLink = outerLinkById.get(Number(outerInput.link));
      if (outerLink) {
        sourceRef = [String(outerLink.origin_id), Number(outerLink.origin_slot ?? 0)];
      }
    } else if (Object.prototype.hasOwnProperty.call(outerWidgetValuesByInput, inputName)) {
      sourceRef = outerWidgetValuesByInput[inputName];
    } else if (outerInput.widget) {
      const fromInstance = readWidgetValueByInputName(subgraphNode, inputName);
      if (fromInstance !== undefined) sourceRef = fromInstance;
    }
    if (sourceRef == null) continue;
    for (const lid of sgInput.linkIds || []) {
      externalInputByLinkId.set(Number(lid), sourceRef);
    }
  }

  for (const internalNode of sgNodes) {
    if (!internalNode || internalNode.id == null || !internalNode.type) continue;
    if (isRerouteType(internalNode.type)) continue;
    const mappedNodeId = internalIdMap.get(Number(internalNode.id));
    if (!mappedNodeId) continue;

    const entry = convertNodeToPromptEntry(internalNode, (linkId) => {
      const lid = Number(linkId);
      if (externalInputByLinkId.has(lid)) {
        return externalInputByLinkId.get(lid);
      }

      const lk = resolveLinkThroughReroutes(lid, sgLinkById, sgNodeById);
      if (!lk) {
        throw new Error(
          `Link internal ${lid} tidak ditemukan pada subgraph ${subgraphDef.id} (instance ${subgraphNode.id}).`
        );
      }
      // -10 is subgraph virtual input node. If this input is not wired from outer
      // graph, skip it so node keeps its own default/widget value.
      if (Number(lk.origin_id) === -10) {
        return null;
      }
      const mappedFrom = internalIdMap.get(Number(lk.origin_id));
      if (!mappedFrom) {
        throw new Error(
          `Origin node ${lk.origin_id} tidak ditemukan pada subgraph ${subgraphDef.id} (instance ${subgraphNode.id}).`
        );
      }
      return [mappedFrom, Number(lk.origin_slot ?? 0)];
    });

    prompt[mappedNodeId] = {
      inputs: entry.inputs,
      class_type: internalNode.type,
    };
  }

  // Map outer subgraph output slots to internal source refs.
  (subgraphDef.outputs || []).forEach((sgOut, outputSlotIdx) => {
    const outputLinkId = (sgOut?.linkIds || [])[0];
    if (outputLinkId == null) return;
    const outLink = sgLinkById.get(Number(outputLinkId));
    if (!outLink) return;
    const mappedFrom = internalIdMap.get(Number(outLink.origin_id));
    if (!mappedFrom) return;
    const key = `${String(subgraphNode.id)}:${Number(outputSlotIdx)}`;
    subgraphOutputRefs.set(key, [mappedFrom, Number(outLink.origin_slot ?? 0)]);
  });
}

function isRerouteType(type) {
  return String(type || "").toLowerCase() === "reroute";
}

/**
 * Follow reroute links until a non-reroute origin node is found.
 * Returns resolved link object or null.
 */
function resolveLinkThroughReroutes(linkId, linkById, nodeById, seen = new Set()) {
  const lid = Number(linkId);
  if (seen.has(lid)) return null;
  seen.add(lid);

  const lk = linkById.get(lid);
  if (!lk) return null;
  const originNode = nodeById.get(Number(lk.origin_id));
  if (!originNode || !isRerouteType(originNode.type)) {
    return lk;
  }

  const upstreamLinkId = (originNode.inputs || []).find((inp) => inp?.link != null)?.link;
  if (upstreamLinkId == null) return null;
  return resolveLinkThroughReroutes(Number(upstreamLinkId), linkById, nodeById, seen);
}

function readWidgetValueByInputName(node, inputName) {
  const widgetValues = node?.widgets_values;
  if (!widgetValues) return undefined;
  if (typeof widgetValues === "object" && !Array.isArray(widgetValues)) {
    if (widgetValues[inputName] !== undefined) return widgetValues[inputName];
    const inp = (node.inputs || []).find((x) => x?.name === inputName);
    const widgetName = inp?.widget?.name;
    if (widgetName && widgetValues[widgetName] !== undefined) {
      return widgetValues[widgetName];
    }
  }
  if (!Array.isArray(widgetValues)) return undefined;
  let widgetIndex = 0;
  for (const inp of node.inputs || []) {
    if (!inp?.widget) continue;
    const key = inp.widget?.name || inp.name;
    const val = widgetValues[widgetIndex++];
    if (inp.name === inputName || key === inputName) return val;
  }
  return undefined;
}

function isEmptyWidgetValue(value) {
  return value === "" || value === null || value === undefined;
}

function convertNodeToPromptEntry(node, resolveLinkRef) {
  const inputs = {};
  const widgetValues = node.widgets_values;
  const widgetArray = Array.isArray(widgetValues) ? widgetValues : [];
  const widgetObject =
    widgetValues && typeof widgetValues === "object" && !Array.isArray(widgetValues)
      ? widgetValues
      : null;

  if (widgetObject) {
    for (const [k, v] of Object.entries(widgetObject)) {
      if (!isEmptyWidgetValue(v)) inputs[k] = v;
    }
  }

  let widgetIndex = 0;
  for (const inp of node.inputs || []) {
    if (!inp || !inp.name) continue;

    let widgetVal;
    if (inp.widget) {
      if (widgetObject) {
        const wn = inp.widget?.name || inp.name;
        if (!isEmptyWidgetValue(widgetObject[wn])) widgetVal = widgetObject[wn];
        else if (!isEmptyWidgetValue(widgetObject[inp.name])) widgetVal = widgetObject[inp.name];
      }
      if (widgetVal === undefined && widgetIndex < widgetArray.length) {
        widgetVal = widgetArray[widgetIndex];
      }
      widgetIndex++;
    }

    if (inp.link != null) {
      const resolved = resolveLinkRef(inp.link);
      if (resolved != null) {
        inputs[inp.name] = resolved;
      } else if (widgetVal !== undefined && !isEmptyWidgetValue(widgetVal)) {
        inputs[inp.name] = widgetVal;
      }
      continue;
    }

    if (widgetVal !== undefined && !isEmptyWidgetValue(widgetVal)) {
      inputs[inp.name] = widgetVal;
    }
  }

  applyWidgetIndexFallback(node.type, widgetArray, inputs);

  const fallbackKeys = WIDGET_INPUT_KEYS_BY_TYPE[node.type] || [];
  if (fallbackKeys.length && widgetArray.length) {
    for (let i = 0; i < fallbackKeys.length && i < widgetArray.length; i++) {
      const key = fallbackKeys[i];
      if (
        (inputs[key] === undefined || isEmptyWidgetValue(inputs[key])) &&
        !isEmptyWidgetValue(widgetArray[i])
      ) {
        inputs[key] = widgetArray[i];
      }
    }
  }

  applyDefaultWidgets(node.type, inputs);
  normalizeNodeInputs(node.type, inputs);

  return { inputs };
}

function normalizeNodeInputs(nodeType, inputs) {
  if (nodeType === "ResizeImageMaskNode") {
    if (inputs.crop !== undefined && inputs["resize_type.crop"] === undefined) {
      inputs["resize_type.crop"] = inputs.crop;
      delete inputs.crop;
    }
    if (
      inputs["resize_type.crop"] === undefined ||
      isEmptyWidgetValue(inputs["resize_type.crop"])
    ) {
      inputs["resize_type.crop"] = "center";
    }

    if (inputs["resize_type.width"] !== undefined) delete inputs.width;
    if (inputs["resize_type.height"] !== undefined) delete inputs.height;
    return;
  }

  if (nodeType === "TextGenerateLTX2Prompt") {
    const modeValue =
      typeof inputs.sampling_mode === "string"
        ? inputs.sampling_mode
        : inputs.sampling_mode?.sampling_mode;
    const samplingMode = {
      selection: modeValue && String(modeValue).trim() ? modeValue : "on",
      sampling_mode: modeValue && String(modeValue).trim() ? modeValue : "on",
      temperature:
        inputs.temperature === undefined || isEmptyWidgetValue(inputs.temperature)
          ? 0.7
          : inputs.temperature,
      top_k: inputs.top_k === undefined || isEmptyWidgetValue(inputs.top_k) ? 64 : inputs.top_k,
      top_p:
        inputs.top_p === undefined || isEmptyWidgetValue(inputs.top_p) ? 0.95 : inputs.top_p,
      min_p:
        inputs.min_p === undefined || isEmptyWidgetValue(inputs.min_p) ? 0.05 : inputs.min_p,
      repetition_penalty:
        inputs.repetition_penalty === undefined || isEmptyWidgetValue(inputs.repetition_penalty)
          ? 1.05
          : inputs.repetition_penalty,
      seed: inputs.seed === undefined || isEmptyWidgetValue(inputs.seed) ? 0 : inputs.seed,
    };
    // Compatibility layer across ComfyUI builds:
    // - some expect `sampling_mode` as plain string
    // - some expect dynamic-combo object
    // - some expect flattened dotted keys (sampling_mode.top_p, etc)
    inputs.sampling_mode = samplingMode.sampling_mode;
    inputs["sampling_mode.selection"] = samplingMode.selection;
    inputs["sampling_mode.sampling_mode"] = samplingMode.sampling_mode;
    inputs["sampling_mode.temperature"] = samplingMode.temperature;
    inputs["sampling_mode.top_k"] = samplingMode.top_k;
    inputs["sampling_mode.top_p"] = samplingMode.top_p;
    inputs["sampling_mode.min_p"] = samplingMode.min_p;
    inputs["sampling_mode.repetition_penalty"] = samplingMode.repetition_penalty;
    inputs["sampling_mode.seed"] = samplingMode.seed;
    delete inputs.temperature;
    delete inputs.top_k;
    delete inputs.top_p;
    delete inputs.min_p;
    delete inputs.repetition_penalty;
    delete inputs.seed;
  }
}

function applyWidgetIndexFallback(nodeType, widgetArray, inputs) {
  const indexMap = WIDGET_INDEX_BY_TYPE[nodeType];
  if (!indexMap || !widgetArray.length) return;
  for (const [key, idx] of Object.entries(indexMap)) {
    if (inputs[key] !== undefined && !isEmptyWidgetValue(inputs[key])) continue;
    if (idx < widgetArray.length && !isEmptyWidgetValue(widgetArray[idx])) {
      inputs[key] = widgetArray[idx];
    }
  }
}

function applyDefaultWidgets(nodeType, inputs) {
  const defaults = DEFAULT_WIDGETS_BY_TYPE[nodeType];
  if (!defaults) return;
  for (const [key, value] of Object.entries(defaults)) {
    if (inputs[key] === undefined || isEmptyWidgetValue(inputs[key])) {
      inputs[key] = value;
    }
  }
}

function extractWidgetInputValues(node) {
  const out = {};
  const widgetValues = node.widgets_values;
  if (widgetValues && typeof widgetValues === "object" && !Array.isArray(widgetValues)) {
    return { ...widgetValues };
  }
  const widgetArray = Array.isArray(widgetValues) ? widgetValues : [];
  let widgetIndex = 0;
  for (const inp of node.inputs || []) {
    if (!inp || !inp.name) continue;
    if (inp.widget && widgetIndex < widgetArray.length) {
      out[inp.name] = widgetArray[widgetIndex++];
    }
  }
  return out;
}

/** Widget array index → API input name (when inputs[] metadata is incomplete). */
const WIDGET_INDEX_BY_TYPE = {
  LTXAVTextEncoderLoader: {
    text_encoder: 0,
    ckpt_name: 1,
    device: 2,
  },
  ResizeImageMaskNode: {
    resize_type: 0,
    "resize_type.crop": 3,
    scale_method: 4,
  },
  TextGenerateLTX2Prompt: {
    prompt: 0,
    max_length: 1,
    sampling_mode: 2,
    temperature: 3,
    top_k: 4,
    top_p: 5,
    min_p: 6,
    repetition_penalty: 7,
    seed: 8,
    seed_control_before_generate: 9,
    cache_model: 10,
    use_image: 11,
  },
};

const DEFAULT_WIDGETS_BY_TYPE = {
  VHS_MergeImages: {
    merge_strategy: "match A",
    scale_method: "nearest-exact",
    crop: "disabled",
  },
};

const WIDGET_INPUT_KEYS_BY_TYPE = {
  PrimitiveStringMultiline: ["value"],
  PrimitiveInt: ["value"],
  PrimitiveFloat: ["value"],
  LoadImage: ["image", "channel"],
  LoadAudio: ["audio"],
  AudioPad: ["pad_start_seconds", "pad_end_seconds"],
  CheckpointLoaderSimple: ["ckpt_name"],
  LoraLoader: ["lora_name", "strength_model", "strength_clip"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  LatentUpscaleModelLoader: ["model_name"],
  ResizeImagesByLongerEdge: ["longer_edge"],
  LTXVAudioVAELoader: ["ckpt_name"],
  LTXVPreprocess: ["img_compression"],
  LTXVImgToVideoInplace: ["strength", "bypass"],
  SolidMask: ["value", "width", "height"],
  RandomNoise: ["noise_seed", "control_after_generate"],
  CLIPTextEncode: ["text"],
  CFGGuider: ["cfg"],
  KSamplerSelect: ["sampler_name"],
  ManualSigmas: ["sigmas"],
  ComfyMathExpression: ["expression"],
  EmptyLTXVLatentVideo: ["width", "height", "length", "batch_size"],
  VAEDecodeTiled: ["tile_size", "overlap", "temporal_size", "temporal_overlap"],
};

module.exports = { graphToApiPrompt };

