"use strict";

const { s3Client, GetObjectCommand, getSignedUrl, batchGetJobStatus } = require("../services");
const { response, getClaims, normalizeUserEmail, parseBody } = require("../utils");

const S3_RESOURCE_BUCKET = process.env.S3_RESOURCE_BUCKET;

/**
 * Handle batch polling for job status
 * GET /jobs/status?ids=uuid1,uuid2
 * or POST /jobs/status { ids: ["uuid1", "uuid2"] }
 */
exports.handleBatchStatus = async (event) => {
    const claims = getClaims(event);
    const userEmail = normalizeUserEmail(claims.email || claims.username);
    
    if (!userEmail) {
        return response(401, { error: "Unauthorized" });
    }

    let jobIds = [];
    if (event.httpMethod === "POST") {
        const body = parseBody(event);
        jobIds = Array.isArray(body.ids) ? body.ids : [];
    } else {
        const qs = event.queryStringParameters || {};
        const idsStr = qs.ids || "";
        jobIds = idsStr.split(",").filter(id => id.trim().length > 0);
    }

    if (jobIds.length === 0) {
        return response(400, { error: "No job IDs provided" });
    }

    // Limit to 25 items (DynamoDB BatchGetItem limit)
    const uniqueIds = [...new Set(jobIds)].slice(0, 25);

    try {
        const keys = uniqueIds.map(id => ({ 
            uuid: id, 
            user_email: userEmail 
        }));

        const items = await batchGetJobStatus(keys);
        
        // Process each item to add signed URLs
        const processedItems = await Promise.all(items.map(async (item) => {
            const out = {
                uuid: item.uuid,
                status: item.status,
                request_type: item.request_type,
                prompt: item.prompt,
                credit_amount: item.credit_amount,
                created_at: item.created_at,
                s3_keys: item.s3_keys || [],
                llm_response: null,
                preview: item.preview ?? null,
                aspect_ratio: item.aspect_ratio ?? null,
                generated_scenes: item.generated_scenes ?? null,
                error_message: item.error_message ?? null,
                result_url: item.result_url || null,
                generated_image: item.generated_image || null
            };
            
            // Sanitize llm_response to hide prompts
            if (item.llm_response) {
                const sanitizedLlm = JSON.parse(JSON.stringify(item.llm_response));
                const sanitizeScenes = (scenes) => {
                    if (!Array.isArray(scenes)) return;
                    scenes.forEach(s => {
                        delete s.image_prompt;
                        delete s.prompt_image;
                        delete s.ltx_prompt;
                        delete s.motion_prompt;
                        delete s.video_prompt;
                        delete s.negative_prompt;
                        delete s.negative_image_prompt;
                        delete s.prompt;
                    });
                };
                sanitizeScenes(sanitizedLlm.scene);
                sanitizeScenes(sanitizedLlm.scenes);
                
                // Remove top-level locks or other internals if needed, but they might be useful.
                // At least prompts are stripped.
                delete sanitizedLlm.system_prompt;
                delete sanitizedLlm.raw_prompt;
                
                out.llm_response = sanitizedLlm;
            }

            // Sign Thumbnail (Flux Image)
            if (item.generated_image) {
                try {
                    out.thumbnail_url = await getSignedUrl(s3Client, new GetObjectCommand({
                        Bucket: S3_RESOURCE_BUCKET,
                        Key: item.generated_image
                    }), { expiresIn: 3600 });
                } catch (e) {
                    console.error(`Error signing thumbnail for ${item.uuid}`, e);
                }
            }

            // Sign Result (Video or Final Image)
            if (item.result_url && item.status === "COMPLETED") {
                try {
                    out.result_url = await getSignedUrl(s3Client, new GetObjectCommand({
                        Bucket: S3_RESOURCE_BUCKET,
                        Key: item.result_url
                    }), { expiresIn: 3600 });
                } catch (e) {
                    console.error(`Error signing result for ${item.uuid}`, e);
                }
            }

            // Sign Input Images (s3_keys)
            if (Array.isArray(out.s3_keys) && out.s3_keys.length > 0) {
                out.s3_keys = await Promise.all(out.s3_keys.map(async (key) => {
                    if (key && !key.startsWith("http")) {
                        try {
                            return await getSignedUrl(s3Client, new GetObjectCommand({
                                Bucket: S3_RESOURCE_BUCKET,
                                Key: key
                            }), { expiresIn: 3600 });
                        } catch (e) {
                            return key;
                        }
                    }
                    return key;
                }));
            }

            return out;
        }));

        return response(200, { 
            data: processedItems,
            count: processedItems.length
        });

    } catch (err) {
        console.error("[BatchStatus] Error:", err);
        return response(500, { error: "Internal server error", message: err.message });
    }
};
