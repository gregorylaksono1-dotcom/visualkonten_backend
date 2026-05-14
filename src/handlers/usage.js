const { response, getClaims, usageEmailCandidates, mapUserRequestUsageRow } = require("../utils");
const { docClient, QueryCommand, scanUserRequestsForUsage } = require("../services");

const USER_REQUEST_TABLE_NAME = process.env.USER_REQUEST_TABLE_NAME;
const USER_REQUEST_USER_EMAIL_INDEX = process.env.USER_REQUEST_USER_EMAIL_INDEX;

exports.handleGetUsage = async (event) => {
  const claims = getClaims(event);
  const email = claims.email || claims.username;
  if (!email) return response(401, { error: "Unauthorized: missing email." });

  const qsp = event.queryStringParameters || {};
  const sinceDays = Number(qsp.since_days || 30);
  const limit = Math.min(Number(qsp.limit || 100), 200);
  const nextToken = qsp.next_token;

  const sinceIso = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
  const candidates = usageEmailCandidates(email);
  const byUuid = new Map();
  let lastEvaluatedKey = null;

  if (USER_REQUEST_USER_EMAIL_INDEX) {
    for (const em of candidates) {
      try {
        const queryParams = {
          TableName: USER_REQUEST_TABLE_NAME,
          IndexName: USER_REQUEST_USER_EMAIL_INDEX,
          KeyConditionExpression: "user_email = :e AND created_at >= :c",
          ExpressionAttributeValues: { ":e": em, ":c": sinceIso },
          ScanIndexForward: false,
          Limit: limit,
        };
        if (nextToken) {
          try {
            queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString());
          } catch (e) {}
        }

        const res = await docClient.send(new QueryCommand(queryParams));
        for (const it of res.Items || []) byUuid.set(it.uuid, it);
        if (res.LastEvaluatedKey) {
          lastEvaluatedKey = Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64");
        }
      } catch (err) {
        console.error("GET /usage GSI error", err.message);
      }
    }
  }

  let items = [...byUuid.values()];
  if (!items.length && !nextToken) {
    items = await scanUserRequestsForUsage(USER_REQUEST_TABLE_NAME, candidates, sinceIso, limit);
  } else {
    items.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }

  return response(200, {
    data: items.slice(0, limit).map(mapUserRequestUsageRow),
    next_token: lastEvaluatedKey,
  });
};
