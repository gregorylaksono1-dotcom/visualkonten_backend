"use strict";

const ssmPath = process.env.CONFIG_SSM_PATH || "";
const isDev = ssmPath.includes("/dev") || ssmPath === "" || ssmPath === "/visualkonten/dev";

const KIEAI_MOCK_BASE = "https://xayhmg0s7b.execute-api.ap-southeast-1.amazonaws.com/dev/mock-kieai";

const FILE_UPLOAD_URL = isDev
  ? `${KIEAI_MOCK_BASE}/file-url-upload`
  : "https://kieai.redpandaai.co/api/file-url-upload";

const CREATE_TASK_URL = isDev
  ? `${KIEAI_MOCK_BASE}/createTask`
  : "https://api.kie.ai/api/v1/jobs/createTask";

const RECORD_INFO_BASE = isDev
  ? `${KIEAI_MOCK_BASE}/jobs/recordInfo`
  : "https://api.kie.ai/api/v1/jobs/recordInfo";

/**
 * Helper to upload a publicly accessible S3 URL to Kie.ai's temporary storage.
 * Kie.ai's models require input files to be uploaded first to get a Kie.ai temporary URL.
 */
async function uploadToKie(s3Url, kieApiKey) {
  console.log(`[Kie.ai] Uploading asset to Kie.ai temporary storage: ${s3Url.split("?")[0]}`);
  try {
    const resp = await fetch(FILE_UPLOAD_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${kieApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileUrl: s3Url,
        uploadPath: "images/inputs"
      })
    });

    if (!resp.ok) {
      throw new Error(`Kie.ai file upload failed with status ${resp.status}: ${await resp.text()}`);
    }

    const resJson = await resp.json();
    if (!resJson.success || !resJson.data?.downloadUrl) {
      throw new Error(`Kie.ai file upload response invalid: ${JSON.stringify(resJson)}`);
    }

    console.log(`[Kie.ai] Successfully uploaded. Kie temporary URL: ${resJson.data.downloadUrl}`);
    return resJson.data.downloadUrl;
  } catch (err) {
    console.error(`[Kie.ai] Error in uploadToKie:`, err.message);
    throw err;
  }
}

/**
 * Submits a generation task to Kie.ai.
 */
async function createKieTask(model, input, callBackUrl, kieApiKey) {
  console.log(`[Kie.ai] Creating generation task for model: ${model}`);
  console.log(`[Kie.ai] Using API Key: ${kieApiKey ? (kieApiKey.slice(0, 8) + "..." + kieApiKey.slice(-4)) : "UNDEFINED"} (Length: ${kieApiKey ? kieApiKey.length : 0})`);
  try {
    const payload = {
      model,
      input
    };
    if (callBackUrl) {
      payload.callBackUrl = callBackUrl;
    }

    console.log(`[Kie.ai Request] Payload: ${JSON.stringify(payload, null, 2)}`);

    const resp = await fetch(CREATE_TASK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${kieApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const respText = await resp.text();
    console.log(`[Kie.ai Response] Status: ${resp.status}, Body: ${respText}`);

    if (!resp.ok) {
      throw new Error(`Kie.ai task creation failed with status ${resp.status}: ${respText}`);
    }

    const resJson = JSON.parse(respText);
    const taskId = resJson.taskId || resJson.data?.taskId;
    if (resJson.code !== 200 || !taskId) {
      throw new Error(`Kie.ai task creation returned error code/no taskId: ${JSON.stringify(resJson)}`);
    }

    console.log(`[Kie.ai] Task created successfully. Task ID: ${taskId}`);
    return taskId;
  } catch (err) {
    console.error(`[Kie.ai] Error in createKieTask:`, err.message);
    throw err;
  }
}

/**
 * Submits a video generation task to Kie.ai (Veo or Seedance).
 */
async function createVeoTask(model, input, callBackUrl, kieApiKey) {
  console.log(`[Kie.ai] Creating video task for model: ${model}`);
  try {
    const isSeedance = model.includes("seedance") || model.includes("bytedance");

    let url;
    let payload;

    if (isSeedance) {
      // Seedance uses ComfyUI createTask endpoint (with inputs wrapped in 'input')
      url = isDev
        ? `${KIEAI_MOCK_BASE}/veo/generate`
        : "https://api.kie.ai/api/v1/jobs/createTask";
      
      payload = {
        model,
        input
      };
      if (callBackUrl) {
        payload.callBackUrl = callBackUrl;
      }
    } else {
      // Veo models use native /veo/generate endpoint (inputs are flattened at top level)
      url = isDev
        ? `${KIEAI_MOCK_BASE}/veo/generate`
        : "https://api.kie.ai/api/v1/veo/generate";

      payload = {
        model,
        prompt: input.prompt,
        imageUrls: input.imageUrls,
        aspect_ratio: input.aspect_ratio,
        duration: input.duration
      };
      if (callBackUrl) {
        payload.callBackUrl = callBackUrl;
      }
    }

    console.log(`[Kie.ai Request] Endpoint: ${url}, Payload: ${JSON.stringify(payload, null, 2)}`);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${kieApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const respText = await resp.text();
    console.log(`[Kie.ai Response] Status: ${resp.status}, Body: ${respText}`);

    if (!resp.ok) {
      throw new Error(`Kie.ai task creation failed with status ${resp.status}: ${respText}`);
    }

    const resJson = JSON.parse(respText);
    const taskId = resJson.taskId || resJson.data?.taskId;
    if (resJson.code !== 200 || !taskId) {
      throw new Error(`Kie.ai task creation returned error code/no taskId: ${JSON.stringify(resJson)}`);
    }

    console.log(`[Kie.ai] Task created successfully. Task ID: ${taskId}`);
    return taskId;
  } catch (err) {
    console.error(`[Kie.ai] Error in createVeoTask:`, err.message);
    throw err;
  }
}

/**
 * Query task details/status from Kie.ai.
 */
async function getKieTaskStatus(taskId, kieApiKey, isVeo = false) {
  try {
    const useVeoEndpoint = isVeo || String(taskId).includes("vid") || String(taskId).includes("mock-vid");
    const url = isDev
      ? `${KIEAI_MOCK_BASE}/jobs/recordInfo?taskId=${taskId}`
      : (useVeoEndpoint
          ? `https://api.kie.ai/api/v1/veo/record-info?taskId=${taskId}`
          : `${RECORD_INFO_BASE}?taskId=${taskId}`);

    console.log(`[Kie.ai] Checking task status. Url: ${url}`);
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${kieApiKey}`
      }
    });

    if (!resp.ok) {
      throw new Error(`Kie.ai status check failed: ${resp.status}`);
    }

    const resJson = await resp.json();
    return resJson;
  } catch (err) {
    console.error(`[Kie.ai] Error in getKieTaskStatus for ${taskId}:`, err.message);
    throw err;
  }
}

/**
 * Recursively search a data object for any string starting with http and ending with a media format.
 */
function findMediaUrlInKieData(data) {
  if (!data) return null;

  // Try parsing nested resultJson if present
  let parsedData = data;
  if (data.data) {
    parsedData = data.data;
  }
  if (typeof parsedData.resultJson === "string") {
    try {
      const parsedJson = JSON.parse(parsedData.resultJson);
      if (Array.isArray(parsedJson.resultUrls) && parsedJson.resultUrls.length > 0) {
        return parsedJson.resultUrls[0];
      }
      if (parsedJson.url) return parsedJson.url;
      if (parsedJson.downloadUrl) return parsedJson.downloadUrl;
    } catch (e) {
      console.warn("[Kie.ai Helper] Failed to parse resultJson as JSON string:", e.message);
    }
  }

  const directKeys = [
    "result_video_url", "video_url", 
    "result_image_url", "image_url", 
    "resultImageUrl", "imageUrl", 
    "url", "downloadUrl"
  ];
  for (const key of directKeys) {
    if (typeof parsedData[key] === "string" && parsedData[key].startsWith("http")) {
      return parsedData[key];
    }
  }

  if (parsedData.info) {
    for (const key of directKeys) {
      if (typeof parsedData.info[key] === "string" && parsedData.info[key].startsWith("http")) {
        return parsedData.info[key];
      }
    }
  }

  const searchObj = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    for (const val of Object.values(obj)) {
      if (typeof val === "string" && val.startsWith("http")) {
        if (/\.(mp4|webm|png|jpg|jpeg|gif|webp)/i.test(val)) {
          return val;
        }
      } else if (typeof val === "object") {
        const found = searchObj(val);
        if (found) return found;
      }
    }
    return null;
  };

  return searchObj(parsedData);
}

module.exports = {
  uploadToKie,
  createKieTask,
  createVeoTask,
  getKieTaskStatus,
  findMediaUrlInKieData
};
