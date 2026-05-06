const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;

exports.handler = async (event) => {
  try {
    const triggerSource = event?.triggerSource;
    const userId = event?.request?.userAttributes?.sub;
    const email = event?.request?.userAttributes?.email;
    const name = event?.request?.userAttributes?.name || email || "";

    console.log("postAuth trigger received", {
      triggerSource,
      userId,
      email,
    });

    if (!userId) {
      console.warn("postAuth skipped: missing userId");
      return event;
    }

    await docClient.send(
      new PutCommand({
        TableName: PROFILE_TABLE_NAME,
        Item: {
          user_id: userId,
          user_type: "CUSTOMER",
          email: email || "",
          name,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(user_type)",
      })
    );

    console.log("profile row created", {
      userId,
      userType: "CUSTOMER",
      email,
    });
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") {
      console.error("postAuth trigger error:", err);
    } else {
      console.info("profile row already exists, skip insert");
    }
  }

  return event;
};
