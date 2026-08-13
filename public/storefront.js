(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="parrillas-flame.vercel.app/storefront.js"]');
  var cfg = window.TrendsplantOrdering || {};
  var app = cfg.appUrl || (script && new URL(script.src, location.href).origin) || "https://parrillas-flame.vercel.app";
  var shop = (window.Shopify && window.Shopify.shop) || location.hostname;
  var gridSelector = cfg.gridSelector || "#AjaxinateLoop,[data-product-grid],#product-grid,.product-grid,.collection .grid";
  var nextSelector = cfg.nextSelector || "#AjaxinatePagination a,a[rel='next'],.pagination a.next";
  var grid = document.querySelector(gridSelector);
  var loading = false;
  var reorderTimer = null;

  document.body.dataset.trendsplantOrdering = grid ? "ready" : "no-grid";
  if (!grid || document.body.dataset.trendsplantOrderingBound === "1") return;
  document.body.dataset.trendsplantOrderingBound = "1";

  var pathMatch = location.pathname.match(/\/collections\/([^/]+)/);
  var handle = cfg.collectionHandle || (pathMatch && pathMatch[1]) || "men";

  function api(path) {
    return app + path + (path.indexOf("?") === -1 ? "?" : "&") + "shop=" + encodeURIComponent(shop);
  }

  function send(event, productId) {
    return fetch(api("/api/analytics-events"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shop: shop,
        event: event,
        productId: productId,
        collectionHandle: handle
      }),
      keepalive: true
    }).catch(function () {});
  }

  function cardHandle(card) {
    var node = card.querySelector("[data-product-handle]");
    if (node) return node.dataset.productHandle;
    var link = card.querySelector('a[href*="/products/"]');
    var match = link && link.href.match(/\/products\/([^/?#]+)/);
    return match && match[1];
  }

  function reorder() {
    return fetch(api("/api/storefront-ranking") + "&handle=" + encodeURIComponent(handle))
      .then(function (response) {
        if (!response.ok) throw new Error("Ranking API " + response.status);
        return response.json();
      })
      .then(function (data) {
        document.body.dataset.trendsplantRankingMode = data.mode || "simulation";
        if (!data.enabled || data.mode !== "live" || !Array.isArray(data.products)) return;

        var order = new Map(data.products.map(function (product, index) {
          return [product.handle, index];
        }));

        Array.from(grid.children)
          .sort(function (a, b) {
            var ah = cardHandle(a);
            var bh = cardHandle(b);
            var ai = order.has(ah) ? order.get(ah) : 999999;
            var bi = order.has(bh) ? order.get(bh) : 999999;
            return ai - bi;
          })
          .forEach(function (card) { grid.appendChild(card); });

        data.products.slice(0, grid.children.length).forEach(function (product) {
          send("impression", product.id);
        });
      })
      .catch(function () {
        document.body.dataset.trendsplantRankingMode = "unavailable";
      });
  }

  function wireCards() {
    Array.from(grid.querySelectorAll('a[href*="/products/"]')).forEach(function (link) {
      if (link.dataset.tpWired) return;
      link.dataset.tpWired = "1";
      link.addEventListener("click", function () {
        var match = link.href.match(/\/products\/([^/?#]+)/);
        send("click", match && match[1]);
      });
    });
  }

  function scheduleRefresh() {
    wireCards();
    clearTimeout(reorderTimer);
    reorderTimer = setTimeout(reorder, 120);
  }

  function nextPage() {
    var next = document.querySelector(nextSelector);
    if (!next || loading) return;
    loading = true;

    fetch(next.href)
      .then(function (response) { return response.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var nextGrid = doc.querySelector(gridSelector);
        if (!nextGrid) return;

        Array.from(nextGrid.children).forEach(function (card) { grid.appendChild(card); });
        var newNext = doc.querySelector(nextSelector);
        if (newNext) next.setAttribute("href", newNext.href);
        else {
          var pagination = next.closest("#AjaxinatePagination,.pagination");
          if (pagination) pagination.remove();
          else next.remove();
        }
        scheduleRefresh();
      })
      .catch(function () {})
      .finally(function () { loading = false; });
  }

  new MutationObserver(function (mutations) {
    if (mutations.some(function (mutation) { return mutation.addedNodes.length > 0; })) {
      scheduleRefresh();
    }
  }).observe(grid, { childList: true });

  scheduleRefresh();

  var nativeInfinite = document.querySelector("#AjaxinatePagination.pagination--infinite");
  if (!nativeInfinite) {
    var sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.dataset.trendsplantSentinel = "true";
    sentinel.style.height = "1px";
    grid.parentNode.appendChild(sentinel);
    new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) nextPage();
    }, { rootMargin: "700px" }).observe(sentinel);
  }
})();
