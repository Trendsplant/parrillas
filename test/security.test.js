import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

process.env.SESSION_SECRET = "test-session-secret-that-is-long-and-independent";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-shopify-secret";

const { default: app, __testing } = await import("../api/[...path].js");

function encryptWith(secret, value) {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}

function sessionPayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: process.env.SHOPIFY_API_KEY,
    dest: "https://trendsplant-apparel-for-the-modern-nomad.myshopify.com",
    iss: "https://trendsplant-apparel-for-the-modern-nomad.myshopify.com/admin",
    sub: "123456789",
    exp: now + 60,
    nbf: now - 5,
    iat: now - 5,
    ...overrides,
  };
}

function signSession(payload = sessionPayload()) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(header + "." + body)
    .digest("base64url");
  return header + "." + body + "." + signature;
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("only SESSION_SECRET (or an explicit previous key) can open encrypted state", () => {
  const value = { shop: "trendsplant-apparel-for-the-modern-nomad", createdAt: Date.now() };
  assert.deepEqual(__testing.open(__testing.seal(value)), value);
  assert.equal(__testing.open(encryptWith("development-only-key", value)), null);
  assert.equal(__testing.open(encryptWith(process.env.SHOPIFY_API_SECRET, value)), null);
});

test("private routes reject forged cookies and accept a current Shopify session token", () => {
  const forged = encryptWith("development-only-key", {
    shop: "trendsplant-apparel-for-the-modern-nomad",
    createdAt: Date.now(),
  });
  let nextCalled = false;
  const denied = mockResponse();
  __testing.authRequired(
    { path: "/api/strategy", headers: { cookie: "tp_session=" + forged } },
    denied,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, false);
  assert.equal(denied.statusCode, 401);

  const allowed = mockResponse();
  __testing.authRequired(
    { path: "/api/strategy", headers: { authorization: "Bearer " + signSession() } },
    allowed,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
});

test("HTTP boundary rejects the known forged cookie while preserving signed Shopify access", async (context) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = "http://127.0.0.1:" + server.address().port;
  const forged = encryptWith("development-only-key", {
    shop: "trendsplant-apparel-for-the-modern-nomad",
    createdAt: Date.now(),
  });

  const denied = await fetch(origin + "/api/persistence-status", {
    headers: { cookie: "tp_session=" + forged },
  });
  assert.equal(denied.status, 401);

  const forgedSession = await fetch(origin + "/api/session", {
    headers: { cookie: "tp_session=" + forged },
  });
  assert.deepEqual(await forgedSession.json(), { authenticated: false });

  const legitimateSession = await fetch(origin + "/api/session", {
    headers: { authorization: "Bearer " + signSession() },
  });
  assert.equal(legitimateSession.status, 200);
  assert.deepEqual(await legitimateSession.json(), {
    authenticated: true,
    shop: "trendsplant-apparel-for-the-modern-nomad",
    userId: "123456789",
    authenticatedBy: "shopify_session_token",
  });
});

test("Shopify session validation rejects expired or wrongly scoped tokens", () => {
  assert.equal(
    __testing.shopifySessionTokenFrom({ headers: { authorization: "Bearer " + signSession() } })?.userId,
    "123456789",
  );
  assert.equal(
    __testing.shopifySessionTokenFrom({
      headers: { authorization: "Bearer " + signSession(sessionPayload({ exp: 1 })) },
    }),
    null,
  );
  assert.equal(
    __testing.shopifySessionTokenFrom({
      headers: { authorization: "Bearer " + signSession(sessionPayload({ dest: "https://evil.myshopify.com" })) },
    }),
    null,
  );
});

test("OAuth callbacks require a valid Shopify HMAC", () => {
  const query = {
    shop: "trendsplant-apparel-for-the-modern-nomad.myshopify.com",
    state: "state-value",
    timestamp: "1787299200",
    code: "temporary-code",
  };
  const message = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + value)
    .join("&");
  query.hmac = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(message).digest("hex");
  assert.equal(__testing.validOAuthHmac(query), true);
  assert.equal(__testing.validOAuthHmac({ ...query, state: "tampered" }), false);
});

test("webhook HMAC fails closed and validates the raw request body", () => {
  const rawBody = Buffer.from('{"id":123}');
  const hmac = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(rawBody).digest("base64");
  assert.equal(
    __testing.validWebhookHmac({ rawBody, headers: { "x-shopify-hmac-sha256": hmac } }),
    true,
  );
  const secret = process.env.SHOPIFY_API_SECRET;
  delete process.env.SHOPIFY_API_SECRET;
  assert.equal(
    __testing.validWebhookHmac({ rawBody, headers: { "x-shopify-hmac-sha256": hmac } }),
    false,
  );
  process.env.SHOPIFY_API_SECRET = secret;
});

test("orders webhook rejects another shop, topic, or missing event identity before persistence", async () => {
  const rawBody = Buffer.from('{"id":123}');
  const hmac = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(rawBody).digest("base64");
  const baseHeaders = {
    "x-shopify-hmac-sha256": hmac,
    "x-shopify-topic": "orders/create",
    "x-shopify-event-id": "9a8b7c6d-1234-5678-9012-abcdefabcdef",
  };
  const wrongShop = mockResponse();
  await __testing.ordersCreateWebhook({
    rawBody,
    body: { id: 123 },
    headers: { ...baseHeaders, "x-shopify-shop-domain": "evil.myshopify.com" },
  }, wrongShop);
  assert.equal(wrongShop.statusCode, 403);

  const missingIdentity = mockResponse();
  await __testing.ordersCreateWebhook({
    rawBody,
    body: { id: 123 },
    headers: {
      ...baseHeaders,
      "x-shopify-shop-domain": "trendsplant-apparel-for-the-modern-nomad.myshopify.com",
      "x-shopify-event-id": "",
    },
  }, missingIdentity);
  assert.equal(missingIdentity.statusCode, 400);
});

test("analytics events are limited by both session and source IP", () => {
  __testing.resetRateLimits();
  const request = { headers: { "x-tp-session": "visitor-a" }, body: {}, ip: "203.0.113.10" };
  for (let index = 0; index < 120; index += 1) {
    assert.equal(__testing.eventAllowed(request, "trendsplant-apparel-for-the-modern-nomad"), true);
  }
  assert.equal(__testing.eventAllowed(request, "trendsplant-apparel-for-the-modern-nomad"), false);

  __testing.resetRateLimits();
  for (let index = 0; index < 600; index += 1) {
    assert.equal(__testing.eventAllowed({
      headers: { "x-tp-session": "visitor-" + index },
      body: {},
      ip: "203.0.113.11",
    }, "trendsplant-apparel-for-the-modern-nomad"), true);
  }
  assert.equal(__testing.eventAllowed({
    headers: { "x-tp-session": "visitor-over-limit" },
    body: {},
    ip: "203.0.113.11",
  }, "trendsplant-apparel-for-the-modern-nomad"), false);
});

test("bounded caches evict old entries instead of growing indefinitely", () => {
  const cache = new Map();
  __testing.setBoundedCache(cache, "a", { expiresAt: Date.now() + 1000 }, 2);
  __testing.setBoundedCache(cache, "b", { expiresAt: Date.now() + 1000 }, 2);
  __testing.setBoundedCache(cache, "c", { expiresAt: Date.now() + 1000 }, 2);
  assert.equal(cache.size, 2);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.has("c"), true);
});
