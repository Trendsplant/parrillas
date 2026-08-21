import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";

const app = express();
app.disable("x-powered-by");
app.use(express.json({
  limit: "200kb",
  verify(req, _res, buffer) {
    req.rawBody = Buffer.from(buffer);
  },
}));

const DEFAULT_SHOP = "trendsplant-apparel-for-the-modern-nomad";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const STATE_VERSION = 3;
const WEATHER_TTL_MS = 15 * 60 * 1000;
const SALES_TTL_MS = 15 * 60 * 1000;
const RANKING_TTL_MS = 30 * 1000;
const WEATHER_CACHE_LIMIT = 1000;
const RANKING_CACHE_LIMIT = 2000;
const EVENT_RATE_LIMIT = 120;
const EVENT_RATE_WINDOW_MS = 60 * 1000;
const IP_EVENT_RATE_LIMIT = 600;
const PUBLIC_READ_RATE_LIMIT = 120;
const RATE_BUCKET_LIMIT = 10000;
const GEO_TTL_MS = 6 * 60 * 60 * 1000;
const GEO_CACHE_LIMIT = 5000;
const DIMENSION_LIMIT = 200;
const MAX_STRATEGY_VERSIONS = 30;
const ADMIN_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GITHUB_THEME_OWNER = "Trendsplant";
const GITHUB_THEME_REPOSITORY = "tpshopify";
const GITHUB_THEME_SOURCE_BRANCH = "preview";
const GITHUB_THEME_TARGET_BRANCH = "main";
const GITHUB_API_VERSION = "2022-11-28";
const THEME_RELEASE_LOCK_TTL_SECONDS = 15 * 60;
const THEME_RELEASE_COOLDOWN_SECONDS = 10;
const SUMMER_DAY_MANIFEST = JSON.parse(
  fs.readFileSync(new URL("../data/summer-day-2026.json", import.meta.url), "utf8"),
);
const SUMMER_DAY_PERCENTAGES = [40, 50, 60];
const SUMMER_DAY_TEST_MAX_MINUTES = 120;
const SUMMER_DAY_SUPERSEDED_DISCOUNTS = [
  { id: "gid://shopify/DiscountAutomaticNode/1684050936140", title: "Essential men x3 bundle" },
  { id: "gid://shopify/DiscountAutomaticNode/1684051034444", title: "Essential men x5 bundle" },
  { id: "gid://shopify/DiscountAutomaticNode/1684056211788", title: "Essential women x3 bundle" },
  { id: "gid://shopify/DiscountAutomaticNode/1684056277324", title: "Essential women x5 bundle" },
  { id: "gid://shopify/DiscountAutomaticNode/2275052618060", title: "Swimwear x2 Bundle" },
  { id: "gid://shopify/DiscountAutomaticNode/2275052945740", title: "Swimwear x3 Bundle" },
];
const summerCleanupPromises = new Map();

function assertSecurityConfiguration() {
  if (String(process.env.SESSION_SECRET || "").trim().length < 32) {
    throw new Error("SESSION_SECRET debe estar configurada con al menos 32 caracteres.");
  }
  if (!String(process.env.SHOPIFY_API_SECRET || "").trim()) {
    throw new Error("SHOPIFY_API_SECRET debe estar configurada.");
  }
}

assertSecurityConfiguration();

const DEFAULT_STRATEGY = {
  enabled: true,
  mode: "simulation",
  collectionHandle: "men",
  collectionHandles: ["men"],
  fallback: "original",
  weights: {
    temperatureFit: 30,
    countryAffinity: 20,
    recentSales: 20,
    newness: 15,
    availability: 15,
  },
  exclusions: { excludeOutOfStock: true, preserveManualProducts: true },
  scoreRules: {
    soldOutToEnd: true,
    oneSizePenalty: -12,
    lowSizeThreshold: 25,
    lowSizePenalty: -8,
    freshDays: 14,
    freshBonus: 12,
    recentStartDays: 15,
    recentEndDays: 30,
    recentBonus: 6,
  },
  manualOverrides: {
    pins: [],
    exclusions: [],
  },
  audit: { revision: 0, versionId: null, lastUpdated: null, lastApplied: null, lastAppliedBy: null },
};

let memoryStrategy = structuredClone(DEFAULT_STRATEGY);
const tokenCache = new Map();
const weatherCache = new Map();
const salesCache = new Map();
const rankingCache = new Map();
const eventRateBuckets = new Map();
const ipEventRateBuckets = new Map();
const publicReadRateBuckets = new Map();
const geoCache = new Map();
let githubInstallationTokenCache = null;
const runtimeMetrics = {
  startedAt: new Date().toISOString(),
  requests: 0,
  errors: 0,
  latencyTotalMs: 0,
  rateLimited: 0,
  cache: {
    weatherHits: 0,
    weatherMisses: 0,
    salesHits: 0,
    salesMisses: 0,
    rankingHits: 0,
    rankingMisses: 0,
  },
};

app.use((req, res, next) => {
  const started = Date.now();
  runtimeMetrics.requests += 1;
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.on("finish", () => {
    runtimeMetrics.latencyTotalMs += Date.now() - started;
    if (res.statusCode >= 500) runtimeMetrics.errors += 1;
  });
  next();
});

function b64(buffer) {
  return buffer.toString("base64url");
}

function secretKeys() {
  const current = String(process.env.SESSION_SECRET || "").trim();
  const previous = String(process.env.SESSION_SECRET_PREVIOUS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const values = [current, ...previous].filter(Boolean);
  return [...new Set(values)].map((value) =>
    crypto.createHash("sha256").update(value).digest(),
  );
}

function seal(value) {
  const key = secretKeys()[0];
  if (!key) throw new Error("SESSION_SECRET no está configurada.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return b64(Buffer.concat([iv, payload]));
}

function open(value) {
  if (!value || !secretKeys().length) return null;
  const payload = Buffer.from(value, "base64url");
  if (payload.length < 29) return null;
  for (const key of secretKeys()) {
    try {
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(-16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]).toString(),
      );
    } catch {}
  }
  return null;
}

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let sql;
let stateStoragePromise = null;
let themeReleaseLockStoragePromise = null;
let themeReleaseAuditStoragePromise = null;
let webhookEventStoragePromise = null;

function database() {
  if (!DATABASE_URL) {
    throw new Error("La base de datos PostgreSQL no está conectada.");
  }
  sql ||= postgres(DATABASE_URL, {
    max: Number(process.env.POSTGRES_POOL_SIZE || 10),
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return sql;
}

async function ensureStateStorage() {
  if (!stateStoragePromise) {
    stateStoragePromise = database().begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(81002001)`;
      await transaction`CREATE TABLE IF NOT EXISTS trendsplant_app_state (
        shop TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    }).catch((error) => {
      stateStoragePromise = null;
      throw error;
    });
  }
  await stateStoragePromise;
}

async function readState(shop) {
  await ensureStateStorage();
  const rows = await database()`SELECT payload FROM trendsplant_app_state WHERE shop = ${shop} LIMIT 1`;
  return rows[0]?.payload ? open(rows[0].payload) : null;
}

async function writeState(shop, patch) {
  return updateState(shop, (current) => ({ ...current, ...patch }));
}

async function updateState(shop, updater) {
  await ensureStateStorage();
  return database().begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${shop}, 0))`;
    const rows = await transaction`SELECT payload FROM trendsplant_app_state WHERE shop = ${shop} LIMIT 1`;
    const current = rows[0]?.payload ? open(rows[0].payload) : null;
    const updated = await updater(current || { version: STATE_VERSION, shop });
    const next = {
      ...(updated || current || {}),
      version: STATE_VERSION,
      shop,
      updatedAt: new Date().toISOString(),
    };
    await transaction`INSERT INTO trendsplant_app_state (shop, payload, updated_at)
      VALUES (${shop}, ${seal(next)}, NOW())
      ON CONFLICT (shop) DO UPDATE
      SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`;
    return next;
  });
}

async function ensureWebhookEventStorage() {
  if (!webhookEventStoragePromise) {
    webhookEventStoragePromise = database().begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(81002004)`;
      await transaction`CREATE TABLE IF NOT EXISTS trendsplant_webhook_events (
        event_id TEXT PRIMARY KEY,
        shop TEXT NOT NULL,
        topic TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await transaction`CREATE INDEX IF NOT EXISTS trendsplant_webhook_events_received_at_idx
        ON trendsplant_webhook_events (received_at)`;
    }).catch((error) => {
      webhookEventStoragePromise = null;
      throw error;
    });
  }
  await webhookEventStoragePromise;
}

async function claimWebhookEvent(eventId, shop, topic) {
  await ensureWebhookEventStorage();
  const rows = await database()`INSERT INTO trendsplant_webhook_events (event_id, shop, topic)
    VALUES (${eventId}, ${shop}, ${topic})
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id`;
  if (rows.length) {
    await database()`DELETE FROM trendsplant_webhook_events
      WHERE received_at < NOW() - INTERVAL '30 days'`;
  }
  return rows.length === 1;
}

async function releaseWebhookEvent(eventId) {
  await ensureWebhookEventStorage();
  await database()`DELETE FROM trendsplant_webhook_events WHERE event_id = ${eventId}`;
}

function cookie(res, name, value, maxAge = 600) {
  const next = name + "=" + value + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Lax";
  const current = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), next] : next);
}

function clearCookie(res, name) {
  cookie(res, name, "deleted", 0);
}

function shopifySessionTokenFrom(req) {
  const authorization = String(req?.headers?.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const apiKey = String(process.env.SHOPIFY_API_KEY || "");
  const apiSecret = String(process.env.SHOPIFY_API_SECRET || "");
  if (!token || !apiKey || !apiSecret) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (header?.alg !== "HS256" || (header?.typ && header.typ !== "JWT")) return null;

    const actualSignature = Buffer.from(parts[2], "base64url");
    const expectedSignature = crypto
      .createHmac("sha256", apiSecret)
      .update(parts[0] + "." + parts[1])
      .digest();
    if (
      actualSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const clockSkew = 5;
    const exp = Number(payload?.exp);
    const nbf = Number(payload?.nbf);
    const iat = Number(payload?.iat);
    const expectedHost = DEFAULT_SHOP + ".myshopify.com";
    const dest = new URL(String(payload?.dest || ""));
    const issuer = new URL(String(payload?.iss || ""));
    const audience = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
    const userId = String(payload?.sub || "");
    if (
      !Number.isFinite(exp) ||
      !Number.isFinite(nbf) ||
      !Number.isFinite(iat) ||
      exp < now - clockSkew ||
      nbf > now + clockSkew ||
      iat > now + clockSkew ||
      dest.protocol !== "https:" ||
      dest.hostname !== expectedHost ||
      issuer.protocol !== "https:" ||
      issuer.hostname !== expectedHost ||
      issuer.pathname.replace(/\/$/, "") !== "/admin" ||
      !audience.includes(apiKey) ||
      !/^\d+$/.test(userId)
    ) {
      return null;
    }
    return {
      shop: DEFAULT_SHOP,
      userId,
      createdAt: iat * 1000,
      authenticatedBy: "shopify_session_token",
    };
  } catch {
    return null;
  }
}

function sessionFrom(req) {
  const shopifySession = shopifySessionTokenFrom(req);
  if (shopifySession) return shopifySession;
  const raw = String(req?.headers?.cookie || "").match(/(?:^|; )tp_session=([^;]+)/)?.[1];
  const session = open(raw || "");
  const createdAt = Number(session?.createdAt || 0);
  if (
    !session ||
    session.shop !== DEFAULT_SHOP ||
    !createdAt ||
    createdAt > Date.now() + 5 * 60 * 1000 ||
    Date.now() - createdAt > ADMIN_SESSION_MAX_AGE_MS
  ) {
    return null;
  }
  return { ...session, authenticatedBy: "oauth_cookie" };
}

function validCookieMutationOrigin(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase())) return true;
  const origin = String(req.headers?.origin || "").trim();
  const host = String(req.headers?.host || "").trim().toLowerCase();
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    return parsed.host.toLowerCase() === host && (parsed.protocol === "https:" || local);
  } catch {
    return false;
  }
}

function shopOf(req) {
  const raw = String(req.query?.shop || req.body?.shop || DEFAULT_SHOP);
  const normalized = raw.toLowerCase().replace(/\.myshopify\.com$/, "");
  return normalized === DEFAULT_SHOP ? DEFAULT_SHOP : DEFAULT_SHOP;
}

function validOAuthHmac(query = {}) {
  const secret = String(process.env.SHOPIFY_API_SECRET || "");
  const provided = String(query.hmac || "");
  if (!secret || !/^[a-f0-9]{64}$/i.test(provided)) return false;
  const message = Object.entries(query)
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + (Array.isArray(value) ? value.join(",") : String(value)))
    .join("&");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const left = Buffer.from(provided, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function clientIp(req) {
  const value = String(req.ip || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return value.replace(/^::ffff:/, "").slice(0, 80) || "unknown";
}

function boundedRateAllowed(store, key, limit, windowMs) {
  const now = Date.now();
  const bucket = store.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    if (store.size >= RATE_BUCKET_LIMIT) {
      for (const [candidate, value] of store) {
        if (now - value.startedAt >= windowMs) store.delete(candidate);
        if (store.size < RATE_BUCKET_LIMIT) break;
      }
      if (store.size >= RATE_BUCKET_LIMIT) store.delete(store.keys().next().value);
    }
    store.set(key, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function setBoundedCache(store, key, value, limit) {
  const now = Date.now();
  for (const [candidate, entry] of store) {
    if (!entry || Number(entry.expiresAt || 0) <= now) store.delete(candidate);
  }
  if (!store.has(key) && store.size >= limit) store.delete(store.keys().next().value);
  store.set(key, value);
}

function publicReadLimit(req, res, next) {
  if (!boundedRateAllowed(publicReadRateBuckets, clientIp(req), PUBLIC_READ_RATE_LIMIT, EVENT_RATE_WINDOW_MS)) {
    runtimeMetrics.rateLimited += 1;
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Demasiadas solicitudes." });
  }
  next();
}

function collectionHandlesFor(strategy = {}) {
  const raw = Array.isArray(strategy.collectionHandles)
    ? strategy.collectionHandles
    : String(strategy.collectionHandles || strategy.collectionHandle || "").split(",");
  const handles = raw
    .map((handle) => String(handle || "").trim().toLowerCase())
    .filter((handle) => /^[a-z0-9][a-z0-9-]*$/.test(handle));
  const unique = [...new Set(handles)].slice(0, 4);
  return unique.length ? unique : ["men"];
}

function normalizeStrategyCollections(strategy = {}) {
  const collectionHandles = collectionHandlesFor(strategy);
  return { ...strategy, collectionHandles, collectionHandle: collectionHandles[0] };
}

function normalizeWeights(weights = {}) {
  const keys = [
    "temperatureFit",
    "countryAffinity",
    "recentSales",
    "newness",
    "availability",
  ];
  const values = Object.fromEntries(
    keys.map((key) => [key, Math.max(0, Number(weights[key] ?? 0))]),
  );
  const total = Object.values(values).reduce((sum, value) => sum + value, 0) || 1;
  const normalized = Object.fromEntries(
    keys.map((key) => [key, Math.round((values[key] / total) * 100)]),
  );
  const drift = 100 - Object.values(normalized).reduce((sum, value) => sum + value, 0);
  normalized.temperatureFit += drift;
  return normalized;
}

function scoreRuleNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeScoreRules(rules = {}) {
  const defaults = DEFAULT_STRATEGY.scoreRules;
  const freshDays = scoreRuleNumber(rules.freshDays, defaults.freshDays, 1, 365);
  const recentStartDays = scoreRuleNumber(rules.recentStartDays, defaults.recentStartDays, freshDays + 1, 365);
  const recentEndDays = scoreRuleNumber(rules.recentEndDays, defaults.recentEndDays, recentStartDays, 365);
  return {
    soldOutToEnd: rules.soldOutToEnd !== false,
    oneSizePenalty: scoreRuleNumber(rules.oneSizePenalty, defaults.oneSizePenalty, -100, 0),
    lowSizeThreshold: scoreRuleNumber(rules.lowSizeThreshold, defaults.lowSizeThreshold, 1, 100),
    lowSizePenalty: scoreRuleNumber(rules.lowSizePenalty, defaults.lowSizePenalty, -100, 0),
    freshDays,
    freshBonus: scoreRuleNumber(rules.freshBonus, defaults.freshBonus, 0, 100),
    recentStartDays,
    recentEndDays,
    recentBonus: scoreRuleNumber(rules.recentBonus, defaults.recentBonus, 0, 100),
  };
}

function normalizeManualOverrides(overrides = {}) {
  const normalizeProductRef = (entry, index, kind) => {
    const id = String(entry?.id || "").trim().slice(0, 180);
    const handle = String(entry?.handle || "").trim().toLowerCase().slice(0, 120);
    if (!id && !/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
    const ref = {
      id,
      handle: /^[a-z0-9][a-z0-9-]*$/.test(handle) ? handle : "",
      title: String(entry?.title || "").trim().slice(0, 180),
      enabled: entry?.enabled !== false,
      note: String(entry?.note || "").trim().slice(0, 240),
    };
    if (kind === "pin") {
      ref.position = scoreRuleNumber(entry?.position, index + 1, 1, 250);
    }
    return ref;
  };
  const pins = (Array.isArray(overrides?.pins) ? overrides.pins : [])
    .map((entry, index) => normalizeProductRef(entry, index, "pin"))
    .filter(Boolean)
    .slice(0, 100);
  const exclusions = (Array.isArray(overrides?.exclusions) ? overrides.exclusions : [])
    .map((entry, index) => normalizeProductRef(entry, index, "exclude"))
    .filter(Boolean)
    .slice(0, 100);
  return { pins, exclusions };
}

app.use((req, res, next) => {
  if (["/api/storefront-ranking", "/api/analytics-events", "/api/visitor-context", "/api/discounts/summer-day/storefront"].includes(req.path)) {
    const origin = String(req.headers.origin || "");
    if (/https:\/\/([a-z0-9-]+\.)?trendsplant\.com$/i.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TP-Session");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

app.use(["/api/storefront-ranking", "/api/visitor-context", "/api/discounts/summer-day/storefront"], publicReadLimit);

function authRequired(req, res, next) {
  const publicPaths = [
    "/api/health",
    "/api/session",
    "/auth/shopify",
    "/auth/callback",
    "/api/auth/shopify",
    "/api/auth/callback",
    "/api/storefront-ranking",
    "/api/analytics-events",
    "/api/visitor-context",
    "/api/discounts/summer-day/storefront",
    "/api/webhooks/orders-create",
  ];
  if (publicPaths.includes(req.path)) return next();
  const session = sessionFrom(req);
  if (session) {
    if (session.authenticatedBy === "oauth_cookie" && !validCookieMutationOrigin(req)) {
      return res.status(403).json({ error: "Origen de la solicitud no permitido." });
    }
    req.adminSession = session;
    return next();
  }
  res.setHeader("X-Shopify-Retry-Invalid-Session-Request", "1");
  return res.status(401).json({
    error: "Autenticación requerida.",
    loginUrl: "/api/auth/shopify?shop=" + DEFAULT_SHOP + ".myshopify.com",
  });
}

app.use(authRequired);

async function acquireClientCredentialsToken(shop) {
  const clientId = String(process.env.SHOPIFY_API_KEY || "").trim();
  const clientSecret = String(process.env.SHOPIFY_API_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("Faltan SHOPIFY_API_KEY o SHOPIFY_API_SECRET en el servidor.");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch("https://" + shop + ".myshopify.com/admin/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  const raw = await response.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {}
  if (!response.ok || !data.access_token) {
    const reason = String(data.error_description || data.error || "").slice(0, 240);
    throw new Error(
      "No se pudo autenticar con Shopify (" + response.status + ")" +
        (reason ? ": " + reason : "."),
    );
  }
  return {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in || 86400) - 300) * 1000,
  };
}

async function shopToken(shop, req) {
  const session = sessionFrom(req);
  if (session?.shop === shop && session.accessToken) {
    tokenCache.set(shop, { value: session.accessToken, expiresAt: Date.now() + 60 * 60 * 1000 });
    await writeState(shop, {
      accessToken: session.accessToken,
      accessTokenExpiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
      sessionMigratedAt: new Date().toISOString(),
    }).catch(() => {});
    return session.accessToken;
  }

  const cached = tokenCache.get(shop);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const state = await readState(shop).catch(() => null);
  if (state?.accessToken && (!state.accessTokenExpiresAt || Date.now() < state.accessTokenExpiresAt)) {
    tokenCache.set(shop, {
      value: state.accessToken,
      expiresAt: state.accessTokenExpiresAt || Date.now() + 60 * 60 * 1000,
    });
    return state.accessToken;
  }

  const token = await acquireClientCredentialsToken(shop);
  tokenCache.set(shop, token);
  await writeState(shop, {
    accessToken: token.value,
    accessTokenExpiresAt: token.expiresAt,
    tokenRefreshedAt: new Date().toISOString(),
  });
  return token.value;
}

async function gql(shop, query, variables = {}, req) {
  const response = await fetch(
    "https://" + shop + ".myshopify.com/admin/api/" + API_VERSION + "/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await shopToken(shop, req),
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const raw = await response.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Shopify devolvió una respuesta no válida (" + response.status + ").");
  }
  if (!response.ok || data.errors) {
    throw new Error(data.errors?.map((error) => error.message).join("; ") || "Shopify GraphQL error");
  }
  return data.data;
}

function summerManifestSummary() {
  const counts = Object.fromEntries(
    SUMMER_DAY_PERCENTAGES.map((percentage) => [
      percentage,
      SUMMER_DAY_MANIFEST.products.filter((product) => product.discountPercent === percentage).length,
    ]),
  );
  return {
    id: SUMMER_DAY_MANIFEST.id,
    title: SUMMER_DAY_MANIFEST.title,
    timezone: SUMMER_DAY_MANIFEST.timezone,
    startsAt: SUMMER_DAY_MANIFEST.startsAt,
    endsAt: SUMMER_DAY_MANIFEST.endsAt,
    total: SUMMER_DAY_MANIFEST.products.length,
    counts,
  };
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function summerProductPricePlan(variants, discountPercent) {
  const rows = (variants || []).map((variant) => {
    const currentCents = Math.round(Number(variant.price || 0) * 100);
    const compareAtCents = Math.round(Number(variant.compareAtPrice || 0) * 100);
    const originalCents = compareAtCents > currentCents ? compareAtCents : currentCents;
    const targetCents = Math.round(originalCents * (100 - discountPercent) / 100);
    const requiredCents = Math.max(0, currentCents - targetCents);
    const fraction = currentCents > 0 && requiredCents > 0 ? (requiredCents / currentCents).toFixed(12) : null;
    return { variantId: variant.id, sku: variant.sku, currentCents, originalCents, targetCents, requiredCents, fraction };
  });
  const fractions = [...new Set(rows.map((row) => row.fraction).filter(Boolean))];
  const noDiscountVariants = rows.filter((row) => row.requiredCents === 0).length;
  return {
    ok: rows.length > 0 && fractions.length <= 1 && (noDiscountVariants === 0 || noDiscountVariants === rows.length),
    discountRequired: fractions.length === 1,
    effectiveFraction: fractions[0] || null,
    effectivePercent: fractions[0] ? Math.round(Number(fractions[0]) * 1_000_000) / 10_000 : 0,
    variants: rows.length,
    variantsAlreadyAtOrBelowTarget: noDiscountVariants,
  };
}

async function resolveSummerProducts(shop, req) {
  const variants = [];
  for (const group of chunks(SUMMER_DAY_MANIFEST.products, 15)) {
    // The spreadsheet contains each model's base SKU; Shopify variants append the size
    // (for example 299060WSGH02). Prefix search keeps the mapping deterministic while
    // still resolving every size to its single parent product.
    const query = group.map((product) => "sku:" + product.sku + "*").join(" OR ");
    const data = await gql(
      shop,
      `query SummerVariants($query:String!){productVariants(first:250,query:$query){nodes{id sku price compareAtPrice product{id legacyResourceId title handle status featuredMedia{preview{image{url}}}}}}}`,
      { query },
      req,
    );
    variants.push(...(data.productVariants?.nodes || []));
  }

  const resolved = [];
  const missing = [];
  const ambiguous = [];
  for (const item of SUMMER_DAY_MANIFEST.products) {
    const baseSku = item.sku.trim().toUpperCase();
    const matchingVariants = variants.filter((variant) =>
      String(variant.sku || "").trim().toUpperCase().startsWith(baseSku),
    );
    const products = [...new Map(matchingVariants.map((variant) => [variant.product?.id, variant.product])).values()].filter(
      (product) => product?.id,
    );
    if (!products.length) {
      missing.push(item);
      continue;
    }
    if (products.length !== 1) {
      ambiguous.push({ ...item, matches: products.map((product) => ({ id: product.id, title: product.title })) });
      continue;
    }
    const product = products[0];
    const pricePlan = summerProductPricePlan(matchingVariants, item.discountPercent);
    resolved.push({
      sku: item.sku,
      expectedTitle: item.title,
      discountPercent: item.discountPercent,
      productId: product.id,
      legacyResourceId: String(product.legacyResourceId || ""),
      title: product.title,
      handle: product.handle,
      status: product.status,
      image: product.featuredMedia?.preview?.image?.url || null,
      pricePlan,
    });
  }
  const duplicateProducts = Object.entries(
    resolved.reduce((accumulator, product) => {
      (accumulator[product.productId] ||= []).push(product);
      return accumulator;
    }, {}),
  )
    .filter(([, products]) => products.length > 1)
    .map(([productId, products]) => ({ productId, skus: products.map((product) => product.sku) }));
  const inconsistentPricing = resolved
    .filter((product) => !product.pricePlan.ok)
    .map((product) => ({ sku: product.sku, productId: product.productId, pricePlan: product.pricePlan }));
  const pricingGroups = [...new Set(resolved.map((product) => product.pricePlan.effectiveFraction).filter(Boolean))];
  return {
    ok: missing.length === 0 && ambiguous.length === 0 && duplicateProducts.length === 0 && inconsistentPricing.length === 0,
    checkedAt: new Date().toISOString(),
    total: SUMMER_DAY_MANIFEST.products.length,
    resolved,
    missing,
    ambiguous,
    duplicateProducts,
    inconsistentPricing,
    pricingGroups,
  };
}

function summerBasicDiscountInput({ title, effectiveFraction, productIds, startsAt, endsAt }) {
  return {
    title,
    startsAt,
    endsAt,
    customerGets: {
      value: { percentage: Number(effectiveFraction) },
      items: { products: { productsToAdd: [...new Set(productIds)] } },
    },
    combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
  };
}

async function createSummerBasicDiscount(shop, req, input) {
  const data = await gql(
    shop,
    `mutation CreateSummerDiscount($input:DiscountAutomaticBasicInput!){discountAutomaticBasicCreate(automaticBasicDiscount:$input){automaticDiscountNode{id automaticDiscount{... on DiscountAutomaticBasic{title status startsAt endsAt}}}userErrors{field code message}}}`,
    { input },
    req,
  );
  const result = data.discountAutomaticBasicCreate;
  if (result.userErrors?.length) {
    const error = new Error(result.userErrors.map((item) => item.message).join("; "));
    error.status = 422;
    throw error;
  }
  if (!result.automaticDiscountNode?.id) throw new Error("Shopify no devolvió el descuento creado.");
  return {
    id: result.automaticDiscountNode.id,
    title: result.automaticDiscountNode.automaticDiscount?.title || input.title,
    status: result.automaticDiscountNode.automaticDiscount?.status || "SCHEDULED",
    startsAt: result.automaticDiscountNode.automaticDiscount?.startsAt || input.startsAt,
    endsAt: result.automaticDiscountNode.automaticDiscount?.endsAt || input.endsAt,
  };
}

async function deleteAutomaticDiscount(shop, req, id) {
  if (!id) return;
  const data = await gql(
    shop,
    `mutation DeleteSummerDiscount($id:ID!){discountAutomaticDelete(id:$id){deletedAutomaticDiscountId userErrors{field code message}}}`,
    { id },
    req,
  );
  const errors = data.discountAutomaticDelete?.userErrors || [];
  if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
}

async function updateAutomaticBasicWindow(shop, req, id, input) {
  const data = await gql(
    shop,
    `mutation UpdateSummerSuperseded($id:ID!,$input:DiscountAutomaticBasicInput!){discountAutomaticBasicUpdate(id:$id,automaticBasicDiscount:$input){automaticDiscountNode{id automaticDiscount{... on DiscountAutomaticBasic{title status startsAt endsAt}}}userErrors{field code message}}}`,
    { id, input },
    req,
  );
  const result = data.discountAutomaticBasicUpdate;
  if (result.userErrors?.length) throw new Error(result.userErrors.map((item) => item.message).join("; "));
  return { id: result.automaticDiscountNode?.id || id, ...(result.automaticDiscountNode?.automaticDiscount || {}) };
}

async function pauseSupersededDiscounts(shop, req) {
  const paused = [];
  try {
    for (const discount of SUMMER_DAY_SUPERSEDED_DISCOUNTS) {
      const updated = await updateAutomaticBasicWindow(shop, req, discount.id, { endsAt: SUMMER_DAY_MANIFEST.startsAt });
      paused.push({ ...discount, ...updated });
    }
    return paused;
  } catch (error) {
    await Promise.allSettled(paused.map((discount) => updateAutomaticBasicWindow(shop, req, discount.id, { endsAt: null })));
    throw error;
  }
}

async function restoreSupersededDiscounts(shop, req, discounts = SUMMER_DAY_SUPERSEDED_DISCOUNTS) {
  const results = await Promise.allSettled(
    discounts.map((discount) => updateAutomaticBasicWindow(shop, req, discount.id, { endsAt: null })),
  );
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new Error("No se pudieron reactivar todos los bundles sustituidos por Summer Day.");
  return results.map((result) => result.value);
}

async function summerDiscountNodes(shop, req, ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const data = await gql(
    shop,
    `query SummerDiscountNodes($ids:[ID!]!){nodes(ids:$ids){... on DiscountAutomaticNode{id automaticDiscount{__typename ... on DiscountAutomaticBasic{title status startsAt endsAt combinesWith{productDiscounts orderDiscounts shippingDiscounts}} ... on DiscountAutomaticApp{title status startsAt endsAt combinesWith{productDiscounts orderDiscounts shippingDiscounts} appDiscountType{functionId}}}}}}`,
    { ids: uniqueIds },
    req,
  );
  return (data.nodes || []).filter(Boolean).map((node) => ({ id: node.id, ...(node.automaticDiscount || {}) }));
}

async function cleanupExpiredSummerDay(shop, req) {
  const initial = await readState(shop);
  const now = Date.now();
  const testExpired = initial?.summerDay?.test?.enabled && now >= Date.parse(initial.summerDay.test.endsAt || 0);
  const productionExpired = initial?.summerDay?.production?.enabled && now >= Date.parse(initial.summerDay.production.endsAt || 0);
  if (!testExpired && !productionExpired) return initial;
  if (summerCleanupPromises.has(shop)) return summerCleanupPromises.get(shop);

  const cleanup = (async () => {
    const current = await readState(shop);
    const summerDay = current?.summerDay || {};
    let nextTest = summerDay.test;
    let nextProduction = summerDay.production;
    if (nextTest?.enabled && Date.now() >= Date.parse(nextTest.endsAt || 0)) {
      if (nextTest.discount?.id) await deleteAutomaticDiscount(shop, req, nextTest.discount.id).catch(() => {});
      nextTest = { ...nextTest, enabled: false, status: "expired", discount: null, disabledAt: new Date().toISOString() };
    }
    if (nextProduction?.enabled && Date.now() >= Date.parse(nextProduction.endsAt || 0)) {
      await Promise.allSettled((nextProduction.discounts || []).map((discount) => deleteAutomaticDiscount(shop, req, discount.id)));
      await restoreSupersededDiscounts(shop, req, nextProduction.pausedDiscounts);
      nextProduction = {
        ...nextProduction,
        enabled: false,
        status: "completed",
        discounts: [],
        pausedDiscounts: [],
        disabledAt: new Date().toISOString(),
      };
    }
    return updateState(shop, (latest) => ({
      ...latest,
      summerDay: { ...(latest.summerDay || {}), test: nextTest, production: nextProduction },
    }));
  })().finally(() => summerCleanupPromises.delete(shop));
  summerCleanupPromises.set(shop, cleanup);
  return cleanup;
}

async function summerStatus(req, res) {
  try {
    const shop = shopOf(req);
    const state = await cleanupExpiredSummerDay(shop, req);
    const summerDay = state?.summerDay || {};
    const ids = [
      summerDay.test?.discount?.id,
      ...(summerDay.production?.discounts || []).map((discount) => discount.id),
    ];
    let nodes = [];
    let permissionError = null;
    try {
      nodes = await summerDiscountNodes(shop, req, ids);
    } catch (error) {
      permissionError = error.message;
    }
    res.json({
      manifest: summerManifestSummary(),
      validation: summerDay.validation || null,
      test: summerDay.test || null,
      production: summerDay.production || null,
      shopifyDiscounts: nodes,
      permissionError,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

async function validateSummerDay(req, res) {
  try {
    const shop = shopOf(req);
    const validation = await resolveSummerProducts(shop, req);
    await writeState(shop, { summerDay: { ...((await readState(shop))?.summerDay || {}), validation } });
    res.status(validation.ok ? 200 : 409).json({ manifest: summerManifestSummary(), validation });
  } catch (error) {
    res.status(/access|scope|permission/i.test(error.message) ? 403 : 502).json({ error: error.message });
  }
}

async function searchSummerProducts(req, res) {
  try {
    const query = String(req.query?.q || "").trim().slice(0, 100);
    if (query.length < 2) return res.json({ products: [] });
    const data = await gql(
      shopOf(req),
      `query SearchSummerProducts($query:String!){products(first:20,query:$query){nodes{id legacyResourceId title handle status tags featuredMedia{preview{image{url}}}variants(first:10){nodes{id title sku price compareAtPrice}}}}}`,
      { query },
      req,
    );
    res.json({ products: data.products?.nodes || [] });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

async function enableSummerTest(req, res) {
  const shop = shopOf(req);
  let created = null;
  try {
    const productId = String(req.body?.productId || "");
    const percentage = Number(req.body?.percentage);
    const durationMinutes = Math.max(1, Math.min(SUMMER_DAY_TEST_MAX_MINUTES, Number(req.body?.durationMinutes) || 15));
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return res.status(400).json({ error: "Producto no válido." });
    if (!SUMMER_DAY_PERCENTAGES.includes(percentage)) return res.status(400).json({ error: "Descuento no válido." });
    const state = await readState(shop);
    if (state?.summerDay?.test?.discount?.id) {
      return res.status(409).json({ error: "Ya existe una prueba activa. Desactívala antes de crear otra." });
    }
    if (state?.summerDay?.production?.enabled) {
      return res.status(409).json({ error: "Cancela la campaña programada antes de iniciar una prueba." });
    }
    const productData = await gql(
      shop,
      `query SummerTestProduct($id:ID!){product(id:$id){id legacyResourceId title handle status featuredMedia{preview{image{url}}}variants(first:250){nodes{id sku price compareAtPrice}}}}`,
      { id: productId },
      req,
    );
    if (!productData.product) return res.status(404).json({ error: "Producto no encontrado." });
    const pricePlan = summerProductPricePlan(productData.product.variants?.nodes || [], percentage);
    if (!pricePlan.ok) return res.status(409).json({ error: "Las variantes del producto no comparten una regla de precio segura." });
    if (!pricePlan.discountRequired) {
      return res.status(409).json({ error: "El precio vigente ya es igual o mejor que el objetivo elegido; no hace falta añadir otro descuento." });
    }
    const startsAt = new Date(Date.now() - 30_000).toISOString();
    const endsAt = new Date(Date.now() + durationMinutes * 60_000).toISOString();
    created = await createSummerBasicDiscount(shop, req, summerBasicDiscountInput({
      title: `GESTPLANT · SUMMER DAY TEST · ${percentage}% DESDE ORIGINAL`,
      effectiveFraction: pricePlan.effectiveFraction,
      productIds: [productId],
      startsAt,
      endsAt,
    }));
    const test = {
      enabled: true,
      percentage,
      startsAt,
      endsAt,
      product: {
        id: productData.product.id,
        legacyResourceId: String(productData.product.legacyResourceId || ""),
        title: productData.product.title,
        handle: productData.product.handle,
        image: productData.product.featuredMedia?.preview?.image?.url || null,
      },
      discount: created,
      pricePlan,
      activatedAt: new Date().toISOString(),
    };
    await updateState(shop, (current) => ({
      ...current,
      summerDay: { ...(current.summerDay || {}), test },
    }));
    res.json({ ok: true, test });
  } catch (error) {
    if (created?.id) await deleteAutomaticDiscount(shop, req, created.id).catch(() => {});
    res.status(error.status || (/access|scope|permission/i.test(error.message) ? 403 : 502)).json({ error: error.message });
  }
}

async function disableSummerTest(req, res) {
  try {
    const shop = shopOf(req);
    const state = await readState(shop);
    const test = state?.summerDay?.test;
    if (test?.discount?.id) await deleteAutomaticDiscount(shop, req, test.discount.id);
    await updateState(shop, (current) => ({
      ...current,
      summerDay: {
        ...(current.summerDay || {}),
        test: test ? { ...test, enabled: false, disabledAt: new Date().toISOString(), discount: null } : null,
      },
    }));
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

async function publishSummerDay(req, res) {
  const shop = shopOf(req);
  const created = [];
  let pausedDiscounts = [];
  try {
    let state = await readState(shop);
    if (state?.summerDay?.production?.discounts?.some((discount) => discount.id)) {
      return res.status(409).json({ error: "Summer Day ya está programado. Cancélalo antes de reemplazarlo." });
    }
    if (state?.summerDay?.test?.enabled) {
      return res.status(409).json({ error: "Desactiva la prueba antes de programar la campaña completa." });
    }
    const validation = await resolveSummerProducts(shop, req);
    if (!validation.ok || validation.resolved.length !== SUMMER_DAY_MANIFEST.products.length) {
      await updateState(shop, (current) => ({
        ...current,
        summerDay: { ...(current.summerDay || {}), validation },
      }));
      return res.status(409).json({ error: "La validación del catálogo no está completa.", validation });
    }
    const groups = validation.pricingGroups.map((effectiveFraction) => ({
      effectiveFraction,
      products: validation.resolved.filter((product) => product.pricePlan.effectiveFraction === effectiveFraction),
    }));
    pausedDiscounts = await pauseSupersededDiscounts(shop, req);
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const assignedRates = [...new Set(group.products.map((product) => product.discountPercent))].sort().join("/");
      const discount = await createSummerBasicDiscount(shop, req, summerBasicDiscountInput({
        title: `SUMMER DAY · ORIGINAL ${assignedRates}% · ${index + 1}/${groups.length}`,
        effectiveFraction: group.effectiveFraction,
        productIds: group.products.map((product) => product.productId),
        startsAt: SUMMER_DAY_MANIFEST.startsAt,
        endsAt: SUMMER_DAY_MANIFEST.endsAt,
      }));
      created.push({
        productCount: group.products.length,
        effectiveFraction: group.effectiveFraction,
        effectivePercent: Math.round(Number(group.effectiveFraction) * 1_000_000) / 10_000,
        ...discount,
      });
    }
    const production = {
      enabled: true,
      status: "scheduled",
      startsAt: SUMMER_DAY_MANIFEST.startsAt,
      endsAt: SUMMER_DAY_MANIFEST.endsAt,
      discounts: created,
      pausedDiscounts,
      priceRule: "min(currentPrice, originalPrice * (1 - percentage))",
      scheduledAt: new Date().toISOString(),
    };
    state = await updateState(shop, (current) => ({
      ...current,
      summerDay: { ...(current.summerDay || {}), validation, production },
    }));
    res.json({ ok: true, manifest: summerManifestSummary(), production: state.summerDay.production });
  } catch (error) {
    await Promise.allSettled(created.map((discount) => deleteAutomaticDiscount(shop, req, discount.id)));
    if (pausedDiscounts.length) await restoreSupersededDiscounts(shop, req, pausedDiscounts).catch(() => {});
    res.status(error.status || (/access|scope|permission/i.test(error.message) ? 403 : 502)).json({
      error: error.message,
      rolledBack: created.length,
    });
  }
}

async function disableSummerProduction(req, res) {
  try {
    const shop = shopOf(req);
    const state = await readState(shop);
    const production = state?.summerDay?.production;
    const ids = (production?.discounts || []).map((discount) => discount.id).filter(Boolean);
    const results = await Promise.allSettled(ids.map((id) => deleteAutomaticDiscount(shop, req, id)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error("No se pudieron retirar todos los descuentos; vuelve a intentarlo.");
    if (production?.pausedDiscounts?.length) await restoreSupersededDiscounts(shop, req, production.pausedDiscounts);
    await updateState(shop, (current) => ({
      ...current,
      summerDay: {
        ...(current.summerDay || {}),
        production: production
          ? { ...production, enabled: false, status: "cancelled", discounts: [], pausedDiscounts: [], disabledAt: new Date().toISOString() }
          : null,
      },
    }));
    res.json({ ok: true, removed: ids.length });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

async function summerStorefront(req, res) {
  try {
    const state = await cleanupExpiredSummerDay(DEFAULT_SHOP, req);
    const summerDay = state?.summerDay || {};
    const now = Date.now();
    const campaigns = [];
    const test = summerDay.test;
    if (test?.enabled && test.discount?.id && now < Date.parse(test.endsAt)) {
      campaigns.push({
        mode: "test",
        label: SUMMER_DAY_MANIFEST.display.label,
        startsAt: test.startsAt,
        endsAt: test.endsAt,
        active: now >= Date.parse(test.startsAt) && now < Date.parse(test.endsAt),
        products: [{
          id: test.product.legacyResourceId,
          handle: test.product.handle,
          discountPercent: test.percentage,
        }],
      });
    }
    const production = summerDay.production;
    if (production?.enabled && production.discounts?.length >= 1 && summerDay.validation?.ok) {
      campaigns.push({
        mode: "production",
        label: SUMMER_DAY_MANIFEST.display.label,
        startsAt: production.startsAt,
        endsAt: production.endsAt,
        active: now >= Date.parse(production.startsAt) && now < Date.parse(production.endsAt),
        products: summerDay.validation.resolved.map((product) => ({
          id: product.legacyResourceId,
          handle: product.handle,
          discountPercent: product.discountPercent,
        })),
      });
    }
    res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
    res.json({
      id: SUMMER_DAY_MANIFEST.id,
      timezone: SUMMER_DAY_MANIFEST.timezone,
      display: SUMMER_DAY_MANIFEST.display,
      generatedAt: new Date().toISOString(),
      campaigns,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/discounts/summer-day/status", summerStatus);
app.post("/api/discounts/summer-day/validate", validateSummerDay);
app.get("/api/discounts/products", searchSummerProducts);
app.post("/api/discounts/summer-day/test/enable", enableSummerTest);
app.post("/api/discounts/summer-day/test/disable", disableSummerTest);
app.post("/api/discounts/summer-day/publish", publishSummerDay);
app.post("/api/discounts/summer-day/disable", disableSummerProduction);
app.get("/api/discounts/summer-day/storefront", summerStorefront);

async function loadStrategy(shop, req) {
  const state = await readState(shop).catch(() => null);
  if (state?.strategy) {
    memoryStrategy = {
      ...structuredClone(DEFAULT_STRATEGY),
      ...normalizeStrategyCollections(state.strategy),
      weights: normalizeWeights(state.strategy.weights),
      scoreRules: normalizeScoreRules(state.strategy.scoreRules),
      manualOverrides: normalizeManualOverrides(state.strategy.manualOverrides),
    };
    return {
      ...memoryStrategy,
      versionCount: state.strategyVersions?.length || 0,
      persistence: "postgresql",
    };
  }

  try {
    const data = await gql(
      shop,
      'query{currentAppInstallation{id metafield(namespace:"trendsplant" key:"strategy"){value}}}',
      {},
      req,
    );
    const value = data.currentAppInstallation?.metafield?.value;
    if (value) {
      const parsed = JSON.parse(value);
      memoryStrategy = {
        ...structuredClone(DEFAULT_STRATEGY),
        ...normalizeStrategyCollections(parsed),
        weights: normalizeWeights(parsed.weights),
        scoreRules: normalizeScoreRules(parsed.scoreRules),
        manualOverrides: normalizeManualOverrides(parsed.manualOverrides),
      };
      await writeState(shop, { strategy: memoryStrategy }).catch(() => {});
      return { ...memoryStrategy, persistence: "shopify_app_metafield_migrated" };
    }
  } catch {}

  return { ...memoryStrategy, persistence: "memory_fallback" };
}

function strategySnapshot(value) {
  const { persistence, versionCount, ...strategy } = value || {};
  return structuredClone(strategy);
}

async function loadPublishedStrategy(shop, req) {
  const state = await readState(shop).catch(() => null);
  if (state?.publishedStrategy) {
    return {
      ...structuredClone(DEFAULT_STRATEGY),
      ...normalizeStrategyCollections(state.publishedStrategy),
      weights: normalizeWeights(state.publishedStrategy.weights),
      scoreRules: normalizeScoreRules(state.publishedStrategy.scoreRules),
      manualOverrides: normalizeManualOverrides(state.publishedStrategy.manualOverrides),
      persistence: "postgresql",
    };
  }
  return loadStrategy(shop, req);
}

async function saveStrategy(shop, next, req, options = {}) {
  const state = (await readState(shop).catch(() => null)) || {};
  const previous = state.strategy || memoryStrategy || DEFAULT_STRATEGY;
  const createdAt = new Date().toISOString();
  const revision = Number(previous.audit?.revision || 0) + 1;
  const versionId = "v" + revision + "-" + Date.now().toString(36);
  const strategy = {
    ...structuredClone(DEFAULT_STRATEGY),
    ...normalizeStrategyCollections(strategySnapshot(next)),
    weights: normalizeWeights(next.weights),
    scoreRules: normalizeScoreRules(next.scoreRules),
    manualOverrides: normalizeManualOverrides(next.manualOverrides),
    audit: {
      ...previous.audit,
      ...next.audit,
      revision,
      versionId,
      lastUpdated: createdAt,
      ...(options.publish
        ? { lastApplied: createdAt, lastAppliedBy: options.actor || "admin" }
        : {}),
    },
  };
  const versions = [
    {
      id: versionId,
      revision,
      action: options.action || "save",
      actor: options.actor || "admin",
      createdAt,
      published: Boolean(options.publish),
      rollbackFrom: options.rollbackFrom || null,
      strategy: strategySnapshot(strategy),
    },
    ...(state.strategyVersions || []),
  ].slice(0, MAX_STRATEGY_VERSIONS);
  memoryStrategy = strategy;
  await writeState(shop, {
    strategy,
    strategyVersions: versions,
    ...(options.publish ? { publishedStrategy: strategy } : {}),
  });
  rankingCache.clear();

  let mirror = "postgresql";
  try {
    const installation = await gql(shop, "query{currentAppInstallation{id}}", {}, req);
    const output = await gql(
      shop,
      "mutation Save($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}",
      {
        m: [
          {
            ownerId: installation.currentAppInstallation.id,
            namespace: "trendsplant",
            key: "strategy",
            type: "json",
            value: JSON.stringify(strategy),
          },
        ],
      },
      req,
    );
    if (output.metafieldsSet.userErrors?.length) {
      throw new Error(output.metafieldsSet.userErrors.map((error) => error.message).join("; "));
    }
    mirror = "postgresql+shopify_app_metafield";
  } catch {}

  return { ...strategy, versionCount: versions.length, persistence: mirror };
}

async function collectionProducts(shop, handle, req, after = null) {
  const data = await gql(
    shop,
    "query GetCollection($handle:String!,$after:String){collectionByHandle(handle:$handle){id title handle products(first:100,after:$after){nodes{id title handle tags productType createdAt publishedAt totalInventory options{name values} variants(first:100){nodes{availableForSale selectedOptions{name value}}} featuredImage{url altText}priceRangeV2{minVariantPrice{amount currencyCode}}}pageInfo{hasNextPage endCursor}}}}",
    { handle, after },
    req,
  );
  const collection = data.collectionByHandle;
  if (!collection) throw new Error("Colección no encontrada: " + handle);
  return {
    collection: { id: collection.id, title: collection.title, handle: collection.handle },
    products: collection.products.nodes.map((product) => ({
      ...product,
      variants: (product.variants?.nodes || []).map((variant) => ({
        availableForSale: Boolean(variant.availableForSale),
        selectedOptions: variant.selectedOptions || [],
      })),
      availableForSale: Number(product.totalInventory || 0) > 0,
    })),
    pageInfo: collection.products.pageInfo,
  };
}

async function allCollectionProducts(shop, handle, req) {
  let after = null;
  let collection = null;
  let products = [];
  let guard = 0;
  do {
    const page = await collectionProducts(shop, handle, req, after);
    collection ||= page.collection;
    products = products.concat(page.products);
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    guard += 1;
  } while (after && guard < 25);
  return { collection, products, pageInfo: { hasNextPage: false, endCursor: null } };
}

async function publicCollectionProducts(handle) {
  const response = await fetch(
    "https://trendsplant.com/collections/" + encodeURIComponent(handle) + "/products.json?limit=250",
    { headers: { Accept: "application/json" } },
  );
  const raw = await response.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {}
  if (!response.ok || !Array.isArray(data.products)) {
    throw new Error("No se pudo cargar la colección pública (" + response.status + ").");
  }
  return {
    collection: { id: null, title: handle, handle },
    products: data.products.map((product) => {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const image = Array.isArray(product.images) ? product.images[0] : null;
      return {
        id: String(product.id),
        title: product.title,
        handle: product.handle,
        tags: Array.isArray(product.tags)
          ? product.tags
          : String(product.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
        productType: product.product_type || "",
        createdAt: product.created_at || null,
        publishedAt: product.published_at || null,
        totalInventory: variants.some((variant) => variant.available) ? 1 : 0,
        availableForSale: variants.some((variant) => variant.available),
        featuredImage: image ? { url: image.src || image.url, altText: image.alt || product.title } : null,
        priceRangeV2: {
          minVariantPrice: { amount: String(variants[0]?.price || 0), currencyCode: "EUR" },
        },
      };
    }),
    pageInfo: { hasNextPage: false, endCursor: null },
    source: "shopify_public_collection_json",
  };
}

function decodeHeader(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

const COUNTRY_COORDINATES = {
  ES: [40.4168, -3.7038],
  PT: [38.7223, -9.1393],
  FR: [48.8566, 2.3522],
  IT: [41.9028, 12.4964],
  DE: [52.52, 13.405],
  GB: [51.5074, -0.1278],
  US: [38.9072, -77.0369],
  NL: [52.3676, 4.9041],
  BE: [50.8503, 4.3517],
};

function geoFromRequest(req, overrides = {}) {
  const country = String(
    overrides.country || req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || "ES",
  ).toUpperCase();
  const fallback = COUNTRY_COORDINATES[country] || COUNTRY_COORDINATES.ES;
  const latitude = Number(overrides.latitude ?? req.headers["x-vercel-ip-latitude"] ?? fallback[0]);
  const longitude = Number(overrides.longitude ?? req.headers["x-vercel-ip-longitude"] ?? fallback[1]);
  return {
    country,
    region: decodeHeader(req.headers["x-vercel-ip-country-region"]),
    city: decodeHeader(req.headers["x-vercel-ip-city"]),
    timezone: decodeHeader(req.headers["x-vercel-ip-timezone"]),
    latitude: Number.isFinite(latitude) ? Math.round(latitude * 100) / 100 : fallback[0],
    longitude: Number.isFinite(longitude) ? Math.round(longitude * 100) / 100 : fallback[1],
  };
}

async function weatherFor(geo, overrideTemperature) {
  if (overrideTemperature !== undefined && overrideTemperature !== null && overrideTemperature !== "") {
    return { temperatureC: Number(overrideTemperature), weatherCode: null, source: "manual_override" };
  }
  const key = geo.latitude + "," + geo.longitude;
  const cached = weatherCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    runtimeMetrics.cache.weatherHits += 1;
    return cached.value;
  }
  runtimeMetrics.cache.weatherMisses += 1;

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.latitude));
    url.searchParams.set("longitude", String(geo.longitude));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code");
    url.searchParams.set("timezone", "auto");
    const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
    const data = await response.json();
    if (!response.ok || !Number.isFinite(Number(data.current?.temperature_2m))) {
      throw new Error("Tiempo no disponible");
    }
    const value = {
      temperatureC: Number(data.current.temperature_2m),
      apparentTemperatureC: Number(data.current.apparent_temperature),
      weatherCode: data.current.weather_code,
      observedAt: data.current.time,
      source: "open_meteo",
    };
    setBoundedCache(
      weatherCache,
      key,
      { value, expiresAt: Date.now() + WEATHER_TTL_MS },
      WEATHER_CACHE_LIMIT,
    );
    return value;
  } catch {
    const month = new Date().getUTCMonth();
    const northernSummer = month >= 4 && month <= 8;
    return {
      temperatureC: northernSummer ? 24 : 14,
      weatherCode: null,
      source: "seasonal_fallback",
    };
  }
}

async function recentSalesByProduct(shop, req) {
  const cached = salesCache.get(shop);
  if (cached && Date.now() < cached.expiresAt) {
    runtimeMetrics.cache.salesHits += 1;
    return cached.value;
  }
  runtimeMetrics.cache.salesMisses += 1;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const totals = {};
  const totalsByCountry = {};
  let after = null;
  let guard = 0;
  try {
    do {
      const data = await gql(
        shop,
        "query RecentSales($after:String,$query:String!){orders(first:100,after:$after,query:$query,sortKey:CREATED_AT,reverse:true){nodes{shippingAddress{countryCodeV2} lineItems(first:100){nodes{quantity product{id}}}}pageInfo{hasNextPage endCursor}}}",
        { after, query: "created_at:>=" + since },
        req,
      );
      for (const order of data.orders.nodes) {
        const country = String(order.shippingAddress?.countryCodeV2 || "").toUpperCase();
        if (country && !totalsByCountry[country]) totalsByCountry[country] = {};
        for (const item of order.lineItems.nodes) {
          if (!item.product?.id) continue;
          totals[item.product.id] = (totals[item.product.id] || 0) + item.quantity;
          if (country) totalsByCountry[country][item.product.id] = (totalsByCountry[country][item.product.id] || 0) + item.quantity;
        }
      }
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      guard += 1;
    } while (after && guard < 5);
    const value = { totals, totalsByCountry, source: "shopify_orders_30d_by_country", measuredAt: new Date().toISOString() };
    salesCache.set(shop, { value, expiresAt: Date.now() + SALES_TTL_MS });
    return value;
  } catch (error) {
    return {
      totals: {},
      totalsByCountry: {},
      source: /access|scope|denied/i.test(String(error?.message || error))
        ? "shopify_orders_scope_unavailable"
        : "shopify_orders_unavailable",
      measuredAt: new Date().toISOString(),
    };
  }
}

function classify(product) {
  const text = (product.title + " " + product.productType + " " + (product.tags || []).join(" ")).toLowerCase();
  if (/shirt|tee|linen|short|swim|cap|hat|tank|polo/.test(text)) return "light";
  if (/hood|sweat|jacket|fleece|wool|knit|corduroy|coat|beanie/.test(text)) return "warm";
  if (/pant|denim|trouser|chino/.test(text)) return "mid";
  return "core";
}

function temperatureScore(type, temperature) {
  if (temperature >= 27) return type === "light" ? 100 : type === "core" ? 65 : type === "mid" ? 55 : 25;
  if (temperature >= 20) return type === "light" ? 88 : type === "core" ? 80 : type === "mid" ? 72 : 55;
  if (temperature <= 10) return type === "warm" ? 100 : type === "mid" ? 72 : type === "core" ? 55 : 25;
  if (temperature <= 16) return type === "warm" ? 90 : type === "mid" ? 82 : type === "core" ? 70 : 50;
  return type === "mid" || type === "core" ? 82 : 72;
}

function newnessScore(product) {
  const date = new Date(product.publishedAt || product.createdAt || 0).getTime();
  if (!date) return 50;
  const days = (Date.now() - date) / 86400000;
  if (days <= 14) return 100;
  if (days <= 30) return 88;
  if (days <= 90) return 68;
  if (days <= 180) return 52;
  return 35;
}

function countryTagScore(product, country) {
  const tags = (product.tags || []).join(" ").toUpperCase();
  if (new RegExp("(^|[^A-Z])" + country + "([^A-Z]|$)").test(tags)) return 100;
  if (country === "ES" && /SPAIN|ESPAÑA|LOCAL|ALICANTE/.test(tags)) return 95;
  if (/GLOBAL|WORLDWIDE|EUROPE|EU/.test(tags)) return 75;
  return 58;
}

function demandScore(units, maxUnits, fallback = 50) {
  if (!maxUnits) return fallback;
  return Math.round(40 + (60 * Math.log1p(units)) / Math.log1p(maxUnits));
}

function countrySalesScore(product, country, sales) {
  const globalTotals = sales?.totals || {};
  const localTotals = sales?.totalsByCountry?.[country] || {};
  const globalMax = Math.max(0, ...Object.values(globalTotals));
  const localMax = Math.max(0, ...Object.values(localTotals));
  const localVolume = Object.values(localTotals).reduce((sum, units) => sum + Number(units || 0), 0);
  const globalScore = demandScore(Number(globalTotals[product.id] || 0), globalMax, countryTagScore(product, country));
  if (!localMax) return { score: globalScore, localUnits: 0, source: "global_fallback" };
  const localScore = demandScore(Number(localTotals[product.id] || 0), localMax);
  const confidence = Math.min(1, localVolume / 20);
  return {
    score: Math.round(localScore * confidence + globalScore * (1 - confidence)),
    localUnits: Number(localTotals[product.id] || 0),
    source: confidence >= 1 ? "country_sales" : "country_sales_blended",
  };
}

function productSizeCoverage(product) {
  const options = Array.isArray(product.options) ? product.options : [];
  const sizeIndex = options.findIndex((option) => /^(size|talla|tamaño)$/i.test(String(option?.name || "").trim()));
  if (sizeIndex < 0) return { total: 0, available: 0, percentage: null };
  const values = Array.isArray(options[sizeIndex]?.values) ? options[sizeIndex].values : [];
  const totalValues = new Set(values.map((value) => String(value?.name || value || "").trim()).filter(Boolean));
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const availableValues = new Set();
  variants.forEach((variant) => {
    if (!Boolean(variant.availableForSale ?? variant.available)) return;
    const selected = Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [];
    const fromSelected = selected.find((option) => String(option?.name || "").trim().toLowerCase() === String(options[sizeIndex]?.name || "").trim().toLowerCase());
    const value = fromSelected?.value ?? variant["option" + (sizeIndex + 1)];
    if (value) availableValues.add(String(value).trim());
  });
  const total = totalValues.size || availableValues.size;
  const available = availableValues.size;
  return { total, available, percentage: total ? Math.round((available / total) * 100) : null };
}

function productAgeDays(product) {
  const value = product.publishedAt || product.createdAt;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((Date.now() - timestamp) / 86400000)) : null;
}

function manualOverrideMatches(product, ref) {
  const id = String(product?.id || "");
  const handle = String(product?.handle || "").toLowerCase();
  return Boolean(ref?.enabled !== false && ((ref.id && ref.id === id) || (ref.handle && ref.handle === handle)));
}

function rankProducts(products, context, strategy) {
  const weights = strategy.weights;
  const scoreRules = normalizeScoreRules(strategy.scoreRules);
  const manualOverrides = normalizeManualOverrides(strategy.manualOverrides);
  const salesTotals = context.sales?.totals || {};
  const maxSales = Math.max(0, ...Object.values(salesTotals));
  const temperature = Number(context.weather?.temperatureC ?? context.temperatureC ?? 22);
  const country = context.geo?.country || context.country || "ES";
  const pinRefs = manualOverrides.pins.filter((ref) => ref.enabled !== false);
  const exclusionRefs = manualOverrides.exclusions.filter((ref) => ref.enabled !== false);
  const hasManualOverride = (product) =>
    pinRefs.some((ref) => manualOverrideMatches(product, ref)) ||
    exclusionRefs.some((ref) => manualOverrideMatches(product, ref));

  const scored = products
    .filter((product) => !strategy.exclusions.excludeOutOfStock || product.availableForSale || scoreRules.soldOutToEnd || hasManualOverride(product))
    .map((product) => {
      const type = classify(product);
      const thermal = temperatureScore(type, temperature);
      const countryDemand = countrySalesScore(product, country, context.sales);
      const affinity = countryDemand.score;
      const availability = product.availableForSale ? 100 : 0;
      const newness = newnessScore(product);
      const salesUnits = Number(salesTotals[product.id] || 0);
      const recentSales = demandScore(salesUnits, maxSales);
      const baseScore = Math.round(
        (thermal * weights.temperatureFit +
          affinity * weights.countryAffinity +
          recentSales * weights.recentSales +
          newness * weights.newness +
          availability * weights.availability) /
          100,
      );
      const sizeCoverage = productSizeCoverage(product);
      const ageDays = productAgeDays(product);
      const adjustments = [];
      if (sizeCoverage.total === 1 && scoreRules.oneSizePenalty) {
        adjustments.push({ key: "one_size", label: "Una sola talla", points: scoreRules.oneSizePenalty });
      }
      if (
        sizeCoverage.percentage !== null &&
        sizeCoverage.percentage < scoreRules.lowSizeThreshold &&
        scoreRules.lowSizePenalty
      ) {
        adjustments.push({
          key: "low_size_coverage",
          label: "Solo " + sizeCoverage.percentage + "% de tallas disponibles",
          points: scoreRules.lowSizePenalty,
        });
      }
      if (ageDays !== null && ageDays <= scoreRules.freshDays && scoreRules.freshBonus) {
        adjustments.push({ key: "fresh", label: "Novedad · " + ageDays + " días", points: scoreRules.freshBonus });
      } else if (
        ageDays !== null &&
        ageDays >= scoreRules.recentStartDays &&
        ageDays <= scoreRules.recentEndDays &&
        scoreRules.recentBonus
      ) {
        adjustments.push({ key: "recent", label: "Novedad reciente · " + ageDays + " días", points: scoreRules.recentBonus });
      }
      const pin = pinRefs.find((ref) => manualOverrideMatches(product, ref));
      const manuallyExcluded = exclusionRefs.some((ref) => manualOverrideMatches(product, ref));
      const score = baseScore + adjustments.reduce((total, adjustment) => total + adjustment.points, 0);
      const forcedToEnd = manuallyExcluded || (!product.availableForSale && scoreRules.soldOutToEnd);
      const reasons = [
        thermal >= 85 ? "Temperatura real favorable" : "Compatibilidad térmica media",
        countryDemand.localUnits > 0
          ? countryDemand.localUnits + " uds. vendidas en " + country + " en 30 días"
          : "Demanda global usada como respaldo para " + country,
        salesUnits > 0 ? salesUnits + " uds. vendidas en 30 días" : "Sin ventas recientes registradas",
        newness >= 85 ? "Novedad" : "Producto consolidado",
        availability ? "Disponible" : forcedToEnd ? "Sin stock · enviado al final" : "Sin stock",
        ...adjustments.map((adjustment) => adjustment.label + " · " + (adjustment.points > 0 ? "+" : "") + adjustment.points + " pts."),
        ...(pin ? ["Fijado manualmente · posición #" + pin.position] : []),
        ...(manuallyExcluded ? ["Excluido de la priorización · enviado al final"] : []),
      ];
      return {
        ...product,
        type,
        score,
        baseScore,
        adjustments,
        forcedToEnd,
        pinnedPosition: pin?.position || null,
        excludedFromAlgorithm: manuallyExcluded,
        signals: { thermal, affinity, recentSales, newness, availability, salesUnits, countrySalesUnits: countryDemand.localUnits, countrySalesSource: countryDemand.source, sizeCoverage, ageDays },
        reasons,
      };
    });

  const compareUnpinned = (a, b) =>
    Number(a.excludedFromAlgorithm) - Number(b.excludedFromAlgorithm) ||
    Number(a.forcedToEnd) - Number(b.forcedToEnd) ||
    b.score - a.score ||
    (b.signals.salesUnits || 0) - (a.signals.salesUnits || 0);
  const pinned = scored.filter((product) => product.pinnedPosition).sort((a, b) => a.pinnedPosition - b.pinnedPosition);
  const unpinned = scored.filter((product) => !product.pinnedPosition).sort(compareUnpinned);
  const ranked = [];
  const occupied = new Set();
  pinned.forEach((product) => {
    let index = Math.min(Math.max(0, product.pinnedPosition - 1), Math.max(0, scored.length - 1));
    while (occupied.has(index) && index < scored.length - 1) index += 1;
    occupied.add(index);
    ranked[index] = product;
  });
  let nextIndex = 0;
  unpinned.forEach((product) => {
    while (occupied.has(nextIndex)) nextIndex += 1;
    ranked[nextIndex] = product;
    occupied.add(nextIndex);
  });
  return ranked.filter(Boolean);
}

function publicProductRanking(product) {
  const salesBand = product.signals.recentSales >= 80
    ? "Demanda reciente alta"
    : product.signals.recentSales >= 60
      ? "Demanda reciente media"
      : "Demanda reciente baja";
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    score: product.score,
    baseScore: product.baseScore,
    adjustments: product.adjustments,
    pinnedPosition: product.pinnedPosition || null,
    excludedFromAlgorithm: product.excludedFromAlgorithm === true,
    reasons: [product.reasons[0], product.reasons[1], salesBand, product.reasons[3], product.reasons[4], ...(product.reasons.slice(5) || [])],
    signals: {
      thermal: product.signals.thermal,
      affinity: product.signals.affinity,
      recentSales: product.signals.recentSales,
      newness: product.signals.newness,
      availability: product.signals.availability,
      sizeCoverage: product.signals.sizeCoverage,
      ageDays: product.signals.ageDays,
    },
    availableForSale: product.availableForSale,
  };
}

async function buildContext(req, overrides = {}, shop) {
  const geo = geoFromRequest(req, overrides);
  const [weather, sales] = await Promise.all([
    weatherFor(geo, overrides.temperatureC),
    shop ? recentSalesByProduct(shop, req) : Promise.resolve({ totals: {}, source: "not_requested" }),
  ]);
  return { geo, weather, sales, generatedAt: new Date().toISOString() };
}

function collectionRankingMoves(currentProducts, rankedProducts, limit = 250) {
  const order = currentProducts.map((product) => product.id);
  const moves = [];
  for (const [position, product] of rankedProducts.slice(0, limit).entries()) {
    const currentPosition = order.indexOf(product.id);
    if (currentPosition < 0 || currentPosition === position) continue;
    moves.push({ id: product.id, newPosition: String(position) });
    order.splice(currentPosition, 1);
    order.splice(position, 0, product.id);
  }
  return moves;
}

async function publishCollectionRanking(shop, strategy, req, handle) {
  const data = await allCollectionProducts(shop, handle, req);
  const context = await buildContext(req, req.body || {}, shop);
  const ranked = rankProducts(data.products, context, strategy);
  if (!data.collection?.id) throw new Error("No se pudo identificar la colección para publicar el ranking.");

  const update = await gql(
    shop,
    "mutation Manual($collection:CollectionUpdateInput!){collectionUpdate(collection:$collection){collection{id sortOrder}userErrors{field message}}}",
    { collection: { id: data.collection.id, sortOrder: "MANUAL" } },
    req,
  );
  const updateErrors = update.collectionUpdate.userErrors || [];
  if (updateErrors.length) throw new Error(updateErrors.map((error) => error.message).join("; "));

  const moves = collectionRankingMoves(data.products, ranked);
  if (!moves.length) {
    return {
      ok: true,
      handle,
      status: "already_ranked",
      movedCount: 0,
      salesSource: context.sales?.source,
      topHandles: ranked.slice(0, 10).map((product) => product.handle),
    };
  }

  const result = await gql(
    shop,
    "mutation Reorder($id:ID!,$moves:[MoveInput!]!){collectionReorderProducts(id:$id,moves:$moves){job{id done}userErrors{field message}}}",
    { id: data.collection.id, moves },
    req,
  );
  const reorder = result.collectionReorderProducts;
  if (reorder.userErrors?.length) {
    throw new Error(reorder.userErrors.map((error) => error.message).join("; "));
  }
  return {
    ok: true,
    handle,
    status: reorder.job?.done ? "complete" : "processing",
    jobId: reorder.job?.id || null,
    movedCount: moves.length,
    salesSource: context.sales?.source,
    topHandles: ranked.slice(0, 10).map((product) => product.handle),
  };
}

app.get("/api/health", async (_req, res) => {
  const persistence = DATABASE_URL ? "postgresql" : "unavailable";
  res.json({
    ok: true,
    service: "trendsplant-ordering-app",
    phase: "storefront-control-observability",
    persistence,
    signals: ["geo_ip", "temperature", "recent_sales", "newness", "availability"],
    capabilities: ["strategy_versions", "rollback", "analytics_dimensions", "orders_webhook", "rate_limits", "ranking_cache"],
  });
});

async function persistenceStatus(req, res) {
  try {
    const shop = shopOf(req);
    const state = await readState(shop);
    res.json({
      connected: Boolean(DATABASE_URL),
      persisted: Boolean(state),
      hasToken: Boolean(state?.accessToken),
      hasStrategy: Boolean(state?.strategy),
      version: state?.version || null,
      updatedAt: state?.updatedAt || null,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/persistence/status", persistenceStatus);
app.get("/api/persistence-status", persistenceStatus);

async function persistenceMigrate(req, res) {
  try {
    const shop = shopOf(req);
    const session = sessionFrom(req);
    if (!session?.accessToken) return res.status(409).json({ error: "La sesión no contiene un token migrable." });
    const strategy = await loadStrategy(shop, req);
    await writeState(shop, {
      accessToken: session.accessToken,
      accessTokenExpiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
      strategy: { ...strategy, persistence: undefined },
      sessionMigratedAt: new Date().toISOString(),
    });
    res.json({ ok: true, persistence: "postgresql" });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.post("/api/persistence/migrate", persistenceMigrate);
app.post("/api/persistence-migrate", persistenceMigrate);

app.get("/api/visitor-context", async (req, res) => {
  const context = await buildContext(req, req.query || {}, null);
  res.json({ geo: context.geo, weather: context.weather, generatedAt: context.generatedAt });
});

app.get("/api/strategy", async (req, res) => {
  try {
    res.json(await loadStrategy(shopOf(req), req));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.put("/api/strategy", async (req, res) => {
  try {
    res.json(await saveStrategy(shopOf(req), req.body || {}, req, { action: "save" }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

async function strategyVersions(req, res) {
  try {
    const state = await readState(shopOf(req));
    const versions = (state?.strategyVersions || []).map(({ strategy, ...version }) => ({
      ...version,
      collectionHandle: strategy?.collectionHandle,
      collectionHandles: collectionHandlesFor(strategy || {}),
      mode: strategy?.mode,
      weights: strategy?.weights,
    }));
    res.json({ versions, publishedVersionId: state?.publishedStrategy?.audit?.versionId || null });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/strategy/versions", strategyVersions);
app.get("/api/strategy-versions", strategyVersions);

async function rollbackStrategy(req, res) {
  try {
    const shop = shopOf(req);
    const state = await readState(shop);
    const versions = state?.strategyVersions || [];
    const currentId = state?.publishedStrategy?.audit?.versionId;
    const requestedId = String(req.body?.versionId || "");
    const target = requestedId
      ? versions.find((version) => version.id === requestedId)
      : versions.find((version) => version.published && version.id !== currentId);
    if (!target?.strategy) return res.status(404).json({ error: "No hay una versión anterior disponible." });
    const restored = {
      ...target.strategy,
      audit: {
        ...target.strategy.audit,
        lastRollback: new Date().toISOString(),
        rollbackSourceVersionId: target.id,
      },
    };
    const strategy = await saveStrategy(shop, restored, req, {
      action: "rollback",
      publish: true,
      rollbackFrom: currentId || null,
    });
    res.json({ ok: true, message: "Rollback aplicado y propagado al storefront.", strategy });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.post("/api/strategy/rollback", rollbackStrategy);
app.post("/api/strategy-rollback", rollbackStrategy);

app.get("/api/shopify-products", async (req, res) => {
  try {
    const shop = shopOf(req);
    const data = await collectionProducts(
      shop,
      String(req.query?.handle || "men"),
      req,
      req.query?.after || null,
    );
    res.json({ shop, ...data, source: "shopify_admin_graphql" });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

async function simulate(req, res) {
  try {
    const shop = shopOf(req);
    const strategy = await loadStrategy(shop, req);
    const context = await buildContext(req, req.body || {}, shop);
    const handle = String(req.body?.handle || collectionHandlesFor(strategy)[0] || "men");
    let data;
    let source = "shopify_admin_graphql";
    try {
      data = await allCollectionProducts(shop, handle, req);
    } catch {
      data = await publicCollectionProducts(handle);
      source = data.source;
    }
    res.json({
      context,
      collection: data.collection,
      ranked: rankProducts(data.products, context, strategy),
      weights: strategy.weights,
      strategyVersion: strategy.audit.lastUpdated,
      source,
      persistence: strategy.persistence,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.post("/api/strategy/simulate", simulate);
app.post("/api/strategy-simulate", simulate);

async function applyStrategy(req, res) {
  try {
    const shop = shopOf(req);
    const strategy = await loadStrategy(shop, req);
    if (strategy.mode !== "live") {
      return res.status(409).json({
        error: "La estrategia está en modo simulación. Cambia a live antes de aplicar.",
      });
    }
    const collectionOrdering = [];
    for (const handle of collectionHandlesFor(strategy)) {
      collectionOrdering.push(await publishCollectionRanking(shop, strategy, req, handle));
    }
    const saved = await saveStrategy(shop, strategy, req, {
      action: "apply",
      publish: true,
      actor: "admin",
    });
    let webhook = { ok: false, status: "pending" };
    try {
      webhook = await ensureOrdersWebhook(shop, req);
    } catch (error) {
      webhook = { ok: false, status: "error", error: error.message };
    }
    res.json({
      ok: true,
      message: collectionOrdering.some((item) => item.status === "processing")
        ? "Estrategia live aplicada. Shopify está terminando de ordenar las colecciones."
        : "Estrategia live aplicada y colecciones reordenadas según el ranking.",
      strategy: saved,
      collectionOrdering,
      webhook,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.post("/api/strategy/apply", applyStrategy);
app.post("/api/strategy-apply", applyStrategy);

app.get(["/auth/shopify", "/api/auth/shopify"], (req, res) => {
  const shop = shopOf(req);
  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET || !process.env.SHOPIFY_APP_URL) {
    return res.status(503).send("La autenticación de Shopify no está configurada en el servidor.");
  }
  const state = crypto.randomBytes(16).toString("hex");
  const configuredScopes = String(
    process.env.SHOPIFY_SCOPES || "read_products,write_products,read_inventory,read_orders",
  )
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopes = encodeURIComponent([...new Set(configuredScopes)].join(","));
  const redirect = encodeURIComponent((process.env.SHOPIFY_APP_URL || "") + "/api/auth/callback");
  cookie(res, "tp_oauth_state", seal({ state, shop }), 600);
  res.redirect(
    "https://" +
      shop +
      ".myshopify.com/admin/oauth/authorize?client_id=" +
      process.env.SHOPIFY_API_KEY +
      "&scope=" +
      scopes +
      "&redirect_uri=" +
      redirect +
      "&state=" +
      state,
  );
});

app.get(["/auth/callback", "/api/auth/callback"], async (req, res) => {
  const saved = open(
    String((req.headers.cookie || "").match(/(?:^|; )tp_oauth_state=([^;]+)/)?.[1] || ""),
  );
  const requestedShop = String(req.query?.shop || "").toLowerCase().replace(/\.myshopify\.com$/, "");
  const shop = shopOf(req);
  if (
    requestedShop !== DEFAULT_SHOP ||
    !validOAuthHmac(req.query || {}) ||
    !saved ||
    saved.state !== req.query.state ||
    saved.shop !== shop
  ) {
    return res.status(400).send("Estado OAuth inválido.");
  }
  clearCookie(res, "tp_oauth_state");
  try {
    const response = await fetch("https://" + shop + ".myshopify.com/admin/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: req.query.code,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      return res.status(502).send("No se pudo completar el inicio de sesión.");
    }
    const expiresAt = data.expires_in
      ? Date.now() + Math.max(60, data.expires_in - 300) * 1000
      : Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    tokenCache.set(shop, { value: data.access_token, expiresAt });
    await writeState(shop, {
      accessToken: data.access_token,
      accessTokenExpiresAt: expiresAt,
      scopes: data.scope || process.env.SHOPIFY_SCOPES || "",
      installedAt: new Date().toISOString(),
    });
    cookie(
      res,
      "tp_session",
      seal({ shop, accessToken: data.access_token, createdAt: Date.now(), version: STATE_VERSION }),
      86400,
    );
    res.redirect("/?login=success");
  } catch {
    res.status(500).send("Error OAuth.");
  }
});

app.get("/api/session", (req, res) => {
  const session = sessionFrom(req);
  res.json(
    session
      ? {
          authenticated: true,
          shop: session.shop,
          userId: session.userId || null,
          authenticatedBy: session.authenticatedBy || "cookie",
        }
      : { authenticated: false },
  );
});

app.post("/api/logout", (req, res) => {
  clearCookie(res, "tp_session");
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

function githubThemeAppConfigured() {
  return Boolean(
    process.env.GITHUB_THEME_APP_ID &&
      process.env.GITHUB_THEME_INSTALLATION_ID &&
      (process.env.GITHUB_THEME_APP_PRIVATE_KEY || process.env.GITHUB_THEME_PRIVATE_KEY),
  );
}

function githubThemeReleaseConfigured() {
  return Boolean(
    githubThemeAppConfigured() ||
      process.env.GITHUB_THEME_RELEASE_TOKEN ||
      process.env.GITHUB_PROMOTE_TOKEN,
  );
}

function githubAppJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 30, exp: now + 540, iss: process.env.GITHUB_THEME_APP_ID }),
  ).toString("base64url");
  const signingInput = header + "." + payload;
  const privateKey = String(
    process.env.GITHUB_THEME_APP_PRIVATE_KEY || process.env.GITHUB_THEME_PRIVATE_KEY || "",
  ).replace(/\\n/g, "\n");
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
    .toString("base64url");
  return signingInput + "." + signature;
}

async function githubThemeReleaseToken() {
  if (!githubThemeAppConfigured()) {
    return process.env.GITHUB_THEME_RELEASE_TOKEN || process.env.GITHUB_PROMOTE_TOKEN || "";
  }
  if (
    githubInstallationTokenCache?.value &&
    Date.now() < githubInstallationTokenCache.expiresAt - 60 * 1000
  ) {
    return githubInstallationTokenCache.value;
  }

  const response = await fetch(
    "https://api.github.com/app/installations/" +
      encodeURIComponent(process.env.GITHUB_THEME_INSTALLATION_ID) +
      "/access_tokens",
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + githubAppJwt(),
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    const error = new Error(data.message || "No se pudo autenticar la GitHub App.");
    error.status = response.status || 502;
    throw error;
  }
  githubInstallationTokenCache = {
    value: data.token,
    expiresAt: Date.parse(data.expires_at) || Date.now() + 50 * 60 * 1000,
  };
  return githubInstallationTokenCache.value;
}

function githubThemePath(path = "") {
  return "/repos/" + GITHUB_THEME_OWNER + "/" + GITHUB_THEME_REPOSITORY + path;
}

async function githubRequest(path, options = {}) {
  const token = await githubThemeReleaseToken();
  if (!token) {
    const error = new Error("La publicación del tema todavía no está conectada con GitHub.");
    error.status = 503;
    throw error;
  }
  const response = await fetch("https://api.github.com" + path, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw.slice(0, 300) };
    }
  }
  if (!response.ok) {
    const error = new Error(data?.message || "GitHub devolvió un error (" + response.status + ").");
    error.status = response.status;
    error.github = data;
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const rateLimitReset = Number(response.headers.get("x-ratelimit-reset"));
    const rateLimitRemaining = Number(response.headers.get("x-ratelimit-remaining"));
    const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? Math.ceil(retryAfterHeader)
      : (response.status === 429 || rateLimitRemaining === 0) &&
          Number.isFinite(rateLimitReset) &&
          rateLimitReset > 0
        ? Math.max(1, Math.ceil(rateLimitReset - Date.now() / 1000))
        : 0;
    if (retryAfterSeconds > 0) {
      error.retryAfterSeconds = retryAfterSeconds;
      if (response.status === 403) error.status = 429;
    }
    throw error;
  }
  return data;
}

function themeReleaseUsers() {
  const ids = String(process.env.SHOPIFY_THEME_RELEASE_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value));
  let names = {};
  try {
    const parsed = JSON.parse(process.env.SHOPIFY_THEME_RELEASE_USERS_JSON || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) names = parsed;
  } catch {}
  return { ids: new Set(ids), names };
}

function assertThemeReleaseAdmin(req) {
  // This mutation deliberately rejects the legacy cookie session: a fresh Shopify-signed
  // session token identifies the individual staff account that is pressing the button.
  const session = shopifySessionTokenFrom(req);
  if (!session) {
    const error = new Error("Abre esta función desde Shopify Admin para verificar tu usuario.");
    error.status = 401;
    throw error;
  }
  if (session.shop !== DEFAULT_SHOP) {
    const error = new Error("Esta acción solo está autorizada para la tienda Trendsplant.");
    error.status = 403;
    throw error;
  }
  const allowedUsers = themeReleaseUsers();
  if (!allowedUsers.ids.size) {
    const error = new Error("Aún no se ha configurado la lista de usuarios que pueden publicar el tema.");
    error.status = 503;
    throw error;
  }
  if (!allowedUsers.ids.has(session.userId)) {
    const error = new Error("Tu usuario de Shopify no tiene permiso para publicar el tema.");
    error.status = 403;
    throw error;
  }
  const origin = String(req.headers.origin || "");
  let expectedOrigin = "";
  try {
    expectedOrigin = process.env.SHOPIFY_APP_URL
      ? new URL(process.env.SHOPIFY_APP_URL).origin
      : "";
  } catch {}
  if (!expectedOrigin && process.env.VERCEL) {
    const error = new Error("SHOPIFY_APP_URL no está configurada para validar el origen.");
    error.status = 503;
    throw error;
  }
  if (
    expectedOrigin &&
    ((req.method !== "GET" && origin !== expectedOrigin) || (origin && origin !== expectedOrigin))
  ) {
    const error = new Error("Origen de la solicitud no autorizado.");
    error.status = 403;
    throw error;
  }
  return {
    ...session,
    actor: String(allowedUsers.names[session.userId] || "Shopify user " + session.userId).slice(0, 160),
  };
}

function themeReleasePullQuery() {
  const params = new URLSearchParams({
    state: "open",
    base: GITHUB_THEME_TARGET_BRANCH,
    head: GITHUB_THEME_OWNER + ":" + GITHUB_THEME_SOURCE_BRANCH,
    per_page: "1",
  });
  return githubThemePath("/pulls?" + params.toString());
}

async function themeReleaseStatus(shop = DEFAULT_SHOP) {
  // Resolve both refs first so the comparison and the eventual merge operate on one immutable
  // snapshot. Comparing branch names here would leave a race window if either branch moved.
  const [previewRef, mainRef] = await Promise.all([
    githubRequest(githubThemePath("/git/ref/heads/" + GITHUB_THEME_SOURCE_BRANCH)),
    githubRequest(githubThemePath("/git/ref/heads/" + GITHUB_THEME_TARGET_BRANCH)),
  ]);
  const previewSha = String(previewRef?.object?.sha || "");
  const mainSha = String(mainRef?.object?.sha || "");
  if (!/^[0-9a-f]{40}$/i.test(previewSha) || !/^[0-9a-f]{40}$/i.test(mainSha)) {
    const error = new Error("GitHub no devolvió referencias de rama válidas.");
    error.status = 502;
    throw error;
  }
  const [comparison, pulls, operation] = await Promise.all([
    githubRequest(
      githubThemePath(
        "/compare/" + encodeURIComponent(mainSha) + "..." + encodeURIComponent(previewSha),
      ),
    ),
    githubRequest(themeReleasePullQuery()),
    readThemeReleaseGate(shop).catch(() => null),
  ]);
  const pull = Array.isArray(pulls) ? pulls[0] : null;
  return {
    configured: true,
    repository: GITHUB_THEME_OWNER + "/" + GITHUB_THEME_REPOSITORY,
    sourceBranch: GITHUB_THEME_SOURCE_BRANCH,
    targetBranch: GITHUB_THEME_TARGET_BRANCH,
    status: comparison.status,
    aheadBy: Number(comparison.ahead_by || 0),
    behindBy: Number(comparison.behind_by || 0),
    canPromote: Number(comparison.ahead_by || 0) > 0,
    previewSha,
    mainSha,
    compareUrl: comparison.html_url || null,
    operation,
    pullRequest: pull
      ? { number: pull.number, url: pull.html_url, state: pull.state, title: pull.title }
      : null,
  };
}

async function getOrCreateThemeReleasePull(previewSha) {
  const existing = await githubRequest(themeReleasePullQuery());
  if (Array.isArray(existing) && existing[0]) return existing[0];
  try {
    return await githubRequest(githubThemePath("/pulls"), {
      method: "POST",
      body: {
        title: "Publish preview to main",
        head: GITHUB_THEME_SOURCE_BRANCH,
        base: GITHUB_THEME_TARGET_BRANCH,
        body:
          "Publicación iniciada desde Shopify Admin.\n\nPreview SHA: `" +
          String(previewSha || "").slice(0, 12) +
          "`",
        maintainer_can_modify: false,
      },
    });
  } catch (error) {
    if (error.status !== 422) throw error;
    const raced = await githubRequest(themeReleasePullQuery());
    if (Array.isArray(raced) && raced[0]) return raced[0];
    throw error;
  }
}

async function waitForPullMergeability(number) {
  let pull = null;
  const delays = [250, 400, 650, 1000, 1500, 2000, 2500];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    pull = await githubRequest(githubThemePath("/pulls/" + number));
    if (pull.mergeable !== null) break;
    if (attempt < delays.length) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  return pull;
}

async function reconcileThemeReleaseMerge(number, expectedPreviewSha) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const [pullState, mainRef] = await Promise.all([
        githubRequest(githubThemePath("/pulls/" + number)),
        githubRequest(githubThemePath("/git/ref/heads/" + GITHUB_THEME_TARGET_BRANCH)),
      ]);
      const mainSha = String(mainRef?.object?.sha || "");
      if (/^[0-9a-f]{40}$/i.test(mainSha)) {
        const mergeCommitSha = String(pullState?.merge_commit_sha || "");
        const candidates = [
          { type: "preview", sha: expectedPreviewSha },
          ...(pullState?.merged === true && /^[0-9a-f]{40}$/i.test(mergeCommitSha)
            ? [{ type: "pull", sha: mergeCommitSha }]
            : []),
        ];
        const relations = await Promise.all(
          candidates.map(async (candidate) => {
            if (mainSha === candidate.sha) return { ...candidate, incorporated: true };
            try {
              const ancestry = await githubRequest(
                githubThemePath(
                  "/compare/" +
                    encodeURIComponent(candidate.sha) +
                    "..." +
                    encodeURIComponent(mainSha),
                ),
              );
              const behindBy = Number(ancestry?.behind_by);
              return {
                ...candidate,
                incorporated:
                  Number.isFinite(behindBy) &&
                  behindBy === 0 &&
                  (ancestry?.status === "ahead" || ancestry?.status === "identical"),
              };
            } catch (error) {
              lastError = error;
              return { ...candidate, incorporated: false };
            }
          }),
        );
        // The exact preview SHA being an ancestor is definitive for a merge commit. A verified
        // merged PR commit covers repositories that enforce squash/rebase instead.
        const incorporated = relations.find((relation) => relation.incorporated);
        if (incorporated) {
          return {
            merged: true,
            sha: mainSha,
            pull: pullState,
            reconciled: incorporated.type === "pull" ? "pull_and_ref" : "ref",
          };
        }
      }
      if (pullState?.state === "closed" && pullState?.merged !== true) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  return { merged: false, error: lastError };
}

async function ensureThemeReleaseLockStorage() {
  if (!themeReleaseLockStoragePromise) {
    themeReleaseLockStoragePromise = database().begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(81002002)`;
      await transaction`CREATE TABLE IF NOT EXISTS trendsplant_theme_release_locks (
        shop TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    }).catch((error) => {
      themeReleaseLockStoragePromise = null;
      throw error;
    });
  }
  await themeReleaseLockStoragePromise;
}

async function acquireThemeReleaseLock(shop, owner) {
  await ensureThemeReleaseLockStorage();
  const rows = await database()`INSERT INTO trendsplant_theme_release_locks
    (shop, owner, expires_at, updated_at)
    VALUES (
      ${shop},
      ${owner},
      NOW() + (${THEME_RELEASE_LOCK_TTL_SECONDS}::integer * INTERVAL '1 second'),
      NOW()
    )
    ON CONFLICT (shop) DO UPDATE
    SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at, updated_at = NOW()
    WHERE trendsplant_theme_release_locks.expires_at <= NOW()
      AND trendsplant_theme_release_locks.updated_at <=
        NOW() - (${THEME_RELEASE_COOLDOWN_SECONDS}::integer * INTERVAL '1 second')
    RETURNING owner, expires_at, updated_at, NOW() AS observed_at`;
  if (rows[0]?.owner === owner) {
    return { acquired: true, running: true, retryAfterSeconds: THEME_RELEASE_LOCK_TTL_SECONDS };
  }
  return { acquired: false, ...(await readThemeReleaseGate(shop)) };
}

async function releaseThemeReleaseLock(shop, owner) {
  if (!owner) return;
  await ensureThemeReleaseLockStorage();
  // Keep the row as an atomic cooldown gate; a later request can replace it once the short
  // cooldown expires. The owner match prevents an expired worker from releasing a newer lock.
  await database()`UPDATE trendsplant_theme_release_locks
    SET expires_at = NOW(), updated_at = NOW()
    WHERE shop = ${shop} AND owner = ${owner}`;
}

async function readThemeReleaseGate(shop) {
  await ensureThemeReleaseLockStorage();
  const rows = await database()`SELECT expires_at, updated_at, NOW() AS observed_at
    FROM trendsplant_theme_release_locks
    WHERE shop = ${shop}
    LIMIT 1`;
  if (!rows[0]) {
    return { running: false, cooldown: false, retryAfterSeconds: 0 };
  }
  const observedAt = Date.parse(rows[0].observed_at) || Date.now();
  const expiresAt = Date.parse(rows[0].expires_at) || 0;
  const updatedAt = Date.parse(rows[0].updated_at) || 0;
  const cooldownUntil = updatedAt + THEME_RELEASE_COOLDOWN_SECONDS * 1000;
  const running = expiresAt > observedAt;
  const blockedUntil = running ? expiresAt : cooldownUntil;
  const remainingSeconds = Math.max(0, Math.ceil((blockedUntil - observedAt) / 1000));
  // Active work normally completes quickly; advise a short poll without weakening the
  // 15-minute server-side lock that protects against an abandoned worker.
  const retryAfterSeconds = running ? Math.min(15, remainingSeconds) : remainingSeconds;
  return {
    running,
    cooldown: !running && retryAfterSeconds > 0,
    retryAfterSeconds,
    startedAt: running && updatedAt ? new Date(updatedAt).toISOString() : null,
    expiresAt: running && expiresAt ? new Date(expiresAt).toISOString() : null,
  };
}

async function ensureThemeReleaseAuditStorage() {
  if (!themeReleaseAuditStoragePromise) {
    themeReleaseAuditStoragePromise = database().begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(81002003)`;
      await transaction`CREATE TABLE IF NOT EXISTS trendsplant_theme_release_audit (
        id BIGSERIAL PRIMARY KEY,
        request_id TEXT NOT NULL,
        shop TEXT NOT NULL,
        actor TEXT,
        shopify_user_id TEXT,
        event TEXT NOT NULL,
        status TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        preview_sha TEXT,
        main_sha_before TEXT,
        main_sha_after TEXT,
        pull_request_number BIGINT,
        pull_request_url TEXT,
        error TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await transaction`ALTER TABLE trendsplant_theme_release_audit ADD COLUMN IF NOT EXISTS actor TEXT`;
      await transaction`ALTER TABLE trendsplant_theme_release_audit ADD COLUMN IF NOT EXISTS shopify_user_id TEXT`;
      await transaction`CREATE INDEX IF NOT EXISTS trendsplant_theme_release_audit_shop_created_idx
        ON trendsplant_theme_release_audit (shop, created_at DESC)`;
    }).catch((error) => {
      themeReleaseAuditStoragePromise = null;
      throw error;
    });
  }
  await themeReleaseAuditStoragePromise;
}

async function appendThemeReleaseAudit(entry) {
  await ensureThemeReleaseAuditStorage();
  const details = entry.details && typeof entry.details === "object" ? entry.details : {};
  await database()`INSERT INTO trendsplant_theme_release_audit (
    request_id, shop, actor, shopify_user_id, event, status, source_branch, target_branch,
    preview_sha, main_sha_before, main_sha_after, pull_request_number,
    pull_request_url, error, details
  ) VALUES (
    ${entry.requestId},
    ${entry.shop},
    ${entry.actor || null},
    ${entry.shopifyUserId || null},
    ${entry.event},
    ${entry.status},
    ${GITHUB_THEME_SOURCE_BRANCH},
    ${GITHUB_THEME_TARGET_BRANCH},
    ${entry.previewSha || null},
    ${entry.mainShaBefore || null},
    ${entry.mainShaAfter || null},
    ${entry.pullRequestNumber || null},
    ${entry.pullRequestUrl || null},
    ${entry.error ? String(entry.error).slice(0, 2000) : null},
    ${JSON.stringify(details)}::jsonb
  )`;
}

async function themeReleaseStatusRoute(req, res) {
  try {
    // Reading the status is non-mutating, so the direct private dashboard may use its
    // encrypted shop session. Publishing remains guarded by assertThemeReleaseAdmin(),
    // which requires a fresh, staff-specific App Bridge token from Shopify Admin.
    const session = shopifySessionTokenFrom(req) || sessionFrom(req);
    if (!session || session.shop !== DEFAULT_SHOP) {
      const error = new Error("Inicia sesión para consultar la publicación del tema.");
      error.status = 401;
      throw error;
    }
    const signedSession = shopifySessionTokenFrom(req);
    if (signedSession) assertThemeReleaseAdmin(req);
    if (!githubThemeReleaseConfigured()) {
      return res.json({
        configured: false,
        repository: GITHUB_THEME_OWNER + "/" + GITHUB_THEME_REPOSITORY,
        sourceBranch: GITHUB_THEME_SOURCE_BRANCH,
        targetBranch: GITHUB_THEME_TARGET_BRANCH,
        canPromote: false,
        message: "Falta configurar la credencial segura de GitHub en Vercel.",
        authorizedUser: { id: session.userId || null, name: signedSession?.actor || "Sesión web" },
      });
    }
    res.json({
      ...(await themeReleaseStatus(session.shop)),
      authorizedUser: { id: session.userId || null, name: signedSession?.actor || "Sesión web" },
    });
  } catch (error) {
    if (error.status === 401) {
      res.setHeader("X-Shopify-Retry-Invalid-Session-Request", "1");
    }
    if (error.retryAfterSeconds) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
      error: error.message,
    });
  }
}

async function promoteThemeRelease(req, res) {
  const startedAt = new Date().toISOString();
  const requestId = crypto.randomUUID();
  let shop = DEFAULT_SHOP;
  let pull = null;
  let lockOwner = null;
  let lockAcquired = false;
  let before = null;
  let actor = null;
  let shopifyUserId = null;
  try {
    const session = assertThemeReleaseAdmin(req);
    shop = session.shop;
    actor = session.actor;
    shopifyUserId = session.userId;
    lockOwner = crypto.randomUUID();
    const gate = await acquireThemeReleaseLock(shop, lockOwner);
    if (!gate.acquired) {
      const retryAfterSeconds = Math.max(1, Number(gate.retryAfterSeconds || 1));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      await appendThemeReleaseAudit({
        requestId,
        shop,
        actor,
        shopifyUserId,
        event: gate.running ? "rejected_running" : "rejected_cooldown",
        status: "rejected",
        details: { retryAfterSeconds },
      }).catch(() => {});
      return res.status(gate.running ? 409 : 429).json({
        requestId,
        error: gate.running
          ? "Ya hay otra publicación preview → main en curso."
          : "Espera unos segundos antes de iniciar otra publicación.",
        operation: gate,
      });
    }
    lockAcquired = true;
    before = await themeReleaseStatus(shop);
    // The first audit row is required before any GitHub mutation. Subsequent rows are inserts,
    // never read-modify-write updates to the encrypted application-state blob.
    await appendThemeReleaseAudit({
      requestId,
      shop,
      actor,
      shopifyUserId,
      event: "started",
      status: "running",
      previewSha: before.previewSha,
      mainShaBefore: before.mainSha,
    });
    if (!before.canPromote) {
      await appendThemeReleaseAudit({
        requestId,
        shop,
        actor,
        shopifyUserId,
        event: "already_current",
        status: "complete",
        previewSha: before.previewSha,
        mainShaBefore: before.mainSha,
        mainShaAfter: before.mainSha,
      }).catch(() => {});
      return res.json({
        ok: true,
        requestId,
        status: "already_current",
        message: "Main ya contiene todos los cambios de preview.",
        release: before,
      });
    }

    pull = await getOrCreateThemeReleasePull(before.previewSha);
    pull = await waitForPullMergeability(pull.number);
    if (!pull || pull.mergeable === null) {
      const error = new Error("GitHub todavía está analizando si el cambio se puede fusionar.");
      error.status = 409;
      throw error;
    }
    if (pull.mergeable === false) {
      const error = new Error("Preview tiene conflictos con main. No se ha publicado ningún cambio.");
      error.status = 409;
      error.pullUrl = pull.html_url;
      throw error;
    }

    let result = null;
    let mergeError = null;
    try {
      result = await githubRequest(githubThemePath("/pulls/" + pull.number + "/merge"), {
        method: "PUT",
        body: {
          merge_method: "merge",
          sha: before.previewSha,
          commit_title: "Publish preview to main",
          commit_message: "Triggered from Shopify Admin.",
        },
      });
    } catch (error) {
      // A timeout or connection reset can hide a successful server-side merge. Reconcile the
      // immutable preview SHA against both the PR and main before reporting a failure/retrying.
      mergeError = error;
    }
    if (!result?.merged) {
      const reconciled = await reconcileThemeReleaseMerge(pull.number, before.previewSha);
      if (reconciled.merged) {
        result = {
          merged: true,
          sha: reconciled.sha,
          message: "Merge confirmado tras reconciliar el estado de GitHub.",
          reconciled: reconciled.reconciled,
        };
      } else {
        const error = mergeError || new Error(
          result?.message || "GitHub no ha podido completar la publicación.",
        );
        error.status = error.status || 409;
        error.pullUrl = pull.html_url;
        throw error;
      }
    }

    const completedAt = new Date().toISOString();
    let auditRecorded = true;
    await appendThemeReleaseAudit({
      requestId,
      shop,
      actor,
      shopifyUserId,
      event: result.reconciled ? "completed_reconciled" : "completed",
      status: "complete",
      previewSha: before.previewSha,
      mainShaBefore: before.mainSha,
      mainShaAfter: result.sha || null,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url,
      details: { startedAt, completedAt, reconciliation: result.reconciled || null },
    }).catch(() => {
      auditRecorded = false;
    });
    res.json({
      ok: true,
      requestId,
      status: "complete",
      message: "Preview se ha publicado correctamente en main.",
      commitSha: result.sha || null,
      pullRequest: { number: pull.number, url: pull.html_url },
      reconciled: Boolean(result.reconciled),
      auditRecorded,
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    await appendThemeReleaseAudit({
      requestId,
      shop,
      actor,
      shopifyUserId,
      event: "failed",
      status: "failed",
      previewSha: before?.previewSha || null,
      mainShaBefore: before?.mainSha || null,
      pullRequestNumber: pull?.number || null,
      pullRequestUrl: error.pullUrl || pull?.html_url || null,
      error: error.message,
      details: { startedAt, failedAt },
    }).catch(() => {});
    if (error.status === 401) {
      res.setHeader("X-Shopify-Retry-Invalid-Session-Request", "1");
    }
    if (error.retryAfterSeconds) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
      requestId,
      error: error.message,
      pullRequestUrl: error.pullUrl || pull?.html_url || null,
    });
  } finally {
    if (lockAcquired) await releaseThemeReleaseLock(shop, lockOwner).catch(() => {});
  }
}

app.get("/api/theme-release/status", themeReleaseStatusRoute);
app.get("/api/theme-release-status", themeReleaseStatusRoute);
app.post("/api/theme-release/promote", promoteThemeRelease);
app.post("/api/theme-release-promote", promoteThemeRelease);

function freshAnalytics() {
  return {
    impressions: 0,
    clicks: 0,
    addToCart: 0,
    purchases: 0,
    revenue: 0,
    sessions: 0,
    searches: {},
    lastEventAt: null,
    dimensions: { countries: {}, temperatures: {}, collections: {} },
    recentEvents: [],
    liveVisitors: [],
    operational: { acceptedEvents: 0, invalidEvents: 0, lastErrorAt: null },
  };
}

async function readAnalytics(shop) {
  const state = await readState(shop).catch(() => null);
  const analytics = state?.analytics || {};
  const fresh = freshAnalytics();
  const integrationHealth = analytics.integrationHealth && typeof analytics.integrationHealth === "object"
    ? analytics.integrationHealth
    : {};
  return {
    ...fresh,
    ...analytics,
    dimensions: {
      countries: analytics.dimensions?.countries || {},
      temperatures: analytics.dimensions?.temperatures || {},
      collections: analytics.dimensions?.collections || {},
    },
    operational: { ...fresh.operational, ...(analytics.operational || {}) },
    recentEvents: Array.isArray(analytics.recentEvents) ? analytics.recentEvents : [],
    liveVisitors: Array.isArray(analytics.liveVisitors) ? analytics.liveVisitors : [],
    searches: analytics.searches && typeof analytics.searches === "object" ? analytics.searches : {},
    integrationHealth: {
      storefrontCollections:
        integrationHealth.storefrontCollections && typeof integrationHealth.storefrontCollections === "object"
          ? integrationHealth.storefrontCollections
          : {},
    },
  };
}

async function writeAnalytics(shop, analytics) {
  await writeState(shop, { analytics });
  return analytics;
}

function temperatureBand(value) {
  const temperature = Number(value);
  if (temperature <= 12) return "frío ≤12°C";
  if (temperature <= 22) return "templado 13–22°C";
  if (temperature <= 29) return "cálido 23–29°C";
  return "calor ≥30°C";
}

function eventAllowed(req, shop) {
  const anonymousId = String(req.headers["x-tp-session"] || req.body?.sessionId || "anonymous").slice(0, 100);
  const key = crypto.createHash("sha256").update(shop + ":" + anonymousId).digest("hex").slice(0, 24);
  const sessionAllowed = boundedRateAllowed(eventRateBuckets, key, EVENT_RATE_LIMIT, EVENT_RATE_WINDOW_MS);
  const ipAllowed = boundedRateAllowed(
    ipEventRateBuckets,
    clientIp(req),
    IP_EVENT_RATE_LIMIT,
    EVENT_RATE_WINDOW_MS,
  );
  if (sessionAllowed && ipAllowed) return true;
  runtimeMetrics.rateLimited += 1;
  return false;
}

function addDimension(dimensions, name, key, metric, count, revenue = 0) {
  const safeKey = String(key || "unknown").slice(0, 80);
  const group = dimensions[name] || (dimensions[name] = {});
  const row = group[safeKey] || { impressions: 0, clicks: 0, addToCart: 0, purchases: 0, revenue: 0 };
  row[metric] = (row[metric] || 0) + count;
  row.revenue = Math.round(((row.revenue || 0) + revenue) * 100) / 100;
  group[safeKey] = row;
}

const LIVE_VISITOR_RETENTION_MS = 24 * 60 * 60 * 1000;
const LIVE_VISITOR_LIMIT = 250;

function visitorRankingSnapshot(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((product, index) => ({
    position: Math.max(1, Math.min(99, Number(product?.position) || index + 1)),
    id: String(product?.id || "").slice(0, 100) || null,
    handle: String(product?.handle || "").slice(0, 120) || null,
    title: String(product?.title || "Producto").slice(0, 180),
    score: Math.round(Math.max(0, Math.min(100000, Number(product?.score) || 0)) * 100) / 100,
    reasons: Array.isArray(product?.reasons)
      ? product.reasons.slice(0, 4).map((reason) => String(reason || "").slice(0, 180)).filter(Boolean)
      : [],
  }));
}

function liveVisitorsWithinRetention(visitors, now = Date.now()) {
  return (Array.isArray(visitors) ? visitors : []).filter((visitor) => {
    const at = Date.parse(visitor?.at || "");
    return Number.isFinite(at) && now - at >= 0 && now - at <= LIVE_VISITOR_RETENTION_MS;
  });
}

function safeSearchTerm(value) {
  const term = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (term.length < 2 || term.length > 80) return null;
  if (/@/.test(term) || /\d{7,}/.test(term)) return null;
  return term;
}

function recordSearchInsight(analytics, event, payload) {
  const term = safeSearchTerm(payload.searchTerm);
  if (!term) return false;
  const searches = analytics.searches || (analytics.searches = {});
  if (!searches[term] && Object.keys(searches).length >= 200) return false;
  const row = searches[term] || {
    searches: 0,
    zeroResults: 0,
    resultClicks: 0,
    products: {},
    lastAt: null,
  };
  if (event === "search") {
    row.searches += 1;
    if (Number(payload.searchResultsCount) === 0) row.zeroResults += 1;
  }
  if (event === "search_result_click") {
    row.resultClicks += 1;
    const handle = String(payload.productHandle || payload.productId || "").trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,119}$/.test(handle)) {
      const products = row.products || (row.products = {});
      const product = products[handle] || {
        handle,
        title: String(payload.productTitle || handle).slice(0, 180),
        clicks: 0,
      };
      product.clicks += 1;
      products[handle] = product;
      const retained = Object.entries(products)
        .sort((left, right) => Number(right[1]?.clicks || 0) - Number(left[1]?.clicks || 0))
        .slice(0, 30);
      row.products = Object.fromEntries(retained);
    }
  }
  row.lastAt = new Date().toISOString();
  searches[term] = row;
  return true;
}

async function recordAnalytics(shop, payload, context) {
  const analytics = await readAnalytics(shop);
  const event = payload.event;
  const metricByEvent = {
    impression: "impressions",
    impression_batch: "impressions",
    click: "clicks",
    add_to_cart: "addToCart",
    purchase: "purchases",
    session: "sessions",
  };
  const metric = metricByEvent[event];
  const count = event === "impression_batch"
    ? Math.max(1, Math.min(100, Array.isArray(payload.productIds) ? payload.productIds.length : 1))
    : 1;
  const revenue = event === "purchase" ? Math.max(0, Number(payload.revenue || 0)) : 0;
  if (metric) analytics[metric] = (analytics[metric] || 0) + count;
  analytics.revenue = Math.round(((analytics.revenue || 0) + revenue) * 100) / 100;
  analytics.lastEventAt = new Date().toISOString();
  analytics.operational.acceptedEvents = (analytics.operational.acceptedEvents || 0) + 1;

  if (event === "search" || event === "search_result_click") {
    recordSearchInsight(analytics, event, payload);
  }

  if (event === "session") {
    const handle = String(payload.collectionHandle || "").trim().toLowerCase();
    if (/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
      const integrationHealth = analytics.integrationHealth || { storefrontCollections: {} };
      const storefrontCollections = integrationHealth.storefrontCollections || {};
      const previous = storefrontCollections[handle] || {};
      storefrontCollections[handle] = {
        lastSeenAt: analytics.lastEventAt,
        sessions: Number(previous.sessions || 0) + 1,
        gridReady: Boolean(payload.gridReady),
        integrationVersion: String(payload.integrationVersion || previous.integrationVersion || "unknown").slice(0, 80),
        strategyVersion: String(payload.strategyVersion || previous.strategyVersion || "unknown").slice(0, 100),
      };
      analytics.integrationHealth = { storefrontCollections };
    }

    const visitorRef = crypto
      .createHash("sha256")
      .update(shop + ":" + String(payload.sessionId || "anonymous"))
      .digest("hex")
      .slice(0, 8)
      .toUpperCase();
    analytics.liveVisitors = [
      {
        visitorRef,
        at: analytics.lastEventAt,
        country: String(context.country || "unknown").slice(0, 12),
        temperatureBand: String(context.temperatureBand || "").slice(0, 80),
        collectionHandle: String(payload.collectionHandle || "").slice(0, 80) || null,
        ranking: visitorRankingSnapshot(payload.ranking),
        rankingMode: String(payload.rankingMode || "simulation").slice(0, 30),
        rankingApplied: payload.rankingApplied === true,
        strategyVersion: String(payload.strategyVersion || "unknown").slice(0, 100),
        integrationVersion: String(payload.integrationVersion || "unknown").slice(0, 80),
      },
      ...liveVisitorsWithinRetention(analytics.liveVisitors),
    ].slice(0, LIVE_VISITOR_LIMIT);
  }

  if (metric && metric !== "sessions") {
    addDimension(analytics.dimensions, "countries", context.country, metric, count, revenue);
    addDimension(analytics.dimensions, "temperatures", context.temperatureBand, metric, count, revenue);
    addDimension(
      analytics.dimensions,
      "collections",
      payload.collectionHandle || "sin atribución",
      metric,
      count,
      revenue,
    );
  }

  analytics.recentEvents = [
    {
      event,
      count,
      productId: String(payload.productId || "").slice(0, 100) || null,
      collectionHandle: String(payload.collectionHandle || "").slice(0, 80) || null,
      country: context.country,
      temperatureBand: context.temperatureBand,
      at: analytics.lastEventAt,
    },
    ...analytics.recentEvents,
  ].slice(0, 100);
  return writeAnalytics(shop, analytics);
}

async function analyticsEvent(req, res) {
  try {
    const shop = shopOf(req);
    const event = String(req.body?.event || "");
    if (!["impression", "impression_batch", "click", "add_to_cart", "session", "search", "search_result_click"].includes(event)) {
      return res.status(400).json({ error: "Evento no válido." });
    }
    if ((event === "search" || event === "search_result_click") && !safeSearchTerm(req.body?.searchTerm)) {
      return res.status(202).json({ ok: true, ignored: true });
    }
    if (!eventAllowed(req, shop)) return res.status(429).json({ error: "Límite de eventos alcanzado." });
    const geo = geoFromRequest(req);
    const weather = await weatherFor(geo);
    await recordAnalytics(shop, req.body || {}, {
      country: geo.country,
      temperatureBand: temperatureBand(weather.temperatureC),
    });
    res.status(202).json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.post("/api/analytics/events", analyticsEvent);
app.post("/api/analytics-events", analyticsEvent);

async function liveVisitors(req, res) {
  try {
    const analytics = await readAnalytics(shopOf(req));
    res.json({
      retentionHours: 24,
      generatedAt: new Date().toISOString(),
      visitors: liveVisitorsWithinRetention(analytics.liveVisitors),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/live-visitors", liveVisitors);

async function searchInsights(req, res) {
  try {
    const analytics = await readAnalytics(shopOf(req));
    const rows = Object.entries(analytics.searches || {})
      .map(([term, value]) => {
        const searches = Number(value?.searches || 0);
        const resultClicks = Number(value?.resultClicks || 0);
        const zeroResults = Number(value?.zeroResults || 0);
        const products = Object.values(value?.products || {})
          .sort((left, right) => Number(right?.clicks || 0) - Number(left?.clicks || 0))
          .slice(0, 5)
          .map((product) => ({
            handle: String(product?.handle || "").slice(0, 120),
            title: String(product?.title || product?.handle || "Producto").slice(0, 180),
            clicks: Number(product?.clicks || 0),
          }));
        return {
          term,
          searches,
          zeroResults,
          resultClicks,
          clickThroughRate: searches ? Math.round((resultClicks / searches) * 10000) / 100 : 0,
          lastAt: value?.lastAt || null,
          products,
        };
      })
      .filter((row) => row.searches > 0 || row.resultClicks > 0);
    const totalSearches = rows.reduce((total, row) => total + row.searches, 0);
    const totalZeroResults = rows.reduce((total, row) => total + row.zeroResults, 0);
    const totalResultClicks = rows.reduce((total, row) => total + row.resultClicks, 0);
    const bySearches = rows
      .filter((row) => row.searches > row.zeroResults)
      .sort((left, right) => right.searches - left.searches || right.resultClicks - left.resultClicks);
    const noResults = rows
      .filter((row) => row.zeroResults > 0)
      .sort((left, right) => right.zeroResults - left.zeroResults || right.searches - left.searches);
    res.json({
      generatedAt: new Date().toISOString(),
      retention: "Desde que se activó la medición",
      summary: {
        totalSearches,
        uniqueTerms: rows.length,
        totalZeroResults,
        totalResultClicks,
        resultClickRate: totalSearches ? Math.round((totalResultClicks / totalSearches) * 10000) / 100 : 0,
      },
      topSearches: bySearches.slice(0, 20),
      noResults: noResults.slice(0, 20),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/search-insights", searchInsights);

async function integrationHealth(req, res) {
  try {
    const shop = shopOf(req);
    const strategy = await loadStrategy(shop, req);
    const analytics = await readAnalytics(shop);
    const state = await readState(shop).catch(() => null);
    const targets = integrationHealthTargets(strategy, analytics);
    res.json({
      targets,
      themeScope: "all_collection_pages",
      ordersWebhook: state?.integrations?.ordersWebhook || { active: false },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/integration-health", integrationHealth);

function integrationHealthTargets(strategy, analytics, now = Date.now()) {
  return collectionHandlesFor(strategy).map((handle) => {
    const heartbeat = analytics.integrationHealth?.storefrontCollections?.[handle] || null;
    const lastSeenAt = heartbeat?.lastSeenAt || null;
    const ageMs = lastSeenAt ? Math.max(0, now - Date.parse(lastSeenAt)) : null;
    const stale = ageMs !== null && ageMs > 24 * 60 * 60 * 1000;
    const status = !strategy.enabled
      ? "disabled"
      : !heartbeat
        ? "waiting_for_visit"
        : !heartbeat.gridReady
          ? "grid_not_detected"
          : stale
            ? "stale"
            : "active";
    return {
      handle,
      status,
      mode: strategy.mode,
      lastSeenAt,
      sessions: Number(heartbeat?.sessions || 0),
      gridReady: heartbeat?.gridReady === true,
      integrationVersion: heartbeat?.integrationVersion || null,
      strategyVersion: heartbeat?.strategyVersion || null,
    };
  });
}

function largestDimension(rows, metric = "impressions") {
  return Object.entries(rows || {})
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => Number(right[metric] || 0) - Number(left[metric] || 0))[0] || null;
}

async function decisionCenter(req, res) {
  try {
    const shop = shopOf(req);
    const [strategy, analytics, state] = await Promise.all([
      loadStrategy(shop, req),
      readAnalytics(shop),
      readState(shop).catch(() => null),
    ]);
    const targets = integrationHealthTargets(strategy, analytics);
    const liveVisitors = liveVisitorsWithinRetention(analytics.liveVisitors);
    const activeTargets = targets.filter((target) => target.status === "active");
    const signalLabels = {
      temperatureFit: "Temperatura",
      countryAffinity: "País",
      recentSales: "Ventas recientes",
      newness: "Novedad",
      availability: "Disponibilidad",
    };
    const leadingSignal = Object.entries(strategy.weights || {})
      .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))[0] || null;
    const topCountry = largestDimension(analytics.dimensions?.countries);
    const topCollection = largestDimension(analytics.dimensions?.collections);
    const actions = [];
    if (strategy.mode !== "live") {
      actions.push({
        priority: "high",
        title: "La estrategia aún está en simulación",
        detail: "Los rankings se calculan pero no se aplican al storefront. Activa Live cuando estés conforme con la configuración.",
        destination: "scores",
      });
    }
    if (!targets.length) {
      actions.push({
        priority: "high",
        title: "No hay colecciones objetivo",
        detail: "Añade hasta cuatro colecciones para que la estrategia tenga un ámbito claro.",
        destination: "scores",
      });
    }
    targets.filter((target) => target.status !== "active").forEach((target) => {
      const detailByStatus = {
        disabled: "La estrategia está desactivada para esta colección.",
        waiting_for_visit: "Todavía no ha habido una visita desde que se configuró; entra en la colección para comprobarla.",
        grid_not_detected: "El storefront no detectó una parrilla de productos en la última visita.",
        stale: "La última señal del storefront tiene más de 24 horas.",
      };
      actions.push({
        priority: target.status === "grid_not_detected" ? "high" : "medium",
        title: "Revisar “" + target.handle + "”",
        detail: detailByStatus[target.status] || "La integración necesita una comprobación.",
        destination: "scores",
      });
    });
    if (!state?.integrations?.ordersWebhook?.active) {
      actions.push({
        priority: "medium",
        title: "Activa el webhook de compras",
        detail: "Sin él, la señal de ventas recientes no incorpora las compras nuevas de Shopify.",
        destination: "analytics",
      });
    }
    if (!analytics.lastEventAt) {
      actions.push({
        priority: "medium",
        title: "Aún no hay señal suficiente",
        detail: "Deja que entren visitas reales a las colecciones objetivo para validar el ranking con datos del storefront.",
        destination: "visitors",
      });
    }
    if (!actions.length) {
      actions.push({
        priority: "ready",
        title: "La estrategia está lista para observar",
        detail: "Las colecciones objetivo están activas y recibiendo señal del storefront. Revisa los visitantes para contrastar el orden entregado.",
        destination: "visitors",
      });
    }
    res.json({
      generatedAt: new Date().toISOString(),
      strategy: {
        mode: strategy.mode,
        enabled: Boolean(strategy.enabled),
        targets: collectionHandlesFor(strategy),
        leadingSignal: leadingSignal
          ? { key: leadingSignal[0], label: signalLabels[leadingSignal[0]] || leadingSignal[0], weight: Number(leadingSignal[1] || 0) }
          : null,
      },
      health: { targets, activeTargets: activeTargets.length, totalTargets: targets.length },
      activity: {
        visitors24h: liveVisitors.length,
        impressions: Number(analytics.impressions || 0),
        clicks: Number(analytics.clicks || 0),
        addToCart: Number(analytics.addToCart || 0),
        purchases: Number(analytics.purchases || 0),
        lastEventAt: analytics.lastEventAt || null,
        topCountry: topCountry ? { key: topCountry.key, impressions: Number(topCountry.impressions || 0) } : null,
        topCollection: topCollection ? { key: topCollection.key, impressions: Number(topCollection.impressions || 0) } : null,
      },
      actions: actions.slice(0, 6),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/decision-center", decisionCenter);

async function recommendations(req, res) {
  try {
    const shop = shopOf(req);
    const [strategy, analytics, state] = await Promise.all([
      loadStrategy(shop, req),
      readAnalytics(shop),
      readState(shop).catch(() => null),
    ]);
    const targets = integrationHealthTargets(strategy, analytics);
    const activeTargets = targets.filter((target) => target.status === "active");
    const impressions = Number(analytics.impressions || 0);
    const clicks = Number(analytics.clicks || 0);
    const addToCart = Number(analytics.addToCart || 0);
    const purchases = Number(analytics.purchases || 0);
    const ctr = impressions ? (clicks / impressions) * 100 : 0;
    const atcRate = clicks ? (addToCart / clicks) * 100 : 0;
    const countryRows = Object.keys(analytics.dimensions?.countries || {}).length;
    const recommendations = [];
    const add = (priority, title, detail, rationale, destination) =>
      recommendations.push({ priority, title, detail, rationale, destination });

    if (!targets.length) {
      add(
        "high",
        "Define las colecciones que quieres optimizar",
        "Añade entre una y cuatro colecciones objetivo antes de evaluar el impacto del ranking.",
        "No hay ninguna colección configurada en el ámbito de la estrategia.",
        "strategy",
      );
    }
    const inactiveTargets = targets.filter((target) => target.status !== "active");
    if (inactiveTargets.length) {
      const names = inactiveTargets.map((target) => target.handle).join(", ");
      add(
        inactiveTargets.some((target) => target.status === "grid_not_detected") ? "high" : "medium",
        "Confirma la integración de las colecciones objetivo",
        "Entra en " + names + " y verifica que la parrilla de productos se detecta correctamente.",
        inactiveTargets.length + " colección(es) aún no han enviado una señal activa del storefront.",
        "collections",
      );
    }
    if (strategy.mode !== "live") {
      add(
        "high",
        "Pasa la estrategia a Live cuando termines de probar",
        "En simulación puedes revisar el ranking, pero todavía no modifica el orden que ven los visitantes.",
        "La estrategia actual está configurada en modo " + strategy.mode + ".",
        "strategy",
      );
    }
    if (!state?.integrations?.ordersWebhook?.active) {
      add(
        "medium",
        "Conecta las compras de Shopify",
        "Activa el webhook de compras para que ingresos y ventas recientes se actualicen con cada pedido nuevo.",
        "No hay un webhook de pedidos activo en la integración.",
        "analytics",
      );
    }
    if (!analytics.lastEventAt) {
      add(
        "medium",
        "Recoge las primeras señales del storefront",
        "Abre una colección objetivo o espera tráfico real para que la app pueda contrastar la recomendación con comportamiento real.",
        "Todavía no se ha registrado ninguna impresión, clic, carrito ni sesión.",
        "visitors",
      );
    }
    if (impressions >= 100 && ctr < 1) {
      add(
        "medium",
        "Revisa la relevancia de los primeros productos",
        "El interés inicial es bajo; comprueba en Visitantes en vivo si los primeros resultados encajan con cada país y temperatura.",
        "Hay " + impressions + " impresiones y un CTR de " + Math.round(ctr * 100) / 100 + "%.",
        "visitors",
      );
    }
    if (clicks >= 25 && atcRate < 5) {
      add(
        "medium",
        "Contrasta clics con intención de compra",
        "Los productos generan visitas pero pocos carritos; revisa precio, disponibilidad y ficha de los más clicados.",
        "Hay " + clicks + " clics y una tasa de add-to-cart de " + Math.round(atcRate * 100) / 100 + "%.",
        "analytics",
      );
    }
    if (countryRows >= 2 && Number(strategy.weights?.countryAffinity || 0) === 0) {
      add(
        "medium",
        "Prueba a dar peso a País",
        "Ya recibes actividad de varios mercados; una prueba controlada con País puede adaptar el orden a la demanda local.",
        "Se han registrado señales de " + countryRows + " países y País tiene un peso del 0%.",
        "strategy",
      );
    }
    if (!strategy.exclusions?.excludeOutOfStock) {
      add(
        "medium",
        "Evita destacar productos sin stock",
        "Activa la exclusión de productos sin stock si tu prioridad es reducir fricción en la parrilla.",
        "La exclusión de productos agotados está desactivada.",
        "strategy",
      );
    }
    if (Number(strategy.weights?.recentSales || 0) >= 40 && purchases === 0) {
      add(
        "medium",
        "Valida la señal de ventas recientes antes de depender de ella",
        "Mantén este peso en prueba hasta que entren pedidos nuevos y puedas comparar su efecto con datos propios.",
        "Ventas recientes pesa " + Number(strategy.weights.recentSales || 0) + "% y aún no hay compras registradas.",
        "analytics",
      );
    }
    if (!recommendations.length) {
      add(
        "ready",
        "La estrategia tiene una base saludable",
        "Mantén la observación durante varios días antes de cambiar pesos; así tendrás una comparación más fiable.",
        activeTargets.length + " colección(es) están activas, el storefront envía señales y no hay alertas prioritarias.",
        "decisions",
      );
    }

    const priorityOrder = { high: 0, medium: 1, ready: 2 };
    recommendations.sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]);
    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        highPriority: recommendations.filter((item) => item.priority === "high").length,
        activeTargets: activeTargets.length,
        totalTargets: targets.length,
        impressions,
        signalsAvailable: [analytics.lastEventAt, state?.integrations?.ordersWebhook?.active, activeTargets.length > 0, countryRows > 0]
          .filter(Boolean).length,
      },
      recommendations: recommendations.slice(0, 7),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/recommendations", recommendations);

async function analyticsSummary(req, res) {
  try {
    const shop = shopOf(req);
    const analytics = await readAnalytics(shop);
    const state = await readState(shop).catch(() => null);
    const rate = (value) =>
      analytics.impressions ? Math.round((value / analytics.impressions) * 10000) / 100 : 0;
    const rows = (group) => Object.entries(group || {}).map(([key, value]) => ({ key, ...value }));
    const persistentErrors = analytics.operational.invalidEvents || 0;
    const alerts = [];
    if (!analytics.lastEventAt) alerts.push({ level: "info", message: "Aún no se han recibido eventos del storefront." });
    else if (Date.now() - Date.parse(analytics.lastEventAt) > 24 * 60 * 60 * 1000) {
      alerts.push({ level: "warning", message: "No hay eventos nuevos desde hace más de 24 horas." });
    }
    if (!state?.integrations?.ordersWebhook?.active) {
      alerts.push({ level: "warning", message: "El webhook de compras todavía no está activo." });
    }
    if (persistentErrors + runtimeMetrics.errors > 0) {
      alerts.push({ level: "warning", message: "Se han detectado errores operativos; revisa los logs de Vercel." });
    }
    res.json({
      ...analytics,
      ctr: rate(analytics.clicks),
      atcRate: rate(analytics.addToCart),
      purchaseRate: rate(analytics.purchases),
      breakdowns: {
        countries: rows(analytics.dimensions.countries),
        temperatures: rows(analytics.dimensions.temperatures),
        collections: rows(analytics.dimensions.collections),
      },
      observability: {
        runtimeStartedAt: runtimeMetrics.startedAt,
        requests: runtimeMetrics.requests,
        errors: runtimeMetrics.errors,
        averageLatencyMs: runtimeMetrics.requests
          ? Math.round(runtimeMetrics.latencyTotalMs / runtimeMetrics.requests)
          : 0,
        rateLimited: runtimeMetrics.rateLimited,
        cache: runtimeMetrics.cache,
        cacheEntries: {
          weather: weatherCache.size,
          sales: salesCache.size,
          ranking: rankingCache.size,
        },
        limits: { eventsPerMinute: EVENT_RATE_LIMIT, rankingTtlSeconds: RANKING_TTL_MS / 1000 },
        ordersWebhook: state?.integrations?.ordersWebhook || { active: false },
        alerts,
      },
      persistence: "postgresql",
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/analytics/summary", analyticsSummary);
app.get("/api/analytics-summary", analyticsSummary);

function validWebhookHmac(req) {
  const provided = String(req.headers["x-shopify-hmac-sha256"] || "");
  const secret = String(process.env.SHOPIFY_API_SECRET || "");
  if (!secret || !provided) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody || Buffer.from(""))
    .digest("base64");
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function ordersCreateWebhook(req, res) {
  if (!validWebhookHmac(req)) return res.status(401).json({ error: "Firma de webhook no válida." });
  const expectedShop = DEFAULT_SHOP + ".myshopify.com";
  const headerShop = String(req.headers["x-shopify-shop-domain"] || "").toLowerCase();
  const topic = String(req.headers["x-shopify-topic"] || "").toLowerCase();
  const eventId = String(req.headers["x-shopify-event-id"] || "").trim();
  if (headerShop !== expectedShop || topic !== "orders/create") {
    return res.status(403).json({ error: "Webhook fuera del ámbito autorizado." });
  }
  if (!/^[a-z0-9-]{8,200}$/i.test(eventId)) {
    return res.status(400).json({ error: "Identificador de webhook no válido." });
  }
  let claimed = false;
  try {
    claimed = await claimWebhookEvent(eventId, DEFAULT_SHOP, topic);
    if (!claimed) return res.status(200).json({ ok: true, duplicate: true });
    const shop = DEFAULT_SHOP;
    const order = req.body || {};
    const country = String(
      order.shipping_address?.country_code || order.billing_address?.country_code || "unknown",
    ).toUpperCase();
    const noteAttributes = Object.fromEntries(
      (order.note_attributes || []).map((item) => [String(item.name), String(item.value)]),
    );
    await recordAnalytics(
      shop,
      {
        event: "purchase",
        revenue: Number(order.current_total_price || order.total_price || 0),
        collectionHandle: noteAttributes._tp_collection || noteAttributes.tp_collection || "sin atribución",
      },
      { country, temperatureBand: "compra confirmada" },
    );
    res.status(200).json({ ok: true });
  } catch (error) {
    if (claimed) await releaseWebhookEvent(eventId).catch(() => {});
    res.status(500).json({ error: error.message });
  }
}

app.post("/api/webhooks/orders-create", ordersCreateWebhook);

async function ensureOrdersWebhook(shop, req) {
  const appUrl = String(process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  if (!appUrl) throw new Error("SHOPIFY_APP_URL no está configurada.");
  const callbackUrl = appUrl + "/api/webhooks/orders-create";
  const current = await gql(
    shop,
    "query Hooks{webhookSubscriptions(first:50,topics:[ORDERS_CREATE]){nodes{id uri topic}}}",
    {},
    req,
  );
  let webhook = current.webhookSubscriptions.nodes.find((item) => item.uri === callbackUrl);
  if (!webhook) {
    const created = await gql(
      shop,
      "mutation Hook($topic:WebhookSubscriptionTopic!,$subscription:WebhookSubscriptionInput!){webhookSubscriptionCreate(topic:$topic,webhookSubscription:$subscription){webhookSubscription{id uri topic}userErrors{field message}}}",
      { topic: "ORDERS_CREATE", subscription: { uri: callbackUrl } },
      req,
    );
    const errors = created.webhookSubscriptionCreate.userErrors || [];
    if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
    webhook = created.webhookSubscriptionCreate.webhookSubscription;
  }
  const integration = {
    active: true,
    id: webhook.id,
    topic: webhook.topic,
    callbackUrl: webhook.uri,
    verifiedAt: new Date().toISOString(),
  };
  const state = await readState(shop).catch(() => null);
  await writeState(shop, {
    integrations: { ...(state?.integrations || {}), ordersWebhook: integration },
  });
  return { ok: true, status: "active", webhook: integration };
}

async function webhookSetup(req, res) {
  const shop = shopOf(req);
  try {
    res.json(await ensureOrdersWebhook(shop, req));
  } catch (error) {
    const message = String(error?.message || "No se pudo activar el webhook de compras.");
    const needsReauthorization = /access|denied|scope|permission|webhook/i.test(message);
    res.status(needsReauthorization ? 403 : 502).json({
      error: message,
      reauthorize: needsReauthorization,
      reauthorizeUrl: needsReauthorization
        ? "/api/auth/shopify?shop=" + encodeURIComponent(shop + ".myshopify.com")
        : null,
    });
  }
}

app.post("/api/webhooks/setup", webhookSetup);
app.post("/api/webhook-setup", webhookSetup);

app.get("/api/storefront-ranking", async (req, res) => {
  try {
    const shop = shopOf(req);
    const strategy = await loadPublishedStrategy(shop, req);
    const handle = String(req.query?.handle || collectionHandlesFor(strategy)[0] || "men");
    const targetCollections = collectionHandlesFor(strategy);
    if (!targetCollections.includes(handle)) {
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      return res.json({
        enabled: false,
        target: false,
        mode: strategy.mode,
        strategyVersion: strategy.audit?.versionId || null,
        collection: { handle },
        products: [],
      });
    }
    const context = await buildContext(req, req.query || {}, shop);
    const cacheKey = [
      shop,
      handle,
      strategy.audit?.versionId || strategy.audit?.lastUpdated || "draft",
      context.geo.country,
      temperatureBand(context.weather.temperatureC),
    ].join(":");
    const cached = rankingCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      runtimeMetrics.cache.rankingHits += 1;
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("X-Trendsplant-Cache", "HIT");
      return res.json(cached.value);
    }
    runtimeMetrics.cache.rankingMisses += 1;
    let data;
    let source = "shopify_admin_graphql";
    try {
      data = await allCollectionProducts(shop, handle, req);
    } catch {
      data = await publicCollectionProducts(handle);
      source = data.source;
    }
    const ranked = rankProducts(data.products, context, strategy);
    const payload = {
      enabled: strategy.enabled,
      mode: strategy.mode,
      strategyVersion: strategy.audit?.versionId || null,
      collection: data.collection,
      context: {
        country: context.geo.country,
        region: context.geo.region,
        city: context.geo.city,
        temperatureC: context.weather.temperatureC,
        weatherSource: context.weather.source,
        salesSource: context.sales.source,
      },
      products: ranked.map(publicProductRanking),
      source,
      persistence: strategy.persistence,
    };
    setBoundedCache(
      rankingCache,
      cacheKey,
      { value: payload, expiresAt: Date.now() + RANKING_TTL_MS },
      RANKING_CACHE_LIMIT,
    );
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Trendsplant-Cache", "MISS");
    res.json(payload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

export default app;

export const __testing = {
  authRequired,
  eventAllowed,
  open,
  ordersCreateWebhook,
  seal,
  setBoundedCache,
  shopifySessionTokenFrom,
  validOAuthHmac,
  validWebhookHmac,
  resetRateLimits() {
    eventRateBuckets.clear();
    ipEventRateBuckets.clear();
    publicReadRateBuckets.clear();
  },
};



