const { response } = require("../utils");
const { resolvePricingRow, listAllPricingRows, incrementPricingPopularity } = require("../services");

exports.handleGetPricing = async (event, pricingKeyParam) => {
  const decodedKey = decodeURIComponent(String(pricingKeyParam).trim());
  if (!decodedKey) return response(400, { error: "Missing pricing key." });

  const resolved = await resolvePricingRow(decodedKey);
  if (!resolved) return response(404, { error: `Pricing not found for key "${decodedKey}".` });

  return response(200, {
    data: { 
      key: resolved.item.key, 
      charge: resolved.item.charge, 
      amount: resolved.amount, 
      attr: resolved.item.attr,
      description: resolved.item.description || null,
      coming_soon: resolved.item.coming_soon === true || resolved.item.coming_soon === "true"
    },
  });
};

exports.handleListPricing = async (event) => {
  try {
    const rows = await listAllPricingRows();
    const activeRows = rows.filter(item => item.disabled !== true && item.disabled !== "true");
    const formatted = activeRows.map((item) => {
      let categories = [];
      if (item.category) {
        if (item.category instanceof Set) {
          categories = Array.from(item.category);
        } else if (Array.isArray(item.category)) {
          categories = item.category;
        } else if (typeof item.category === "object" && item.category.values) {
          categories = Array.from(item.category.values);
        } else if (typeof item.category === "string") {
          categories = [item.category];
        }
      }

      return {
        key: item.key,
        charge: item.charge,
        attr: item.attr,
        category: categories,
        prompt: item.prompt,
        sample: item.sample,
        caption: item.caption,
        description: item.description || null,
        popularity: item.popularity !== undefined ? Number(item.popularity) : 0,
        coming_soon: item.coming_soon === true || item.coming_soon === "true",
      };
    });
    return response(200, { data: formatted });
  } catch (err) {
    console.error("handleListPricing error:", err.message);
    return response(500, { error: err.message });
  }
};

exports.handleLikePricing = async (event, pricingKeyParam) => {
  const decodedKey = decodeURIComponent(String(pricingKeyParam).trim());
  if (!decodedKey) return response(400, { error: "Missing pricing key." });

  try {
    const updatedPopularity = await incrementPricingPopularity(decodedKey);
    return response(200, {
      data: { key: decodedKey, popularity: updatedPopularity },
    });
  } catch (err) {
    console.error("handleLikePricing error:", err.message);
    return response(500, { error: err.message });
  }
};
