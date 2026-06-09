"use strict";

const { SSMClient, GetParametersByPathCommand } = require("@aws-sdk/client-ssm");

const region = process.env.AWS_REGION || "ap-southeast-1";
const DEFAULT_CONFIG_PATH = "/visualkonten/sbx";

let ssmClient = null;
let cachedConfig = null;

const getConfigPath = () => {
  const path = process.env.CONFIG_SSM_PATH || DEFAULT_CONFIG_PATH;
  return path.endsWith("/") ? path.slice(0, -1) : path;
};

const loadConfig = async () => {
  if (cachedConfig) return cachedConfig;

  if (!ssmClient) ssmClient = new SSMClient({ region });

  const path = getConfigPath();
  console.log(`[SSM] Loading config from path: ${path}`);

  try {
    const config = {};
    let nextToken;

    do {
      const out = await ssmClient.send(
        new GetParametersByPathCommand({
          Path: path,
          Recursive: true,
          WithDecryption: true,
          MaxResults: 10,
          NextToken: nextToken,
        })
      );

      for (const param of out.Parameters || []) {
        const prefix = `${path}/`;
        const key = param.Name.startsWith(prefix)
          ? param.Name.slice(prefix.length)
          : param.Name.split("/").pop();
        config[key] = param.Value;
      }

      nextToken = out.NextToken;
    } while (nextToken);

    cachedConfig = config;
    return config;
  } catch (err) {
    console.error("[SSM] Failed to load config:", err);
    return {};
  }
};

/** @deprecated use loadConfig — kept for call sites that still say getSecrets */
const getSecrets = loadConfig;

const parseJsonConfig = (raw) => {
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
};

module.exports = {
  getConfig: loadConfig,
  getSecrets,
  parseJsonConfig,
};
