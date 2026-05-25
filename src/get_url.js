const { getComfyApiKeys, getOutputUrl } = require("./services.js");
(async () => {
  try {
    const keys = await getComfyApiKeys();
    const apiKey = keys.split(",")[0].trim();
    const url = await getOutputUrl("9374d4d9-2f77-4d4b-85f5-66a48c6db3d0", apiKey);
    console.log("DOWNLOAD_URL:", url);
  } catch (err) {
    console.error(err);
  }
})();
