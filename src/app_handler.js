exports.handler = async (event) => {
  try {
    const routeKey = `${event.httpMethod} ${event.path}`;

    if (routeKey === "GET /hello") {
      return response(200, { message: "Hello World from BikinAi.com backend!" });
    }

    if (routeKey === "GET /user") {
      const claims = getClaims(event);
      const userId = claims.sub;
      if (!userId) {
        return response(401, { error: "Unauthorized: missing user id claim." });
      }

      const result = await docClient.send(
        new QueryCommand({
          TableName: PROFILE_TABLE_NAME,
          KeyConditionExpression: "user_id = :userId",
          ExpressionAttributeValues: {
            ":userId": userId,
          },
          Limit: 1,
        })
      );

      return response(200, { data: result.Items?.[0] || null });
    }

    const pricingKeyParam = event.pathParameters?.key;
    if (event.httpMethod === "GET" && pricingKeyParam) {
      const path = event.path || "";
      const resource = event.resource || "";
      const looksLikePricing =
        path.includes("/pricing/") ||
        resource === "/pricing/{key}" ||
        String(resource).includes("/pricing/");
      if (looksLikePricing) {
        if (!PRICING_TABLE_NAME) {
          return response(500, { error: "PRICING_TABLE_NAME is not configured." });
        }
        const decodedKey = decodeURIComponent(String(pricingKeyParam).trim());
        if (!decodedKey) {
          return response(400, { error: "Missing pricing key." });
        }
        const resolved = await resolvePricingRow(decodedKey);
        if (!resolved) {
          return response(404, { error: `Pricing not found for key "${decodedKey}".` });
        }
        return response(200, {
          data: {
            key: resolved.item.key,
            charge: resolved.item.charge,
            amount: resolved.amount,
          },
        });
      }
    }

    const topupOrderId = event.pathParameters?.orderId;
    if (event.httpMethod === "GET" && topupOrderId) {
      const path = event.path || "";
      const resource = event.resource || "";
      const looksLikeTopup =
        path.includes("/topup/") ||
        resource === "/topup/{orderId}" ||
        resource.includes("/topup/");
      if (looksLikeTopup) {
        const claims = getClaims(event);
        const userEmail =
          claims.email ||
          claims["cognito:username"] ||
          claims.username;
        if (!userEmail) {
          return response(401, { error: "Unauthorized: missing email claim." });
        }

        const decodedId = decodeURIComponent(String(topupOrderId));
        const topupResult = await docClient.send(
          new QueryCommand({
            TableName: TOPUP_CREDIT_TABLE_NAME,
            KeyConditionExpression: "#uuid = :orderId",
            ExpressionAttributeNames: {
              "#uuid": "uuid",
            },
            ExpressionAttributeValues: {
              ":orderId": decodedId,
            },
            Limit: 1,
          })
        );
        const item = topupResult.Items?.[0];
        if (!item || item.user_email !== userEmail) {
          return response(404, { error: "Topup not found." });
        }
        let creditBalance = null;
        const userIdFromTopup = String(item.user_id || "").trim();
        if (userIdFromTopup) {
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
        }
        return response(200, { data: { ...item, credit_balance: creditBalance } });
      }
    }

    if (routeKey === "GET /credit") {
      const claims = getClaims(event);
      const userEmail =
        claims.email ||
        claims["cognito:username"] ||
        claims.username;
      if (!userEmail) {
        return response(401, { error: "Unauthorized: missing email claim." });
      }

      const qs = event.queryStringParameters || {};
      if (String(qs.spent_total_only || "") === "1") {
        const { usage, balance } = await getLatestCreditMetrics(userEmail);
        const spent_success_total = await sumSuccessfulSpending(userEmail);
        return response(200, {
          data: [],
          usage,
          balance,
          spent_success_total,
        });
      }

      const statusGroup = String(qs.status || "all").toLowerCase();
      const limitRaw = qs.limit != null ? Number(qs.limit) : NaN;
      const hasExplicitLimit = Number.isFinite(limitRaw);
      const requestedLimit = hasExplicitLimit
        ? Math.min(500, Math.max(1, Math.floor(limitRaw)))
        : statusGroup !== "all"
          ? 200
          : 20;
      const wantsExtendedHistory =
        hasExplicitLimit || statusGroup !== "all";

      const filterParts = buildCreditStatusFilterParts(statusGroup);

      let items;
      if (!wantsExtendedHistory && statusGroup === "all") {
        const result = await docClient.send(
          new QueryCommand({
            TableName: TOPUP_CREDIT_TABLE_NAME,
            IndexName: TOPUP_CREDIT_USER_EMAIL_INDEX,
            KeyConditionExpression: "user_email = :email",
            ExpressionAttributeValues: {
              ":email": userEmail,
            },
            ScanIndexForward: false,
            Limit: 20,
          })
        );
        items = result.Items || [];
      } else {
        const maxItems = requestedLimit;
        items = await queryCreditHistoryPaged(
          userEmail,
          filterParts,
          maxItems,
          50,
          40
        );
      }

      const latestItem = items[0] || {};
      const usageFromItems = items.reduce(
        (total, item) => total + Number(item.usage || 0),
        0
      );
      const usage = Number(latestItem.usage ?? usageFromItems ?? 0);
      const balance = Number(latestItem.balance ?? 0);

      const body = {
        data: items,
        usage,
        balance,
      };
      if (wantsExtendedHistory) {
        const metrics = await getLatestCreditMetrics(userEmail);
        body.usage = metrics.usage;
        body.balance = metrics.balance;
      }

      return response(200, body);
    }

    if (
      String(event.httpMethod || "").toUpperCase() === "GET" &&
      pathEndsWithResource(event, "/usage")
    ) {
      if (!USER_REQUEST_TABLE_NAME) {
        return response(500, { error: "USER_REQUEST_TABLE_NAME is not configured." });
      }

      const claims = getClaims(event);
      const userEmailRaw =
        claims.email || claims["cognito:username"] || claims.username;
      if (!userEmailRaw) {
        return response(401, { error: "Unauthorized: missing email claim." });
      }

      const candidates = usageEmailCandidates(userEmailRaw);
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceIso = since.toISOString();

      const byUuid = new Map();

      if (USER_REQUEST_USER_EMAIL_INDEX) {
        for (const email of candidates) {
          try {
            const result = await docClient.send(
              new QueryCommand({
                TableName: USER_REQUEST_TABLE_NAME,
                IndexName: USER_REQUEST_USER_EMAIL_INDEX,
                KeyConditionExpression:
                  "user_email = :email AND created_at >= :since",
                ExpressionAttributeValues: {
                  ":email": email,
                  ":since": sinceIso,
                },
                ScanIndexForward: false,
                Limit: 100,
              })
            );
            for (const it of result.Items || []) {
              if (it?.uuid) byUuid.set(it.uuid, it);
            }
          } catch (err) {
            console.error("GET /usage GSI query failed", {
              name: err?.name,
              message: err?.message,
            });
          }
        }
      }

      let items = [...byUuid.values()];
      /* Baris tanpa created_at tidak ikut GSI; index belum deploy; atau email beda format → Scan terbatas. */
      if (!items.length) {
        const scanned = await scanUserRequestsForUsage(
          USER_REQUEST_TABLE_NAME,
          candidates,
          sinceIso,
          100
        );
        for (const it of scanned) {
          if (it?.uuid) byUuid.set(it.uuid, it);
        }
        items = [...byUuid.values()];
      }

      items.sort((a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
      );
      const data = items.slice(0, 100).map(mapUserRequestUsageRow);

      return response(200, { data });
    }

    if (routeKey === "POST /snap") {
      const claims = getClaims(event);
      const userEmail = claims.email || claims["cognito:username"] || claims.username;
      const userId = claims.sub;
      const firstName = claims.name || claims.given_name || "Customer";
      if (!userEmail || !userId) {
        return response(401, { error: "Unauthorized: missing user claims." });
      }

      const body = parseBody(event);
      const totalCredit = Number(body.total_credit || 0);
      const totalPrice = Number(body.total_price || 0);
      if (!totalCredit || !totalPrice) {
        return response(400, { error: "total_credit and total_price are required." });
      }

      const orderId = generateFriendlyOrderId(userId);
      const now = new Date().toISOString();

      await docClient.send(
        new PutCommand({
          TableName: TOPUP_CREDIT_TABLE_NAME,
          Item: {
            uuid: orderId,
            user_email: userEmail,
            user_id: userId,
            created_at: now,
            updated_at: now,
            amount: totalCredit,
            total: totalPrice,
            status: "PENDING",
          },
        })
      );

      const midtransBody = {
        transaction_details: {
          order_id: orderId,
          gross_amount: totalPrice,
        },
        enabled_payments: pickEnabledPaymentsByNominal(totalPrice),
        customer_details: {
          first_name: firstName,
          email: userEmail,
          user_id: userId,
        },
        expiry:{
          start_time: formatMidtransStartTime(),
          unit: "minutes",
          duration: 60,
        },
        custom_field1: userId,
        custom_field2: userEmail,
        custom_field3: orderId,
      };
      const finishCallback = String(
        body.finish_callback_url || MIDTRANS_FINISH_CALLBACK_URL || ""
      ).trim();
      if (finishCallback) {
        midtransBody.callbacks = {
          finish: finishCallback,
        };
      }
      console.log("creating midtrans snap transaction", {
        orderId,
        userId,
        userEmail,
        totalCredit,
        totalPrice,
        midtransApiUrl: MIDTRANS_API_URL,
        finishCallback: finishCallback || null,
      });

      const basicAuth = Buffer.from(`${MIDTRANS_SERVER_KEY}:`).toString("base64");
      const midtransRes = await fetch(MIDTRANS_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
        body: JSON.stringify(midtransBody),
      });

      const midtransJson = await midtransRes.json();
      console.log("midtrans snap response", {
        orderId,
        status: midtransRes.status,
        ok: midtransRes.ok,
        body: midtransJson,
      });
      if (!midtransRes.ok) {
        console.error("midtrans snap creation failed", {
          orderId,
          status: midtransRes.status,
          body: midtransJson,
        });
        return response(502, {
          error: "Failed to create Midtrans Snap transaction.",
          detail: midtransJson,
        });
      }

      return response(200, {
        order_id: orderId,
        token: midtransJson.token || null,
        payment_url:
          midtransJson.payment_url ||
          midtransJson.redirect_url ||
          midtransJson.url ||
          null,
        midtrans: midtransJson,
      });
    }

    if (
      String(event.httpMethod || "").toUpperCase() === "POST" &&
      pathEndsWithResource(event, "/resource")
    ) {
      if (!USER_REQUEST_TABLE_NAME) {
        return response(500, { error: "USER_REQUEST_TABLE_NAME is not configured." });
      }

      const claims = getClaims(event);
      const userEmailRaw =
        claims.email || claims["cognito:username"] || claims.username;
      const userId = claims.sub;
      if (!userEmailRaw || !userId) {
        return response(401, { error: "Unauthorized: missing user claims." });
      }
      const userEmail = normalizeUserEmail(userEmailRaw);

      const body = parseBody(event);
      const prompt = String(body.prompt || "").trim();
      const imageBase64 =
        body.image_base64 != null ? String(body.image_base64) : "";
      const hasImage = Boolean(imageBase64.trim());
      const resourceFamilyRaw = String(
        body.resource_family ?? body.media_family ?? "image"
      ).toLowerCase();
      const resourceFamily = resourceFamilyRaw === "video" ? "video" : "image";

      let requestType;
      let pricingKey;
      if (resourceFamily === "video") {
        requestType = hasImage ? "image-to-video" : "text-to-video";
        pricingKey = hasImage ? "IMAGE-TO-VIDEO" : "TEXT-TO-VIDEO";
      } else {
        requestType = hasImage ? "image-to-image" : "text-to-image";
        pricingKey = hasImage ? "IMAGE-TO-IMAGE" : "TEXT-TO-IMAGE";
      }

      if (!prompt) {
        return response(400, { error: "prompt is required." });
      }

      if (!PRICING_TABLE_NAME) {
        return response(500, { error: "PRICING_TABLE_NAME is not configured." });
      }
      const pricingResolved = await resolvePricingRow(pricingKey);
      if (!pricingResolved) {
        return response(503, {
          error: `Pricing belum dikonfigurasi untuk "${pricingKey}". Tambahkan baris di tabel pricing (PK key, SK charge, atribut amount Number).`,
        });
      }
      const creditAmount = pricingResolved.amount;

      const videoQuality =
        resourceFamily === "video" ? normalizeVideoQuality(body.video_quality) : null;
      const aspectRatio =
        resourceFamily === "video" ? normalizeAspectRatio(body.aspect_ratio) : null;

      const videoOptions =
        resourceFamily === "video" && videoQuality && aspectRatio
          ? { video_quality: videoQuality, aspect_ratio: aspectRatio }
          : {};

      if (body.credit_amount !== undefined && body.credit_amount !== null && body.credit_amount !== "") {
        const declared = Number(body.credit_amount);
        if (Number.isNaN(declared) || declared !== creditAmount) {
          return response(400, {
            error: `credit_amount harus ${creditAmount} (sesuai tabel pricing untuk ${pricingKey}).`,
          });
        }
      }

      const now = new Date().toISOString();
      const requestId = randomUUID();

      const profileDebitTransact = {
        Update: {
          TableName: PROFILE_TABLE_NAME,
          Key: {
            user_id: String(userId),
            user_type: "CUSTOMER",
          },
          UpdateExpression:
            "SET credit_balance = if_not_exists(credit_balance, :z) - :c, credit_usage = if_not_exists(credit_usage, :z) + :c, updated_at = :now",
          ConditionExpression:
            "attribute_exists(user_id) AND attribute_exists(user_type) AND credit_balance >= :c",
          ExpressionAttributeValues: {
            ":z": 0,
            ":c": creditAmount,
            ":now": now,
          },
        },
      };

      const runResourceTransact = async (putItem) => {
        try {
          await docClient.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: USER_REQUEST_TABLE_NAME,
                    Item: putItem,
                  },
                },
                profileDebitTransact,
              ],
            })
          );
        } catch (err) {
          if (err?.name === "TransactionCanceledException") {
            const reasons = err.CancellationReasons || [];
            if (reasons.some((r) => r?.Code === "ConditionalCheckFailed")) {
              return response(402, {
                error: "Insufficient credit balance or profile not found.",
                required_credit: creditAmount,
              });
            }
          }
          console.error("POST /resource transact error", err);
          return response(500, { error: err.message || "Transaction failed." });
        }
        return null;
      };

      if (!hasImage) {
        const putItem = {
          uuid: requestId,
          user_email: userEmail,
          user_id: userId,
          prompt,
          request_type: requestType,
          resource_family: resourceFamily,
          status: "PENDING",
          credit_amount: creditAmount,
          created_at: now,
          updated_at: now,
          ...videoOptions,
        };
        const errRes = await runResourceTransact(putItem);
        if (errRes) return errRes;

        // Worker A: masukkan job ke Redis queue & bangunkan Worker B (fire-and-forget)
        await enqueueJob(requestId, {
          uuid: requestId,
          user_email: userEmail,
          user_id: userId,
          prompt,
          request_type: requestType,
          resource_family: resourceFamily,
          s3_key: null,
          ...videoOptions,
        });

        return response(200, {
          data: {
            uuid: requestId,
            user_email: userEmail,
            request_type: requestType,
            resource_family: resourceFamily,
            status: "PENDING",
            credit_amount: creditAmount,
            s3_key: null,
            ...videoOptions,
          },
        });
      }

      const parsed = parseImageBase64(imageBase64);
      if (!parsed?.buffer?.length) {
        return response(400, { error: "Invalid image_base64 payload." });
      }

      const ext = extFromContentType(parsed.contentType);
      const s3Key = `user_request/${userId}/${requestId}.${ext}`;

      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: S3_RESOURCE_BUCKET,
            Key: s3Key,
            Body: parsed.buffer,
            ContentType: parsed.contentType,
          })
        );
      } catch (err) {
        console.error("S3 PutObject failed", err);
        return response(502, { error: "Failed to upload image to storage." });
      }

      const putItem = {
        uuid: requestId,
        user_email: userEmail,
        user_id: userId,
        prompt,
        request_type: requestType,
        resource_family: resourceFamily,
        status: "PENDING",
        s3_key: s3Key,
        credit_amount: creditAmount,
        created_at: now,
        updated_at: now,
        ...videoOptions,
      };
      const errRes = await runResourceTransact(putItem);
      if (errRes) return errRes;

      // Worker A: masukkan job ke Redis queue & bangunkan Worker B (fire-and-forget)
      await enqueueJob(requestId, {
        uuid: requestId,
        user_email: userEmail,
        user_id: userId,
        prompt,
        request_type: requestType,
        resource_family: resourceFamily,
        s3_key: s3Key,
        ...videoOptions,
      });

      return response(200, {
        data: {
          uuid: requestId,
          user_email: userEmail,
          request_type: requestType,
          resource_family: resourceFamily,
          status: "PENDING",
          credit_amount: creditAmount,
          s3_key: s3Key,
          ...videoOptions,
        },
      });
    }

    return response(404, { error: "Route not found." });
  } catch (err) {
    console.error(err);
    return response(500, { error: err.message || "Internal server error." });
  }
};
