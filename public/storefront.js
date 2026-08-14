(function () {
  "use strict";

  var INTEGRATION_VERSION = "scroll-safe-v3";
  var script = document.currentScript || document.querySelector('script[src*="parrillas-flame.vercel.app/storefront.js"]');
  var cfg = window.TrendsplantOrdering || {};
  var app = cfg.appUrl || (script && new URL(script.src, location.href).origin) || "https://parrillas-flame.vercel.app";
  var shop = (window.Shopify && window.Shopify.shop) || location.hostname;
  var gridSelector = cfg.gridSelector || "#AjaxinateLoop,[data-product-grid],#product-grid,.product-grid,.collection .grid";
  var grid = document.querySelector(gridSelector);
  var reorderTimer = null;
  var sessionId = "tp-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var rankingContext = { country: null, temperatureC: null };
  var rankingData = null;
  var rankingPromise = null;
  var lastAddToCartAt = 0;
  var lastImpressionKey = "";
  var gridObserver = null;
  var targetEnabled = null;

  document.body.dataset.trendsplantOrdering = grid ? "ready" : "no-grid";
  document.body.dataset.trendsplantOrderingIntegration = INTEGRATION_VERSION;
  if (document.body.dataset.trendsplantOrderingBound === "1") return;
  document.body.dataset.trendsplantOrderingBound = "1";

  var pathMatch = location.pathname.match(/\/collections\/([^/]+)/);
  var handle = cfg.collectionHandle || (pathMatch && pathMatch[1]) || "men";

  function api(path) {
    return app + path + (path.indexOf("?") === -1 ? "?" : "&") + "shop=" + encodeURIComponent(shop);
  }

  function send(event, productId) {
    if (targetEnabled !== true) return Promise.resolve();
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

  function observeGrid() {
    var current = document.querySelector(gridSelector);
    if (current === grid && gridObserver) return grid;

    if (gridObserver) gridObserver.disconnect();
    grid = current;

    document.body.dataset.trendsplantOrdering = grid ? "ready" : "no-grid";
    if (!grid) return null;

    gridObserver = new MutationObserver(function (mutations) {
      if (mutations.some(function (mutation) { return mutation.addedNodes.length > 0; })) {
        wireCards();
      }
    });
    gridObserver.observe(grid, { childList: true });
    return grid;
  }

  function fetchRanking() {
    if (rankingData) return Promise.resolve(rankingData);
    if (rankingPromise) return rankingPromise;

    var rankingUrl = api("/api/storefront-ranking") +
      "&handle=" + encodeURIComponent(handle) +
      "&_tp_rank=" + Date.now();

    rankingPromise = fetch(rankingUrl, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("Ranking API " + response.status);
        return response.json();
      })
      .then(function (data) {
        rankingData = data;
        targetEnabled = data.target === false ? false : Boolean(data.enabled);
        rankingContext.country = data.context && data.context.country;
        rankingContext.temperatureC = data.context && data.context.temperatureC;
        document.body.dataset.trendsplantRankingMode = data.mode || "simulation";
        document.body.dataset.trendsplantStrategyVersion = data.strategyVersion || "none";
        return data;
      })
      .catch(function (error) {
        document.body.dataset.trendsplantRankingMode = "unavailable";
        throw error;
      })
      .finally(function () {
        rankingPromise = null;
      });

    return rankingPromise;
  }

  function sendImpressions(cards, data) {
    var productsByHandle = new Map(data.products.map(function (product) {
      return [product.handle, product.id];
    }));
    var visibleIds = cards.map(cardHandle).map(function (productHandle) {
      return productsByHandle.get(productHandle);
    }).filter(Boolean);
    var impressionKey = visibleIds.join(",");

    if (!visibleIds.length || impressionKey === lastImpressionKey) return;
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

  function reorderBatch(startIndex, addedCount) {
    if (targetEnabled === false) return Promise.resolve();
    var currentGrid = observeGrid();
    if (!currentGrid) return Promise.resolve();

    var allCards = Array.from(currentGrid.children);
    var start = Math.max(0, Number(startIndex) || 0);
    var count = Math.max(0, Number(addedCount) || (allCards.length - start));
    var cards = allCards.slice(start, start + count);
    if (!cards.length) return Promise.resolve();

    return fetchRanking().then(function (data) {
      if (data.target === false || !data.enabled || !Array.isArray(data.products)) return;

      sendImpressions(cards, data);
      if (data.mode !== "live") return;

      var order = new Map(data.products.map(function (product, index) {
        return [product.handle, index];
      }));
      var originalPosition = new Map(cards.map(function (card, index) {
        return [card, index];
      }));

      if (gridObserver) gridObserver.disconnect();
      cards.sort(function (a, b) {
        var ah = cardHandle(a);
        var bh = cardHandle(b);
        var ai = order.has(ah) ? order.get(ah) : 999999;
        var bi = order.has(bh) ? order.get(bh) : 999999;
        return ai === bi ? originalPosition.get(a) - originalPosition.get(b) : ai - bi;
      }).forEach(function (card) {
        currentGrid.appendChild(card);
      });
      if (gridObserver) gridObserver.observe(currentGrid, { childList: true });
    }).catch(function () {});
  }

  function wireCards() {
    var currentGrid = observeGrid();
    if (!currentGrid) return;

    Array.from(currentGrid.querySelectorAll('a[href*="/products/"]')).forEach(function (link) {
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

  function scheduleInitialRanking() {
    var currentGrid = observeGrid();
    if (!currentGrid) return;

    wireCards();
    window.clearTimeout(reorderTimer);
    reorderTimer = window.setTimeout(function () {
      reorderBatch(0, currentGrid.children.length);
    }, 120);
  }

  document.addEventListener("tp:infinite-scroll:loaded", function (event) {
    var detail = event.detail || {};
    wireCards();

    window.setTimeout(function () {
      reorderBatch(detail.startIndex, detail.addedCount);
    }, 120);
  });

  ["globoFilterRenderSearchCompleted", "globoFilterRenderCollectionCompleted"].forEach(function (eventName) {
    window.addEventListener(eventName, function () {
      rankingData = null;
      observeGrid();
      scheduleInitialRanking();
    });
  });

  document.addEventListener("shopify:section:load", function () {
    observeGrid();
    scheduleInitialRanking();
  });

  observeGrid();
  fetchRanking().then(function (data) {
    if (data.target === false || !data.enabled) {
      document.body.dataset.trendsplantOrdering = "inactive";
      return;
    }
    targetEnabled = true;
    send("session");
    scheduleInitialRanking();
  }).catch(function () {});

  // Infinite scrolling and pagination belong exclusively to the Shopify theme.
  // This script only ranks a fixed batch of product cards after the theme
  // announces that it has finished appending that batch.
})();
