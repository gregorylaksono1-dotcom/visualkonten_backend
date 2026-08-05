const { response, getClaims } = require("../utils");
const { getUserProfile } = require("../services");
const { sendTelegramMessage } = require("../lib/telegram");

exports.handleGetUser = async (event) => {
  const userId = getClaims(event).sub;
  if (!userId) return response(401, { error: "Unauthorized: missing user id claim." });

  const profile = await getUserProfile(userId);
  return response(200, { data: profile });
};

exports.handlePostSellerFeedback = async (event) => {
  const email = getClaims(event).email;
  if (!email) return response(401, { error: "Unauthorized: missing email claim." });

  try {
    await sendTelegramMessage(`${email} adalah seller`);
    return response(200, { message: "Feedback recorded" });
  } catch (error) {
    console.error("Failed to send telegram message", error);
    return response(500, { error: "Failed to process feedback" });
  }
};
