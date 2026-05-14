const { response } = require("../utils");
const { resolvePricingRow } = require("../services");

exports.handleGetPricing = async (event, pricingKeyParam) => {
  const decodedKey = decodeURIComponent(String(pricingKeyParam).trim());
  if (!decodedKey) return response(400, { error: "Missing pricing key." });

  const resolved = await resolvePricingRow(decodedKey);
  if (!resolved) return response(404, { error: `Pricing not found for key "${decodedKey}".` });

  return response(200, {
    data: { key: resolved.item.key, charge: resolved.item.charge, amount: resolved.amount, attr: resolved.item.attr },
  });
};
