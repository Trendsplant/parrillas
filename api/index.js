Exit code: 0
Wall time: 1.3 seconds
Output:
import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "200kb" }));

let strategy = {
  enabled: true,
  mode: "simulation",
  collectionHandle: "men",
  collectionTitle: "Men",
  fallback: "original",
  weights: { temperatureFit: 30, countryAffinity: 20, recentSales: 20, newness: 15, availability: 15 },
  exclusions: { excludeOutOfStock: true, preserveManualProducts: true, maxPrice: null, excludedTags: [] },
  schedule: { enabled: false, frequency: "daily", timezone: "Europe/Madrid" },
  audit: { lastUpdated: null, lastApplied: null, lastAppliedBy: null }
};

function normalizeWeights(weights = {}) {
  const keys = ["temperatureFit", "countryAffinity", "recentSales", "newness", "availability"];
  const values = Object.fromEntries(keys.map((key) => [key, Math.max(0, Number(weights[key] || 0))]));
  const total = Object.values(values).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(keys.map((key) => [key, Math.round((values[key] / total) * 100)]));
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "trendsplant-ordering-app" }));
app.get("/api/strategy", (_req, res) => res.json(strategy));
app.put("/api/strategy", (req, res) => {
  strategy = { ...strategy, ...(req.body || {}), weights: normalizeWeights(req.body?.weights || strategy.weights), audit: { ...strategy.audit, lastUpdated: new Date().toISOString() } };
  res.json(strategy);
});
app.post("/api/strategy/simulate", (req, res) => {
  const context = { country: req.body?.country || "ES", temperatureC: Number(req.body?.temperatureC ?? 22), collectionHandle: strategy.collectionHandle };
  const sample = [
    { id: "sample-1", title: "Essential T-Shirt", type: "light", baseScore: 78 },
    { id: "sample-2", title: "Hooded Oversized Sweatshirt", type: "warm", baseScore: 72 },
    { id: "sample-3", title: "Easy Denim Pants", type: "mid", baseScore: 75 },
    { id: "sample-4", title: "Timber Corduroy Cap", type: "accessory", baseScore: 68 }
  ];
  const ranked = sample.map((product) => ({ ...product, score: Math.min(100, product.baseScore + Math.round(((context.temperatureC >= 25 && product.type === "light") || (context.temperatureC <= 14 && product.type === "warm") ? 22 : product.type === "mid" ? 8 : 0) * (strategy.weights.temperatureFit / 100))) })).sort((a, b) => b.score - a.score);
  res.json({ context, ranked, strategyVersion: strategy.audit.lastUpdated });
});
app.post("/api/strategy/apply", (_req, res) => {
  if (strategy.mode !== "live") return res.status(409).json({ error: "La estrategia estÃ¡ en modo simulaciÃ³n. Cambia a live antes de aplicar." });
  strategy = { ...strategy, audit: { ...strategy.audit, lastApplied: new Date().toISOString(), lastAppliedBy: "admin" } };
  res.json({ ok: true, message: "AplicaciÃ³n preparada para el conector Shopify.", strategy });
});
app.get("/auth/shopify", (req, res) => {
  const shop = String(req.query.shop || "").replace(/\.myshopify\.com$/, "");
  if (!shop || !process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_APP_URL) return res.status(400).send("Faltan shop, SHOPIFY_API_KEY o SHOPIFY_APP_URL.");
  const state = crypto.randomBytes(16).toString("hex");
  const scopes = encodeURIComponent(process.env.SHOPIFY_SCOPES || "read_products,write_products,read_inventory");
  const redirect = encodeURIComponent(`${process.env.SHOPIFY_APP_URL}/auth/callback`);
  res.redirect(`https://${shop}.myshopify.com/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirect}&state=${state}`);
});
app.get("/auth/callback", (_req, res) => res.status(501).send("OAuth callback pendiente."));

export default app;

