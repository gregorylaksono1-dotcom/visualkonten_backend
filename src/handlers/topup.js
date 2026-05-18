const { response, getClaims, normalizeUserEmail, parseBody, generateFriendlyOrderId, formatMidtransStartTime, pickEnabledPaymentsByNominal } = require("../utils");
const { docClient, QueryCommand, PutCommand, createMidtransSnapTransaction } = require("../services");

const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;
const TOPUP_CREDIT_TABLE_NAME = process.env.TOPUP_CREDIT_TABLE_NAME;
const MIDTRANS_FINISH_CALLBACK_URL = process.env.MIDTRANS_FINISH_CALLBACK_URL;

exports.handleGetTopup = async (event, topupOrderId) => {
  const claims = getClaims(event);
  const userEmail = claims.email || claims["cognito:username"] || claims.username;
  if (!userEmail) return response(401, { error: "Unauthorized: missing email claim." });

  const decodedId = decodeURIComponent(String(topupOrderId));
  const res = await docClient.send(new QueryCommand({
    TableName: TOPUP_CREDIT_TABLE_NAME,
    KeyConditionExpression: "#uuid = :orderId",
    ExpressionAttributeNames: {
      "#uuid": "uuid",
    },
    ExpressionAttributeValues: { ":orderId": decodedId },
  }));
  const item = res.Items?.[0];
  if (!item) return response(404, { error: "Order not found." });
  if (normalizeUserEmail(item.user_email) !== normalizeUserEmail(userEmail)) {
    return response(403, { error: "Access denied." });
  }

  let creditBalance = null;
  const userIdFromTopup = String(item.user_id || "").trim();
  if (userIdFromTopup) {
    try {
      const profileResult = await docClient.send(
        new QueryCommand({
          TableName: PROFILE_TABLE_NAME,
          KeyConditionExpression: "user_id = :userId",
          ExpressionAttributeValues: {
            ":userId": userIdFromTopup,
          },
          Limit: 1,
        })
      );
      const profileItem = profileResult.Items?.[0] || null;
      if (profileItem?.credit_balance !== undefined && profileItem?.credit_balance !== null) {
        const n = Number(profileItem.credit_balance);
        creditBalance = Number.isFinite(n) ? n : null;
      }
    } catch (err) {
      console.error("Error fetching credit balance for topup response:", err);
    }
  }

  return response(200, { data: { ...item, credit_balance: creditBalance } });
};

exports.handlePostSnap = async (event) => {
  const claims = getClaims(event);
  const userEmail = claims.email || claims.username;
  const userId = claims.sub;
  if (!userEmail || !userId) return response(401, { error: "Unauthorized." });

  const body = parseBody(event);
  const { total_credit, total_price } = body;
  if (!total_credit || !total_price) return response(400, { error: "Missing required fields." });

  const orderId = generateFriendlyOrderId(userId);
  const now = new Date().toISOString();

  await docClient.send(new PutCommand({
    TableName: TOPUP_CREDIT_TABLE_NAME,
    Item: {
      uuid: orderId, user_email: userEmail, user_id: userId,
      created_at: now, updated_at: now, amount: total_credit, total: total_price, status: "PENDING",
    },
  }));

  const midtransBody = {
    transaction_details: { order_id: orderId, gross_amount: total_price },
    enabled_payments: pickEnabledPaymentsByNominal(total_price),
    customer_details: { first_name: claims.name || "Customer", email: userEmail, user_id: userId },
    expiry: { start_time: formatMidtransStartTime(), unit: "minutes", duration: 60 },
    custom_field1: userId, custom_field2: userEmail, custom_field3: orderId,
  };

  const finishCallback = body.finish_callback_url || MIDTRANS_FINISH_CALLBACK_URL;
  if (finishCallback) midtransBody.callbacks = { finish: finishCallback };

  try {
    const snapData = await createMidtransSnapTransaction(midtransBody);
    return response(200, { data: { ...snapData, order_id: orderId } });
  } catch (err) {
    return response(500, { error: err.message });
  }
};
