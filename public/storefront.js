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
  var sessionId = "tp-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var rankingContext = { country: null, temperatureC: null };
  var lastAddToCartAt = 0;
  var lastImpressionKey = "";
  var gridObserver = null;

  document.body.dataset.trendsplantOrdering = grid ? "ready" : "no-grid";
  if (document.body.dataset.trendsplantOrderingBound === "1") return;
  document.body.dataset.trendsplantOrderingBound = "1";

  var pathMatch = location.pathname.match(/\/collections\/([^/]+)/);
  var handle = cfg.collectionHandle || (pathMatch && pathMatch[1]) || "men";

  function api(path) {
    return app + path + (path.indexOf("?") === -1 ? "?" : "&") + "shop=" + encodeURIComponent(shop);
  }

  function send(event, productId) {
    return fetch(api("/api/analytics-events"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TP-Session": sessionId },
      body: JSON.stringify({
        shop: shop,
        event: event,
        productId: productId,
        collectionHandle: handle,
        sessionId: sessionId,
        country: rankingContext.country,
        temperatureC: rankingContext.temperatureC
      }),
      keepalive: true
    }).catch(function () {});
  }

  function sendAddToCart(productId) {
    if (Date.now() - lastAddToCartAt < 1200) return;
    lastAddToCartAt = Date.now();
    send("add_to_cart", productId);
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    return nativeFetch(input, init).then(function (response) {
      if (response.ok && /\/cart\/add(?:\.js)?(?:\?|$)/.test(String(url || ""))) {
        sendAddToCart();
      }
      return response;
    });
  };

  var nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._tpCartAdd = /\/cart\/add(?:\.js)?(?:\?|$)/.test(String(url || ""));
    if (this._tpCartAdd) {
      this.addEventListener("load", function () {
        if (this.status >= 200 && this.status < 300) sendAddToCart();
      });
    }
    return nativeXhrOpen.apply(this, arguments);
  };

  function cardHandle(card) {
    var node = card.querySelector("[data-product-handle]");
    if (node) return node.dataset.productHandle;
    var link = card.querySelector('a[href*="/products/"]');
    var match = link && link.href.match(/\/products\/([^/?#]+)/);
    return match && match[1];
  }

  function reorder() {
    if (!grid) return Promise.resolve();
    return fetch(api("/api/storefront-ranking") + "&handle=" + encodeURIComponent(handle))
      .then(function (response) {
        if (!response.ok) throw new Error("Ranking API " + response.status);
        return response.json();
      })
      .then(function (data) {
        rankingContext.country = data.context && data.context.country;
        rankingContext.temperatureC = data.context && data.context.temperatureC;
        document.body.dataset.trendsplantRankingMode = data.mode || "simulation";
        document.body.dataset.trendsplantStrategyVersion = data.strategyVersion || "none";
        if (!data.enabled || !Array.isArray(data.products)) return;

        var visibleIds = data.products.slice(0, grid.children.length).map(function (product) {
          return product.id;
        });
        var impressionKey = visibleIds.join(",");
        if (visibleIds.length && impressionKey !== lastImpressionKey) {
          lastImpressionKey = impressionKey;
          fetch(api("/api/analytics-events"), {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-TP-Session": sessionId },
            body: JSON.stringify({
              shop: shop,
              event: "impression_batch",
              productIds: visibleIds,
              collectionHandle: handle,
              sessionId: sessionId
            }),
            keepalive: true
          }).catch(function () {});
        }

        if (data.mode !== "live") return;

        var order = new Map(data.products.map(function (product, index) {
          return [product.handle, index];
        }));

        if (gridObserver) gridObserver.disconnect();
        Array.from(grid.children)
          .sort(function (a, b) {
            var ah = cardHandle(a);
            var bh = cardHandle(b);
            var ai = order.has(ah) ? order.get(ah) : 999999;
            var bi = order.has(bh) ? order.get(bh) : 999999;
            return ai - bi;
          })
          .forEach(function (card) { grid.appendChild(card); });
        if (gridObserver) gridObserver.observe(grid, { childList: true });

      })
      .catch(function () {
        document.body.dataset.trendsplantRankingMode = "unavailable";
      });
  }

  function wireCards() {
    if (!grid) return;
    Array.from(grid.querySelectorAll('a[href*="/products/"]')).forEach(function (link) {
      if (link.dataset.tpWired) return;
      link.dataset.tpWired = "1";
      link.addEventListener("click", function () {
        var match = link.href.match(/\/products\/([^/?#]+)/);
        send("click", match && match[1]);
      });
    });
  }

  document.addEventListener("submit", function (event) {
    var form = event.target && event.target.closest('form[action*="/cart/add"]');
    if (!form) return;
    var product = form.querySelector('[name="product-id"],[name="id"]');
    sendAddToCart(product && product.value);
  }, true);

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest('button,[name="add"],[data-add-to-cart]');
    if (!button) return;
    var form = button.closest('form[action*="/cart/add"]');
    var label = String(button.getAttribute("aria-label") || button.textContent || "").trim();
    if (!form && !/añadir|add(?:\s+to)?\s+cart/i.test(label)) return;
    var product = form && form.querySelector('[name="product-id"],[name="id"]');
    sendAddToCart(product && product.value);
  }, true);

  function scheduleRefresh() {
    if (!grid) return;
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

  if (grid) {
    // Ajaxinate owns the infinite-scroll lifecycle. Reordering while it is
    // appending a page can leave its loader waiting, so only wire analytics
    // for subsequently added cards; the initial block is ranked on load.
    gridObserver = new MutationObserver(function (mutations) {
      if (mutations.some(function (mutation) { return mutation.addedNodes.length > 0; })) {
        wireCards();
      }
    });
    gridObserver.observe(grid, { childList: true });
  }

  send("session");
  scheduleRefresh();

  // Pagination and infinite scrolling are entirely owned by the theme's
  // Ajaxinate instance. This app only reads and ranks the products already
  // present in the grid.
})();
