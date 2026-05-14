/**
 * Worker A: Main API Gateway Handler
 * Handles HTTP requests for resources, credits, and pricing.
 */

"use strict";

const { response } = require("./utils");
const { handleGetHello } = require("./handlers/hello");
const { handleGetUser } = require("./handlers/user");
const { handleGetCredit } = require("./handlers/credit");
const { handleGetUsage } = require("./handlers/usage");
const { handleGetPricing } = require("./handlers/pricing");
const { handleGetTopup, handlePostSnap } = require("./handlers/topup");
const { handlePostResource } = require("./handlers/resource");

// ─── Main Handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const { httpMethod, path, pathParameters } = event;
    const route = `${httpMethod} ${path}`;

    if (route === "GET /hello") return handleGetHello();
    if (route === "GET /user") return handleGetUser(event);
    if (route === "GET /credit") return handleGetCredit(event);
    if (route === "GET /usage") return handleGetUsage(event);
    if (route.startsWith("GET /pricing/")) return handleGetPricing(event, pathParameters.key);
    if (route.startsWith("GET /topup/")) return handleGetTopup(event, pathParameters.order_id);
    if (route === "POST /snap") return handlePostSnap(event);
    if (route === "POST /resource") return handlePostResource(event);
    if (route === "GET /presigned") {
      const { handleGetPresigned } = require("./handlers/resource");
      return handleGetPresigned(event);
    }

    return response(404, { error: `Route ${route} not found.` });
  } catch (err) {
    console.error("Global handler error", err);
    return response(500, { error: err.message });
  }
};
