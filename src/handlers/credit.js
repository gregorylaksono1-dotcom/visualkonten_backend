const { response, getClaims, buildCreditStatusFilterParts, normalizeUserEmail } = require("../utils");
const { queryCreditHistoryPaged, sumSuccessfulSpending } = require("../services");
const { docClient, QueryCommand } = require("../services");

const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;
const TOPUP_CREDIT_TABLE_NAME = process.env.TOPUP_CREDIT_TABLE_NAME;
const TOPUP_CREDIT_USER_EMAIL_INDEX = process.env.TOPUP_CREDIT_USER_EMAIL_INDEX;

exports.handleGetCredit = async (event) => {
  const claims = getClaims(event);
  const userEmail = claims.email || claims["cognito:username"] || claims.username;
  const userId = claims.sub;

  if (!userEmail) {
    return response(401, { error: "Unauthorized: missing email claim." });
  }

  // 1. Fetch live balance, usage & email from the Profile Table
  let liveBalance = 0;
  let liveUsage = 0;
  let profileEmail = "";

  if (userId) {
    try {
      const profileRes = await docClient.send(new QueryCommand({
        TableName: PROFILE_TABLE_NAME,
        KeyConditionExpression: "user_id = :userId",
        ExpressionAttributeValues: { ":userId": userId },
        Limit: 1,
      }));
      const profileItem = profileRes.Items?.[0];
      if (profileItem) {
        liveBalance = Number(profileItem.credit_balance ?? 0);
        liveUsage = Number(profileItem.credit_usage ?? 0);
        profileEmail = profileItem.email || "";
      }
    } catch (err) {
      console.error("Error fetching live profile balance:", err);
    }
  }

  const targetEmail = profileEmail || userEmail;
  const qsp = event.queryStringParameters || {};

  // 2. Handle spent_total_only requested by HistoriPembayaran.tsx
  if (String(qsp.spent_total_only || "") === "1") {
    try {
      const spent_success_total = await sumSuccessfulSpending(targetEmail);
      return response(200, {
        data: [],
        usage: liveUsage,
        balance: liveBalance,
        spent_success_total,
      });
    } catch (err) {
      console.error("Error summing successful spending:", err);
      return response(500, { error: "Failed to load spent total." });
    }
  }

  // 3. Fetch Topup & Credit History
  const statusGroup = String(qsp.status || "all").toLowerCase();
  const limitRaw = qsp.limit != null ? Number(qsp.limit) : NaN;
  const hasExplicitLimit = Number.isFinite(limitRaw);
  const requestedLimit = hasExplicitLimit
    ? Math.min(500, Math.max(1, Math.floor(limitRaw)))
    : statusGroup !== "all"
      ? 200
      : 20;

  const wantsExtendedHistory = hasExplicitLimit || statusGroup !== "all";
  const filterParts = buildCreditStatusFilterParts(statusGroup);
  const nextToken = qsp.next_token;

  let startKey = null;
  if (nextToken) {
    try {
      startKey = JSON.parse(Buffer.from(nextToken, "base64").toString());
    } catch (e) {}
  }

  let items = [];
  let resNextToken = null;

  try {
    if (!wantsExtendedHistory && statusGroup === "all") {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TOPUP_CREDIT_TABLE_NAME,
          IndexName: TOPUP_CREDIT_USER_EMAIL_INDEX,
          KeyConditionExpression: "user_email = :email",
          ExpressionAttributeValues: {
            ":email": targetEmail,
          },
          ScanIndexForward: false,
          Limit: requestedLimit,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        })
      );
      items = result.Items || [];
      if (result.LastEvaluatedKey) {
        resNextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64");
      }
    } else {
      const paged = await queryCreditHistoryPaged(targetEmail, filterParts, requestedLimit, 50, 10, startKey);
      items = paged.items || [];
      if (paged.lastEvaluatedKey) {
        resNextToken = Buffer.from(JSON.stringify(paged.lastEvaluatedKey)).toString("base64");
      }
    }
  } catch (err) {
    console.error("Error querying credit history:", err);
  }

  // 4. Return dual-compatible flat payload
  return response(200, {
    data: items,
    balance: liveBalance,
    usage: liveUsage,
    user_email: targetEmail,
    credit_balance: liveBalance,
    credit_usage: liveUsage,
    history: items,
    next_token: resNextToken,
  });
};
