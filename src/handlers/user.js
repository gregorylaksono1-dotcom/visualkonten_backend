const { response, getClaims } = require("../utils");
const { getUserProfile } = require("../services");

exports.handleGetUser = async (event) => {
  const userId = getClaims(event).sub;
  if (!userId) return response(401, { error: "Unauthorized: missing user id claim." });

  const profile = await getUserProfile(userId);
  return response(200, { data: profile });
};
