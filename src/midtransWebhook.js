const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { getJakartaISOString } = require("./utils");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TRANSACTION_TABLE_NAME = process.env.TRANSACTION_TABLE_NAME;
const TOPUP_CREDIT_TABLE_NAME = process.env.TOPUP_CREDIT_TABLE_NAME;
const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": true,
  },
  body: JSON.stringify(body),
});

const parseBody = (event) => {
  if (!event?.body) return {};
  if (typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch {
      return {};
    }
  }
  return event.body;
};

const patchTopupMidtransMeta = async (topupItem, payload, transactionId) => {
  const names = {};
  const parts = ["transaction_id = :tid", "updated_at = :now"];
  const values = {
    ":tid": String(transactionId),
    ":now": getJakartaISOString(),
  };
  if (payload?.payment_type != null && String(payload.payment_type).length > 0) {
    parts.push("#pt = :pt");
    names["#pt"] = "payment_type";
    values[":pt"] = String(payload.payment_type);
  }
  if (payload?.transaction_time != null && String(payload.transaction_time).length > 0) {
    parts.push("#ttm = :ttm");
    names["#ttm"] = "transaction_time";
    values[":ttm"] = String(payload.transaction_time);
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TOPUP_CREDIT_TABLE_NAME,
      Key: {
        uuid: topupItem.uuid,
        user_email: topupItem.user_email,
      },
      UpdateExpression: `SET ${parts.join(", ")}`,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
    })
  );
};

exports.handler = async (event) => {
  try {
    const payload = parseBody(event);
    console.log("payload", payload);
    const transactionId = payload?.transaction_id;
    const transactionStatus = payload?.transaction_status;

    if (!transactionId || !transactionStatus) {
      return response(400, {
        error: "transaction_id and transaction_status are required.",
      });
    }

    await docClient.send(
      new PutCommand({
        TableName: TRANSACTION_TABLE_NAME,
        Item: {
          transaction_id: String(transactionId),
          transaction_status: String(transactionStatus),
          payload,
          received_at: getJakartaISOString(),
        },
      })
    );

    const orderId = payload?.custom_field3 || payload?.order_id;
    if (orderId) {
      const topupResult = await docClient.send(
        new QueryCommand({
          TableName: TOPUP_CREDIT_TABLE_NAME,
          KeyConditionExpression: "#uuid = :orderId",
          ExpressionAttributeNames: {
            "#uuid": "uuid",
          },
          ExpressionAttributeValues: {
            ":orderId": String(orderId),
          },
          Limit: 1,
        })
      );

      const topupItem = topupResult.Items?.[0];
      if (topupItem) {
        await patchTopupMidtransMeta(topupItem, payload, transactionId);
      }
    }

    if (String(transactionStatus).toLowerCase() === "settlement") {
      const orderId = payload?.custom_field3 || payload?.order_id;
      const userId = payload?.custom_field1;

      if (!orderId || !userId) {
        return response(200, {
          message: "Transaction notification stored; settlement skipped (missing user or order id).",
          transaction_id: transactionId,
          transaction_status: transactionStatus,
        });
      }

      const topupResult = await docClient.send(
        new QueryCommand({
          TableName: TOPUP_CREDIT_TABLE_NAME,
          KeyConditionExpression: "#uuid = :orderId",
          ExpressionAttributeNames: {
            "#uuid": "uuid",
          },
          ExpressionAttributeValues: {
            ":orderId": String(orderId),
          },
          Limit: 1,
        })
      );

      const topupItem = topupResult.Items?.[0];
      if (!topupItem) {
        return response(200, {
          message: "Transaction notification stored; topup row not found for settlement.",
          transaction_id: transactionId,
          transaction_status: transactionStatus,
        });
      }

      const amount = Number(topupItem.amount || 0);
      const now = getJakartaISOString();

      const metaNames = {
        "#uuid": "uuid",
        "#user_email": "user_email",
        "#status": "status",
      };
      const metaValues = {
        ":success": "SUCCESS",
        ":updatedAt": now,
        ":tid": String(transactionId),
      };
      let topupUpdate = "SET #status = :success, updated_at = :updatedAt, transaction_id = :tid";
      if (payload?.payment_type != null && String(payload.payment_type).length > 0) {
        topupUpdate += ", #pt = :pt";
        metaNames["#pt"] = "payment_type";
        metaValues[":pt"] = String(payload.payment_type);
      }
      if (payload?.transaction_time != null && String(payload.transaction_time).length > 0) {
        topupUpdate += ", #ttm = :ttm";
        metaNames["#ttm"] = "transaction_time";
        metaValues[":ttm"] = String(payload.transaction_time);
      }

      try {
        await docClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: TOPUP_CREDIT_TABLE_NAME,
                  Key: {
                    uuid: topupItem.uuid,
                    user_email: topupItem.user_email,
                  },
                  UpdateExpression: topupUpdate,
                  ConditionExpression:
                    "attribute_exists(#uuid) AND attribute_exists(#user_email) AND (#status <> :success)",
                  ExpressionAttributeNames: metaNames,
                  ExpressionAttributeValues: metaValues,
                },
              },
              {
                Update: {
                  TableName: PROFILE_TABLE_NAME,
                  Key: {
                    user_id: String(userId),
                    user_type: "CUSTOMER",
                  },
                  UpdateExpression: "SET credit_balance = if_not_exists(credit_balance, :zero) + :amount, updated_at = :updatedAt",
                  ConditionExpression: "attribute_exists(user_id) AND attribute_exists(user_type)",
                  ExpressionAttributeValues: {
                    ":zero": 0,
                    ":amount": amount,
                    ":updatedAt": now,
                  },
                },
              },
            ],
          })
        );
      } catch (err) {
        console.warn("midtrans settlement transact skipped (likely duplicate)", err?.name || err);
      }
    }

    return response(200, {
      message: "Transaction notification stored.",
      transaction_id: transactionId,
      transaction_status: transactionStatus,
    });
  } catch (err) {
    console.error("midtrans webhook error:", err);
    return response(500, { error: err.message || "Internal server error." });
  }
};
