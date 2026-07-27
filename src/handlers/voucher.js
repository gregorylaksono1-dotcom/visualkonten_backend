"use strict";

const { response, parseBody } = require("../utils");
const { docClient } = require("../services");
const { ScanCommand, PutCommand, GetCommand, TransactWriteCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const VOUCHER_TABLE_NAME = process.env.VOUCHER_TABLE_NAME;
const PROFILE_TABLE_NAME = process.env.PROFILE_TABLE_NAME;
const TOPUP_CREDIT_TABLE_NAME = process.env.TOPUP_CREDIT_TABLE_NAME;

const getClaims = (event) => event?.requestContext?.authorizer?.claims || {};

const generateRandomCode = (length = 8) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

exports.handleListVouchers = async (event) => {
  const claims = getClaims(event);
  if (claims["custom:role"] !== "admin") {
    return response(403, { error: "Forbidden: Admins only" });
  }

  if (!VOUCHER_TABLE_NAME) {
    return response(500, { error: "Voucher table not configured" });
  }

  try {
    const res = await docClient.send(new ScanCommand({ TableName: VOUCHER_TABLE_NAME }));
    return response(200, { data: res.Items || [] });
  } catch (err) {
    console.error("List vouchers error", err);
    return response(500, { error: err.message });
  }
};

exports.handleCreateVoucher = async (event) => {
  const claims = getClaims(event);
  if (claims["custom:role"] !== "admin") {
    return response(403, { error: "Forbidden: Admins only" });
  }

  if (!VOUCHER_TABLE_NAME) {
    return response(500, { error: "Voucher table not configured" });
  }

  const body = parseBody(event);
  const codeInput = String(body.voucher_code || "").trim().toUpperCase();
  const valid_from = body.valid_from;
  const valid_to = body.valid_to;
  const credit_amount = Number(body.credit_amount);
  const is_enabled = body.is_enabled !== undefined ? Boolean(body.is_enabled) : true;
  
  let finalCode = codeInput;
  if (!finalCode) {
    finalCode = generateRandomCode(10);
  } else if (!/^[A-Z0-9]+$/.test(finalCode)) {
    return response(400, { error: "Voucher code must be alphanumeric only (no symbols)" });
  }

  if (finalCode.length > 20) {
    return response(400, { error: "Voucher code maksimal 20 karakter" });
  }

  if (!valid_from || !valid_to) {
    return response(400, { error: "valid_from and valid_to are required" });
  }

  if (!credit_amount || isNaN(credit_amount) || credit_amount <= 0) {
    return response(400, { error: "Voucher credit amount is required and must be greater than 0" });
  }

  try {
    const item = {
      voucher_code: finalCode,
      valid_from,
      valid_to,
      credit_amount,
      is_enabled,
      created_at: new Date().toISOString(),
      created_by: claims.email || claims.username || "admin"
    };

    await docClient.send(
      new PutCommand({
        TableName: VOUCHER_TABLE_NAME,
        Item: item,
        ConditionExpression: "attribute_not_exists(voucher_code)"
      })
    );

    return response(200, { data: item });
  } catch (err) {
    console.error("Create voucher error", err);
    if (err.name === "ConditionalCheckFailedException") {
      return response(400, { error: "Voucher code tersebut sudah terdaftar! Silakan gunakan kode lain." });
    }
    return response(500, { error: err.message });
  }
};

exports.handleClaimVoucher = async (event) => {
  const { getClaims, parseBody } = require("../utils"); // require parseBody here if needed, or it's already imported
  const claims = getClaims(event);
  const userEmail = claims.email || claims["cognito:username"] || claims.username;
  const userId = claims.sub;
  if (!userEmail || !userId) {
    return response(401, { error: "Unauthorized" });
  }

  if (!VOUCHER_TABLE_NAME || !PROFILE_TABLE_NAME || !TOPUP_CREDIT_TABLE_NAME) {
    return response(500, { error: "Table names not configured" });
  }

  const body = parseBody(event);
  const codeInput = String(body.voucher_code || "").trim().toUpperCase();

  if (!codeInput) {
    return response(400, { error: "Voucher code is required" });
  }

  try {
    const voucherRes = await docClient.send(
      new GetCommand({
        TableName: VOUCHER_TABLE_NAME,
        Key: { voucher_code: codeInput }
      })
    );
    const voucher = voucherRes.Item;

    if (!voucher) {
      return response(404, { error: "Voucher tidak ditemukan" });
    }
    if (!voucher.is_enabled) {
      return response(400, { error: "Voucher sudah dinonaktifkan" });
    }
    if (voucher.claimed_at) {
      return response(400, { error: "Voucher sudah diklaim" });
    }
    
    const nowISO = new Date().toISOString();
    if (nowISO < voucher.valid_from) {
      return response(400, { 
        error: "Voucher belum berlaku.", 
        reason: "BEFORE_VALID_DATE", 
        valid_from: voucher.valid_from,
        valid_to: voucher.valid_to
      });
    }
    if (nowISO > voucher.valid_to) {
      return response(400, { 
        error: "Voucher sudah kadaluarsa.", 
        reason: "AFTER_VALID_DATE", 
        valid_from: voucher.valid_from,
        valid_to: voucher.valid_to
      });
    }

    const creditAmount = Number(voucher.credit_amount) || 0;
    if (creditAmount <= 0) {
      return response(400, { error: "Voucher tidak memiliki nilai credit yang valid" });
    }

    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: VOUCHER_TABLE_NAME,
              Key: { voucher_code: codeInput },
              UpdateExpression: "SET claimed_at = :now, claimed_by = :email",
              ConditionExpression: "attribute_not_exists(claimed_at) OR claimed_at = :null",
              ExpressionAttributeValues: {
                ":now": nowISO,
                ":email": userEmail,
                ":null": null
              }
            }
          },
          {
            Update: {
              TableName: PROFILE_TABLE_NAME,
              Key: { user_id: String(userId), user_type: "CUSTOMER" },
              UpdateExpression: "SET credit_balance = if_not_exists(credit_balance, :zero) + :credit, updated_at = :now",
              ConditionExpression: "attribute_exists(user_id)",
              ExpressionAttributeValues: {
                ":zero": 0,
                ":credit": creditAmount,
                ":now": nowISO
              }
            }
          },
          {
            Put: {
              TableName: TOPUP_CREDIT_TABLE_NAME,
              Item: {
                uuid: `VOUCHER-${codeInput}-${Date.now()}`,
                user_email: userEmail,
                user_id: String(userId),
                status: "settlement",
                amount: creditAmount,
                total: 0,
                method: "VOUCHER",
                created_at: nowISO,
                voucher_code: codeInput
              }
            }
          }
        ]
      })
    );

    return response(200, { data: { credit_amount: creditAmount, voucher_code: codeInput } });
  } catch (err) {
    console.error("Claim voucher error", err);
    if (err.name === "TransactionCanceledException") {
      return response(400, { error: "Klaim gagal. Pastikan voucher belum pernah diklaim atau hubungi admin." });
    }
    return response(500, { error: err.message });
  }
};

exports.handleDeactivateVoucher = async (event) => {
  const claims = getClaims(event);
  if (claims["custom:role"] !== "admin") {
    return response(403, { error: "Forbidden: Admins only" });
  }

  const { pathParameters } = event;
  const voucherCode = pathParameters?.voucher_code;
  
  if (!voucherCode) {
    return response(400, { error: "Voucher code is required" });
  }

  if (!VOUCHER_TABLE_NAME) {
    return response(500, { error: "Voucher table not configured" });
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: VOUCHER_TABLE_NAME,
        Key: { voucher_code: voucherCode },
        UpdateExpression: "SET is_enabled = :false",
        ConditionExpression: "attribute_exists(voucher_code)",
        ExpressionAttributeValues: {
          ":false": false
        }
      })
    );

    return response(200, { message: "Voucher deactivated successfully" });
  } catch (err) {
    console.error("Deactivate voucher error", err);
    return response(500, { error: err.message });
  }
};

exports.handleDeleteVoucher = async (event) => {
  const claims = getClaims(event);
  if (claims["custom:role"] !== "admin") {
    return response(403, { error: "Forbidden: Admins only" });
  }

  const { pathParameters } = event;
  const voucherCode = pathParameters?.voucher_code;
  
  if (!voucherCode) {
    return response(400, { error: "Voucher code is required" });
  }

  if (!VOUCHER_TABLE_NAME) {
    return response(500, { error: "Voucher table not configured" });
  }

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: VOUCHER_TABLE_NAME,
        Key: { voucher_code: voucherCode }
      })
    );
    return response(200, { message: "Voucher deleted successfully" });
  } catch (err) {
    console.error("Delete voucher error", err);
    return response(500, { error: err.message });
  }
};

exports.handleActivateVoucher = async (event) => {
  const claims = getClaims(event);
  if (claims["custom:role"] !== "admin") {
    return response(403, { error: "Forbidden: Admins only" });
  }

  const { pathParameters } = event;
  const voucherCode = pathParameters?.voucher_code;
  
  if (!voucherCode) {
    return response(400, { error: "Voucher code is required" });
  }

  if (!VOUCHER_TABLE_NAME) {
    return response(500, { error: "Voucher table not configured" });
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: VOUCHER_TABLE_NAME,
        Key: { voucher_code: voucherCode },
        UpdateExpression: "SET is_enabled = :true",
        ConditionExpression: "attribute_exists(voucher_code)",
        ExpressionAttributeValues: {
          ":true": true
        }
      })
    );

    return response(200, { message: "Voucher activated successfully" });
  } catch (err) {
    console.error("Activate voucher error", err);
    return response(500, { error: err.message });
  }
};
