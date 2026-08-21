import { DEFAULT_SHOP, open, seal, validOAuthHmac } from "../_security.js";

export default async function handler(req, res) {
  const raw = String(req.headers.cookie || "").match(/(?:^|; )tp_oauth_state=([^;]+)/)?.[1];
  const saved = open(raw || "");
  const shop = String(req.query?.shop || "").toLowerCase().replace(/\.myshopify\.com$/, "");
  if (
    shop !== DEFAULT_SHOP ||
    !validOAuthHmac(req.query || {}) ||
    !saved ||
    saved.state !== req.query?.state ||
    saved.shop !== shop
  ) {
    return res.status(400).send("Estado OAuth inválido.");
  }
  if (req.query?.error) return res.status(400).send("Autorización cancelada.");
  try {
    const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: req.query?.code,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      return res.status(502).send("No se pudo completar el inicio de sesión.");
    }
    res.setHeader("Set-Cookie", [
      `tp_session=${seal({ shop, accessToken: data.access_token, createdAt: Date.now() })}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
      "tp_oauth_state=deleted; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
    res.redirect("/?login=success");
  } catch {
    res.status(500).send("Error al completar el inicio de sesión.");
  }
}
