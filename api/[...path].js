import express from "express";
import crypto from "node:crypto";
import { get, put } from "@vercel/blob";

const app = express();
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
const EVENT_RATE_LIMIT = 120;
const EVENT_RATE_WINDOW_MS = 60 * 1000;
const MAX_STRATEGY_VERSIONS = 30;

const DEFAULT_STRATEGY = {
  enabled: true,
  mode: "simulation",
  collectionHandle: "men",
  fallback: "original",
  weights: {
    temperatureFit: 30,
    countryAffinity: 20,
    recentSales: 20,
    newness: 15,
    availability: 15,
  },
  exclusions: { excludeOutOfStock: true, preserveManualProducts: true },
  audit: { revision: 0, versionId: null, lastUpdated: null, lastApplied: null, lastAppliedBy: null },
};

let memoryStrategy = structuredClone(DEFAULT_STRATEGY);
const tokenCache = new Map();
const weatherCache = new Map();
const salesCache = new Map();
const rankingCache = new Map();
const eventRateBuckets = new Map();
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
  res.on("finish", () => {
    runtimeMetrics.latencyTotalMs += Date.now() - started;
    if (res.statusCode >= 500) runtimeMetrics.errors += 1;
  });
  next();
});

function b64(buffer) {
  return buffer.toString("base64url");
}

function secretKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.SHOPIFY_API_SECRET || "development-only-key")
    .digest();
}

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return b64(Buffer.concat([iv, payload]));
}

function open(value) {
  try {
    const payload = Buffer.from(value, "base64url");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(-16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]).toString(),
    );
  } catch {
    return null;
  }
}

function statePath(shop) {
  const id = crypto.createHash("sha256").update(shop).digest("hex").slice(0, 24);
  return "shops/" + id + "/state.enc";
}

async function streamToText(stream) {
  if (!stream) return "";
  return new Response(stream).text();
}

async function readState(shop) {
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const result = await get(statePath(shop), { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return open(await streamToText(result.stream));
  } catch (error) {
    if (/not found|404/i.test(String(error?.message || error))) return null;
    throw error;
  }
}

async function writeState(shop, patch) {
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("El almacenamiento persistente no está conectado.");
  }
  const current = (await readState(shop)) || { version: STATE_VERSION, shop };
  const next = {
    ...current,
    ...patch,
    version: STATE_VERSION,
    shop,
    updatedAt: new Date().toISOString(),
  };
  await put(statePath(shop), seal(next), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "applicatio
n/octet-stream",
    cacheControlMaxAge: 60,
  });
  return next;
}

function cookie(res, name, value, maxAge = 600) {
  res.setHeader(
    "Set-Cookie",
    name + "=" + value + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Lax",
  );
}

function sessionFrom(req) {
  const raw = String(req?.headers?.cookie || "").match(/(?:^|; )tp_session=([^;]+)/)?.[1];
  return open(raw || "");
}

function shopOf(req) {
  const raw = String(req.query?.shop || req.body?.shop || DEFAULT_SHOP);
  return raw.endsWith(".myshopify.com")
    ? raw.replace(/\.myshopify\.com$/, "")
    : DEFAULT_SHOP;
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

app.use((req, res, next) => {
  if (["/api/storefront-ranking", "/api/analytics-events", "/api/visitor-context"].includes(req.path)) {
    const origin = String(req.headers.origin || "");
    if (/https:\/\/([a-z0-9-]+\.)?trendsplant\.com$/i.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Vary", "Origin, X-Vercel-IP-Country, X-Vercel-IP-Country-Region");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TP-Session");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

function authRequired(req, res, next) {
  const publicPaths = [
    "/api/health",
    "/api/session",
    "/auth/shopify",
    "/auth/callback",
    "/api/storefront-ranking",
    "/api/analytics-events",
    "/api/visitor-context",
    "/api/webhooks/orders-create",
  ];
  if (publicPaths.includes(req.path) || sessionFrom(req)) return next();
  return res.status(401).json({
    error: "Autenticación requerida.",
    loginUrl: "/api/auth/shopify?shop=" + DEFAULT_SHOP + ".myshopify.com",
  });
}

app.use(authRequired);

async function acquireClientCredentialsToken(shop) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.SHOPIFY_API_KEY || "",
    client_secret: process.env.SHOPIFY_API_SECRET || "",
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
    throw new Error("No se pudo autenticar con Shopify (" + response.status + ").");
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
    tokenCache
.set(shop, {
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

async function loadStrategy(shop, req) {
  const state = await readState(shop).catch(() => null);
  if (state?.strategy) {
    memoryStrategy = {
      ...structuredClone(DEFAULT_STRATEGY),
      ...state.strategy,
      weights: normalizeWeights(state.strategy.weights),
    };
    return {
      ...memoryStrategy,
      versionCount: state.strategyVersions?.length || 0,
      persistence: "vercel_private_blob",
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
        ...parsed,
        weights: normalizeWeights(parsed.weights),
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
      ...state.publishedStrategy,
      weights: normalizeWeights(state.publishedStrategy.weights),
      persistence: "vercel_private_blob",
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
    ...strategySnapshot(next),
    weights: normalizeWeights(next.weights),
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
  memoryStr
ategy = strategy;
  await writeState(shop, {
    strategy,
    strategyVersions: versions,
    ...(options.publish ? { publishedStrategy: strategy } : {}),
  });
  rankingCache.clear();

  let mirror = "vercel_private_blob";
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
    mirror = "vercel_private_blob+shopify_app_metafield";
  } catch {}

  return { ...strategy, versionCount: versions.length, persistence: mirror };
}

async function collectionProducts(shop, handle, req, after = null) {
  const data = await gql(
    shop,
    "query GetCollection($handle:String!,$after:String){collectionByHandle(handle:$handle){id title handle products(first:100,after:$after){nodes{id title handle tags productType createdAt publishedAt totalInventory featuredImage{url altText}priceRangeV2{minVariantPrice{amount currencyCode}}}pageInfo{hasNextPage endCursor}}}}",
    { handle, after },
    req,
  );
  const collection = data.collectionByHandle;
  if (!collection) throw new Error("Colección no encontrada: " + handle);
  return {
    collection: { id: collection.id, title: collection.title, handle: collection.handle },
    products: collection.products.nodes.map((product) => ({
      ...product,
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
          minVariantPrice: { amount: String(variants[0]?.price || 0), currencyC
ode: "EUR" },
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
  const country = String(overrides.country || req.headers["x-vercel-ip-country"] || "ES").toUpperCase();
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
    weatherCache.set(key, { value, expiresAt: Date.now() + WEATHER_TTL_MS });
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
  let after = null;
  let guard = 0;
  try {
    do {
      const data = await gql(
        shop,
        "query RecentSales($after:String,$query:String!){orders(first:100,after:$after,query:$query,sortKey:CREATED_AT,reverse:true){nodes{lineItems(first:100){nodes{quantity product{id}}}}pageInfo{hasNextPage endCursor}}}",
        { after, query: "created_at:>=" + since },
        req,
      );
      for (const order of data.orders.nodes) {
        for (const item of order.lineItems.nodes) {
          if (item.product?.id) totals[item.product
.id] = (totals[item.product.id] || 0) + item.quantity;
        }
      }
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      guard += 1;
    } while (after && guard < 5);
    const value = { totals, source: "shopify_orders_30d", measuredAt: new Date().toISOString() };
    salesCache.set(shop, { value, expiresAt: Date.now() + SALES_TTL_MS });
    return value;
  } catch (error) {
    return {
      totals: {},
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

function countryScore(product, country) {
  const tags = (product.tags || []).join(" ").toUpperCase();
  if (new RegExp("(^|[^A-Z])" + country + "([^A-Z]|$)").test(tags)) return 100;
  if (country === "ES" && /SPAIN|ESPAÑA|LOCAL|ALICANTE/.test(tags)) return 95;
  if (/GLOBAL|WORLDWIDE|EUROPE|EU/.test(tags)) return 75;
  return 58;
}

function rankProducts(products, context, strategy) {
  const weights = strategy.weights;
  const salesTotals = context.sales?.totals || {};
  const maxSales = Math.max(0, ...Object.values(salesTotals));
  const temperature = Number(context.weather?.temperatureC ?? context.temperatureC ?? 22);

  return products
    .filter((product) => !strategy.exclusions.excludeOutOfStock || product.availableForSale)
    .map((product) => {
      const type = classify(product);
      const thermal = temperatureScore(type, temperature);
      const affinity = countryScore(product, context.geo?.country || context.country || "ES");
      const availability = product.availableForSale ? 100 : 0;
      const newness = newnessScore(product);
      const salesUnits = Number(salesTotals[product.id] || 0);
      const recentSales = maxSales
        ? Math.round(40 + (60 * Math.log1p(salesUnits)) / Math.log1p(maxSales))
        : 50;
      const score = Math.round(
        (thermal * weights.temperatureFit +
          affinity * weights.countryAffinity +
          recentSales * weights.recentSales +
          newness * weights.newness +
          availability * weights.availability) /
          100,
      );
      const reasons = [
        thermal >= 85 ? "Temperatura real favorable" : "Compatibilidad térmica media",
        affinity >= 85 ? "Afinidad geográfica" : "Distribución global",
        salesUnits > 0 ? salesUnits + " uds. vendidas en 30 días" : "Sin ventas recientes registradas",
        newness >= 85 ? "Novedad" : "Producto consolidado",
        availability ? "Disponible" : "Sin stock",
      ];
      return {
        ...product,
        type,
        score,
        signals: { thermal, affinity, recentSales, newness, availability, salesUn
its },
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || (b.signals.salesUnits || 0) - (a.signals.salesUnits || 0));
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
    reasons: [product.reasons[0], product.reasons[1], salesBand, product.reasons[3], product.reasons[4]],
    signals: {
      thermal: product.signals.thermal,
      affinity: product.signals.affinity,
      recentSales: product.signals.recentSales,
      newness: product.signals.newness,
      availability: product.signals.availability,
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

app.get("/api/health", async (_req, res) => {
  let persistence = "unavailable";
  if (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN) persistence = "vercel_private_blob";
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
      connected: Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN),
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
    res.json({ ok: true, persistence: "vercel_private_blob" });
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
    const versions 
= (state?.strategyVersions || []).map(({ strategy, ...version }) => ({
      ...version,
      collectionHandle: strategy?.collectionHandle,
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
      mode: "live",
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
    const handle = strategy.collectionHandle || "men";
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
      message: "Estrategia live versionada y disponible para el storefront.",
      strategy: saved,
      webhook,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.post("/api/strategy/apply", applyStrategy);
app.post("/api/strategy-apply", app
lyStrategy);

app.get("/auth/shopify", (req, res) => {
  const shop = shopOf(req);
  const state = crypto.randomBytes(16).toString("hex");
  const scopes = encodeURIComponent(
    process.env.SHOPIFY_SCOPES || "read_products,write_products,read_inventory,read_orders",
  );
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

app.get("/auth/callback", async (req, res) => {
  const saved = open(
    String((req.headers.cookie || "").match(/(?:^|; )tp_oauth_state=([^;]+)/)?.[1] || ""),
  );
  const shop = shopOf(req);
  if (!saved || saved.state !== req.query.state || saved.shop !== shop) {
    return res.status(400).send("Estado OAuth inválido.");
  }
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
  res.json(session ? { authenticated: true, shop: session.shop } : { authenticated: false });
});

function freshAnalytics() {
  return {
    impressions: 0,
    clicks: 0,
    addToCart: 0,
    purchases: 0,
    revenue: 0,
    sessions: 0,
    lastEventAt: null,
    dimensions: { countries: {}, temperatures: {}, collections: {} },
    recentEvents: [],
    operational: { acceptedEvents: 0, invalidEvents: 0, lastErrorAt: null },
  };
}

async function readAnalytics(shop) {
  const state = await readState(shop).catch(() => null);
  const analytics = state?.analytics || {};
  const fresh = freshAnalytics();
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
  const now = Date.no
w();
  const bucket = eventRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= EVENT_RATE_WINDOW_MS) {
    eventRateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  if (bucket.count <= EVENT_RATE_LIMIT) return true;
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
  analytics[metric] = (analytics[metric] || 0) + count;
  analytics.revenue = Math.round(((analytics.revenue || 0) + revenue) * 100) / 100;
  analytics.lastEventAt = new Date().toISOString();
  analytics.operational.acceptedEvents = (analytics.operational.acceptedEvents || 0) + 1;

  if (metric !== "sessions") {
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
    if (!["impression", "impression_batch", "click", "add_to_cart", "session"].includes(event)) {
      return res.status(400).json({ error: "Evento no válido." });
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
    else if (D
ate.now() - Date.parse(analytics.lastEventAt) > 24 * 60 * 60 * 1000) {
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
      persistence: "vercel_private_blob",
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/analytics/summary", analyticsSummary);
app.get("/api/analytics-summary", analyticsSummary);

function validWebhookHmac(req) {
  const provided = String(req.headers["x-shopify-hmac-sha256"] || "");
  const expected = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
    .update(req.rawBody || Buffer.from(""))
    .digest("base64");
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function ordersCreateWebhook(req, res) {
  if (!validWebhookHmac(req)) return res.status(401).json({ error: "Firma de webhook no válida." });
  try {
    const headerShop = String(req.headers["x-shopify-shop-domain"] || "");
    const shop = headerShop.replace(/\.myshopify\.com$/i, "") || DEFAULT_SHOP;
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
    res.status(500).json({ error: error.message });
  }
}

app.post("/api/webhooks/orders-create", ordersCreateWebhook);

async function ensureOrdersWebhook(shop, req) {
  const callbackUrl = (process.env.SHOPIFY_APP_URL || "https://parrillas-flame.vercel.app") +
    "/api/webhooks/orders-create";
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
      "mutation Hook($topic:WebhookSubscriptionTopic!,$subscription:WebhookSubscript
ionInput!){webhookSubscriptionCreate(topic:$topic,webhookSubscription:$subscription){webhookSubscription{id uri topic}userErrors{field message}}}",
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
  try {
    res.json(await ensureOrdersWebhook(shopOf(req), req));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}

app.post("/api/webhooks/setup", webhookSetup);
app.post("/api/webhook-setup", webhookSetup);

app.get("/api/storefront-ranking", async (req, res) => {
  try {
    const shop = shopOf(req);
    const strategy = await loadPublishedStrategy(shop, req);
    const handle = String(req.query?.handle || strategy.collectionHandle || "men");
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
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
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
    rankingCache.set(cacheKey, { value: payload, expiresAt: Date.now() + RANKING_TTL_MS });
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    res.setHeader("X-Trendsplant-Cache", "MISS");
    res.json(payload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

export default app;


