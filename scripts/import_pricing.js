const fs = require("fs");
const path = require("path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

// Usage check
const tableName = process.argv[2];
if (!tableName) {
  console.error("Usage: node scripts/import_pricing.js <table_name> [region]");
  process.exit(1);
}

const region = process.argv[3] || "ap-southeast-1";
console.log(`Initializing DynamoDB client in region: ${region}...`);

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

const backupPath = path.join(__dirname, "../pricing_backup.json");
if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found at: ${backupPath}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
const items = data.Items || [];

if (items.length === 0) {
  console.error("No items found in backup file.");
  process.exit(1);
}

(async () => {
  console.log(`Starting migration of ${items.length} items to table "${tableName}"...`);
  
  for (const rawItem of items) {
    // Unmarshall from DynamoDB JSON format to standard JSON object
    const item = unmarshall(rawItem);
    console.log(`Writing item with key: "${item.key}"...`);
    try {
      await docClient.send(new PutCommand({
        TableName: tableName,
        Item: item
      }));
      console.log(`  ✓ Successfully wrote "${item.key}"`);
    } catch (err) {
      console.error(`  ✗ Failed to write "${item.key}":`, err.message);
    }
  }
  
  console.log("Migration complete!");
})();
