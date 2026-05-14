const { response, getClaims, buildCreditStatusFilterParts } = require("../utils");
const { getLatestCreditMetrics, queryCreditHistoryPaged } = require("../services");

exports.handleGetCredit = async (event) => {
  const userEmail = getClaims(event).email;
  if (!userEmail) return response(401, { error: "Unauthorized: missing email." });

  const qsp = event.queryStringParameters || {};
  const statusGroup = qsp.status || "all";
  const limit = Math.min(Number(qsp.limit || 50), 200);
  const nextToken = qsp.next_token;

  let startKey = null;
  if (nextToken) {
    try {
      startKey = JSON.parse(Buffer.from(nextToken, "base64").toString());
    } catch (e) {}
  }

  const metrics = await getLatestCreditMetrics(userEmail);
  const filter = buildCreditStatusFilterParts(statusGroup);
  const paged = await queryCreditHistoryPaged(userEmail, filter, limit, 50, 10, startKey);

  const resNextToken = paged.lastEvaluatedKey 
    ? Buffer.from(JSON.stringify(paged.lastEvaluatedKey)).toString("base64")
    : null;

  return response(200, {
    data: {
      user_email: userEmail,
      credit_balance: metrics.balance,
      credit_usage: metrics.usage,
      history: paged.items,
      next_token: resNextToken,
    },
  });
};
