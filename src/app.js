/**
 * Worker A: Main API Gateway Handler
 * Handles HTTP requests for resources, credits, and pricing.
 */

"use strict";

const { response } = require("./utils");
const { handleGetHello } = require("./handlers/hello");
const { handleGetUser, handlePostSellerFeedback } = require("./handlers/user");
const { handleGetCredit } = require("./handlers/credit");
const { handleGetUsage, handleRateUsage, handleUpdateLlmResponse } = require("./handlers/usage");
const { handleGetPricing, handleListPricing, handleLikePricing } = require("./handlers/pricing");
const { handleGetTopup, handlePostSnap } = require("./handlers/topup");
const { handlePostResource } = require("./handlers/resource");
const { handleListVouchers, handleCreateVoucher, handleClaimVoucher, handleDeactivateVoucher, handleDeleteVoucher, handleActivateVoucher } = require("./handlers/voucher");

// ─── Main Handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const { httpMethod, path, pathParameters } = event;
    const route = `${httpMethod} ${path}`;

    if (route === "GET /hello") return handleGetHello();
    if (route === "GET /user") return handleGetUser(event);
    if (route === "POST /user/seller") return handlePostSellerFeedback(event);
    if (route === "GET /credit") return handleGetCredit(event);
    if (route === "GET /usage") return handleGetUsage(event);
    if (route === "GET /pricing") return handleListPricing(event);
    if (route.startsWith("POST /pricing/") && route.endsWith("/like")) return handleLikePricing(event, pathParameters.key);
    if (route.startsWith("GET /pricing/")) return handleGetPricing(event, pathParameters.key);
    if (route.startsWith("GET /topup/")) return handleGetTopup(event, pathParameters.orderId || pathParameters.order_id);
    if (route === "POST /snap") return handlePostSnap(event);
    if (route === "POST /resource") return handlePostResource(event);
    if (route === "POST /vouchers/claim") return handleClaimVoucher(event);
    if (route === "GET /admin/vouchers") return handleListVouchers(event);
    if (route === "POST /admin/vouchers") return handleCreateVoucher(event);
    if (route.startsWith("PUT /admin/vouchers/") && route.endsWith("/deactivate")) return handleDeactivateVoucher(event);
    if (route.startsWith("PUT /admin/vouchers/") && route.endsWith("/activate")) return handleActivateVoucher(event);
    if (route.startsWith("DELETE /admin/vouchers/")) return handleDeleteVoucher(event);
    if (route.startsWith("PUT /usage/") && route.endsWith("/rating")) return handleRateUsage(event);
    if (route.startsWith("PUT /usage/") && route.endsWith("/llm_response")) return handleUpdateLlmResponse(event);
    if (route === "GET /jobs/status" || route === "POST /jobs/status") {
      const { handleBatchStatus } = require("./handlers/jobStatus");
      return handleBatchStatus(event);
    }
    if (route === "GET /presigned") {
      const { handleGetPresigned } = require("./handlers/resource");
      return handleGetPresigned(event);
    }
    if (path.startsWith("/mock-kieai")) {
      const { handleMockKieAi } = require("./handlers/mockKieAi");
      return handleMockKieAi(event);
    }

    return response(404, { error: `Route ${route} not found.` });
  } catch (err) {
    console.error("Global handler error", err);
    return response(500, { error: err.message });
  }
};
