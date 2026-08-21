import crypto from "node:crypto";
import { DEFAULT_SHOP, seal } from "../_security.js";

export default function handler(req, res) {
  const shop = String(req.query?.shop || "").toLowerCase().replace(/\.myshopify\.com$/, "");
  if (
    shop !== DEFAULT_SHOP ||
    !process.env.SHOPIFY_API_KEY ||
    !process.env.SHOPIFY_API_SECRET ||
    !process.env.SHOPIFY_APP_URL ||
    !process.env.SESSION_SECRET
  ) {
    return res.status(400).send("Tienda o configuración OAuth no válida.");
  }
  const state = crypto.randomBytes(16).toString("hex");
  const scopes = encodeURIComponent(
    process.env.SHOPIFY_SCOPES || "read_products,write_products,read_inventory",
  );
  const redirect = encodeURIComponent(process.env.SHOPIFY_APP_URL + "/api/auth/callback");
  res.setHeader(
    "Set-Cookie",
    `tp_oauth_state=${seal({ state, shop })}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  );
  res.redirect(
    `https://${shop}.myshopify.com/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}` +
      `&scope=${scopes}&redirect_uri=${redirect}&state=${state}`,
  );
}
