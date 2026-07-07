"use strict";

/**
 * Helper to upload a publicly accessible S3 URL to Kie.ai's temporary storage.
 * Kie.ai's models require input files to be uploaded first to get a Kie.ai temporary URL.
 */
async function uploadToKie(s3Url, kieApiKey) {
  console.log(`[Kie.ai] Uploading asset to Kie.ai temporary storage: ${s3Url.split("?")[0]}`);
  try {
    const resp = await fetch("https://kieai.redpandaai.co/api/file-url-upload", {
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

    const resp = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
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
 * Query task details/status from Kie.ai.
 */
async function getKieTaskStatus(taskId, kieApiKey) {
  try {
    const resp = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, {
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
  getKieTaskStatus,
  findMediaUrlInKieData
};
