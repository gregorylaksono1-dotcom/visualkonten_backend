const { response, getClaims } = require("../utils");
const { docClient, QueryCommand } = require("../services");

const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;

exports.handleGetUser = async (event) => {
  const userId = getClaims(event).sub;
  if (!userId) return response(401, { error: "Unauthorized: missing user id claim." });

  const result = await docClient.send(new QueryCommand({
    TableName: PROFILE_TABLE_NAME,
    KeyConditionExpression: "user_id = :userId",
    ExpressionAttributeValues: { ":userId": userId },
    Limit: 1,
  }));
  return response(200, { data: result.Items?.[0] || null });
};
