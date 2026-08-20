(function () {
  "use strict";

  var API = "https://parrillas.51-255-34-128.sslip.io/api/discounts/summer-day/storefront";
  var POLL_MS = 30000;
  var campaign = null;
  var timer = null;
  var productCache = {};

  function productHandleFromPath() {
    var match = location.pathname.match(/\/products\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function money(cents) {
    var currency = (window.Shopify && Shopify.currency && Shopify.currency.active) || "EUR";
    var locale = (window.Shopify && Shopify.locale) || document.documentElement.lang || "es-ES";
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: currency }).format(Number(cents || 0) / 100);
    } catch (_) {
      return (Number(cents || 0) / 100).toFixed(2) + " " + currency;
    }
  }

  function activeCampaign(payload) {
    var now = Date.now();
    return (payload.campaigns || []).find(function (item) {
      return item.active === true && now >= Date.parse(item.startsAt) && now < Date.parse(item.endsAt);
    }) || null;
  }

  function injectStyles() {
    if (document.getElementById("gestplant-summer-style")) return;
    var style = document.createElement("style");
    style.id = "gestplant-summer-style";
    style.textContent = ".gestplant-summer{margin:12px 0;padding:13px 14px;border:1px solid #d8e6de;border-left:4px solid #134838;border-radius:4px;background:#f4f8f5;color:#123b30;font-family:inherit}.gestplant-summer__label{display:block;font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.gestplant-summer__price{display:flex;align-items:baseline;gap:9px;margin-top:6px}.gestplant-summer__price strong{font-size:24px;line-height:1}.gestplant-summer__price del{font-size:13px;opacity:.65}.gestplant-summer__ends{display:block;margin-top:7px;font-size:11px;opacity:.8}.gestplant-summer-badge{position:absolute;z-index:3;top:9px;left:9px;padding:6px 8px;border-radius:3px;background:#123f32;color:#fff;font:800 10px/1.1 inherit;letter-spacing:.08em;text-transform:uppercase;pointer-events:none}.gestplant-summer-card{position:relative}.gestplant-summer-pdp-active .product__price-and-badge>.product__price,.gestplant-summer-pdp-active .product__newsletter-offer{display:none!important}.gestplant-summer[hidden],.gestplant-summer-badge[hidden]{display:none!important}";
    document.head.appendChild(style);
  }

  function chosenVariant(product) {
    var idInput = document.querySelector('form[action*="/cart/add"] [name="id"], [name="id"][data-product-variant-id]');
    var variantId = idInput && String(idInput.value || "");
    return (product.variants || []).find(function (variant) { return String(variant.id) === variantId; }) ||
      (product.variants || []).find(function (variant) { return variant.available; }) || product.variants[0];
  }

  function productAnchor() {
    return document.querySelector('[data-product-price], .product__price, .product-price, .price, form[action*="/cart/add"]');
  }

  function renderPdp(productRule, product) {
    var anchor = productAnchor();
    if (!anchor) return;
    var variant = chosenVariant(product);
    if (!variant) return;
    var current = Number(variant.price || 0);
    var compareAt = Number(variant.compare_at_price || 0);
    var original = compareAt > current ? compareAt : current;
    var summerTarget = Math.round(original * (1 - Number(productRule.discountPercent) / 100));
    var discounted = Math.min(current, summerTarget);
    var box = document.getElementById("gestplant-summer-pdp");
    if (!box) {
      box = document.createElement("div");
      box.id = "gestplant-summer-pdp";
      box.className = "gestplant-summer";
      anchor.insertAdjacentElement("afterend", box);
    }
    box.hidden = false;
    box.innerHTML = '<span class="gestplant-summer__label">ONLY TODAY · -' + productRule.discountPercent + '% FROM ORIGINAL PRICE</span><div class="gestplant-summer__price"><strong>' + money(discounted) + '</strong><del>' + money(original) + '</del></div><span class="gestplant-summer__ends" id="gestplant-summer-countdown"></span>';
    document.documentElement.classList.add("gestplant-summer-pdp-active");
    updateCountdown();
  }

  function updateCountdown() {
    var output = document.getElementById("gestplant-summer-countdown");
    if (!output || !campaign) return;
    var left = Math.max(0, Date.parse(campaign.endsAt) - Date.now());
    var hours = Math.floor(left / 3600000);
    var minutes = Math.floor((left % 3600000) / 60000);
    var seconds = Math.floor((left % 60000) / 1000);
    output.textContent = "Ends at 23:59 · " + [hours, minutes, seconds].map(function (value) { return String(value).padStart(2, "0"); }).join(":");
  }

  function renderPlp() {
    var rules = new Map((campaign.products || []).map(function (item) { return [String(item.handle), item]; }));
    document.querySelectorAll('a[href*="/products/"]').forEach(function (link) {
      var match = link.getAttribute("href").match(/\/products\/([^/?#]+)/i);
      var rule = match && rules.get(decodeURIComponent(match[1]));
      if (!rule) return;
      var card = link.closest('.product-card,.product-item,[data-product-card],li,article') || link.parentElement;
      if (!card || card.querySelector(".gestplant-summer-badge")) return;
      card.classList.add("gestplant-summer-card");
      var badge = document.createElement("span");
      badge.className = "gestplant-summer-badge";
      badge.textContent = "ONLY TODAY · -" + rule.discountPercent + "%";
      card.appendChild(badge);
    });
  }

  function clearCampaignUi() {
    document.documentElement.classList.remove("gestplant-summer-pdp-active");
    document.querySelectorAll(".gestplant-summer,.gestplant-summer-badge").forEach(function (node) { node.remove(); });
    document.querySelectorAll(".gestplant-summer-card").forEach(function (node) { node.classList.remove("gestplant-summer-card"); });
  }

  async function renderCampaign() {
    clearCampaignUi();
    if (!campaign) return;
    injectStyles();
    var handle = productHandleFromPath();
    if (!handle) {
      renderPlp();
      return;
    }
    var rule = (campaign.products || []).find(function (item) { return String(item.handle) === handle; });
    if (!rule) return;
    try {
      productCache[handle] = productCache[handle] || fetch("/products/" + encodeURIComponent(handle) + ".js", { credentials: "same-origin" }).then(function (response) {
        if (!response.ok) throw new Error("Product unavailable");
        return response.json();
      });
      renderPdp(rule, await productCache[handle]);
    } catch (_) {}
  }

  async function refresh() {
    try {
      var response = await fetch(API, { mode: "cors", credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error("Campaign unavailable");
      var payload = await response.json();
      campaign = activeCampaign(payload);
      await renderCampaign();
    } catch (_) {
      campaign = null;
      clearCampaignUi();
    }
  }

  document.addEventListener("change", function (event) {
    if (campaign && event.target && event.target.matches('[name="id"]')) window.setTimeout(renderCampaign, 0);
  });
  document.addEventListener("variant:change", function () { if (campaign) window.setTimeout(renderCampaign, 0); });
  document.addEventListener("shopify:section:load", function () { if (campaign) window.setTimeout(renderCampaign, 0); });
  new MutationObserver(function () { if (campaign && !productHandleFromPath()) renderPlp(); }).observe(document.documentElement, { childList: true, subtree: true });
  timer = window.setInterval(function () { updateCountdown(); }, 1000);
  window.setInterval(refresh, POLL_MS);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true });
  else refresh();
})();

