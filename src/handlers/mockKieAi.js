"use strict";

const { response } = require("../utils");

const KIE_MOCK_IMAGE_URL = process.env.KIE_MOCK_IMAGE_URL || "https://gambr-public.s3.ap-southeast-1.amazonaws.com/library/default_talent.png";
const KIE_MOCK_VIDEO_URL = process.env.KIE_MOCK_VIDEO_URL || "https://gambr-public.s3.ap-southeast-1.amazonaws.com/_product_jeans.mp4";

exports.handleMockKieAi = async (event) => {
  const method = event.httpMethod;
  const path = event.path || "";
  console.log(`[Mock Kie.ai] HTTP ${method} ${path}`);

  let body = {};
  if (event.body) {
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
      console.warn("[Mock Kie.ai] Failed to parse request body:", e.message);
    }
  }

  // 1. Mock file upload
  if (path.includes("/file-url-upload")) {
    console.log("[Mock Kie.ai] Simulating file url upload response");
    return response(200, {
      success: true,
      data: {
        downloadUrl: body.fileUrl || KIE_MOCK_IMAGE_URL
      }
    });
  }

  // 2. Mock image task creation (createTask)
  if (path.includes("/createTask")) {
    console.log("[Mock Kie.ai] Simulating createTask (image generation)");
    const taskId = "mock-img-task-" + Math.floor(Math.random() * 1000000);
    const callBackUrl = body.callBackUrl;

    if (callBackUrl) {
      // Simulate real processing time by sleeping 500ms
      await new Promise(r => setTimeout(r, 500));
      
      console.log(`[Mock Kie.ai] Sending callback to: ${callBackUrl}`);
      try {
        const res = await fetch(callBackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: 200,
            success: true,
            data: {
              taskId: taskId,
              status: "success",
              downloadUrl: KIE_MOCK_IMAGE_URL
            }
          })
        });
        console.log(`[Mock Kie.ai] Callback response status: ${res.status}`);
      } catch (err) {
        console.error(`[Mock Kie.ai] Callback failed:`, err.message);
      }
    }

    return response(200, {
      code: 200,
      success: true,
      taskId: taskId,
      data: { taskId: taskId }
    });
  }

  // 3. Mock video task creation (veo/generate)
  if (path.includes("/veo/generate") || path.includes("/generate")) {
    console.log("[Mock Kie.ai] Simulating veo/generate (video generation)");
    const taskId = "mock-vid-task-" + Math.floor(Math.random() * 1000000);
    const callBackUrl = body.callBackUrl;

    if (callBackUrl) {
      // Simulate video processing time by sleeping 1000ms
      await new Promise(r => setTimeout(r, 1000));
      
      console.log(`[Mock Kie.ai] Sending callback to: ${callBackUrl}`);
      try {
        const res = await fetch(callBackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: 200,
            success: true,
            data: {
              taskId: taskId,
              status: "success",
              video_url: KIE_MOCK_VIDEO_URL
            }
          })
        });
        console.log(`[Mock Kie.ai] Callback response status: ${res.status}`);
      } catch (err) {
        console.error(`[Mock Kie.ai] Callback failed:`, err.message);
      }
    }

    return response(200, {
      code: 200,
      success: true,
      taskId: taskId,
      data: { taskId: taskId }
    });
  }

  // 4. Mock recordInfo (task status check)
  if (path.includes("/jobs/recordInfo") || path.includes("/recordInfo")) {
    console.log("[Mock Kie.ai] Simulating jobs/recordInfo (status check)");
    const taskId = event.queryStringParameters?.taskId || "mock-task-123";
    const isImage = taskId.includes("img");
    return response(200, {
      code: 200,
      success: true,
      data: {
        taskId: taskId,
        status: "success",
        downloadUrl: isImage ? KIE_MOCK_IMAGE_URL : undefined,
        video_url: isImage ? undefined : KIE_MOCK_VIDEO_URL
      }
    });
  }

  return response(404, { error: "Route not found in Mock Kie.ai router" });
};
