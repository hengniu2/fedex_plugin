(() => {
  "use strict";

  /********************************************************************
   * STARTUP
   * ******************************************************************/
  // Only run on ShipStation domains
  const hostname = window.location.hostname.toLowerCase();

  if (!hostname.includes('shipstation.com')) {
    return;
  }

  const toast = new Toast()
  startLoginMonitor({ toast });

  // Initialize service map at startup
  (async () => {
    try {
      console.log('[Content] ========== Service Map Initialization ==========');
      console.log('[Content] Checking for buildServiceMap function...');
      console.log('[Content] window.buildServiceMap type:', typeof window.buildServiceMap);
      
      if (typeof window.buildServiceMap === 'function') {
        console.log('[Content] Calling buildServiceMap...');
        const map = await window.buildServiceMap();
        console.log('[Content] ✓ Service map initialized successfully');
        console.log('[Content] Map has', Object.keys(map || {}).length, 'entries');
        console.log('[Content] ===============================================');
      } else {
        console.warn('[Content] ⚠️ buildServiceMap function not found in window');
        console.warn('[Content] Available window properties:', Object.keys(window).filter(k => k.includes('Service') || k.includes('build')));
        console.log('[Content] ===============================================');
      }
    } catch (error) {
      console.error('[Content] ❌ Failed to initialize service map:', error);
      console.error('[Content] Error stack:', error.stack);
      console.log('[Content] ===============================================');
    }
  })();

  /********************************************************************
   * CONFIG: EDIT ONLY HERE
   ********************************************************************/
  const CONFIG = {
    debugPrefix: "[UI-DIAG]",
    carrierCode: "fedex",

    selectors: {
      // --- Modals (broad) ---
      anyDialog: 'div[role="dialog"]',

      // Rate Browser modal (broad matching due to hashed classnames)
      rateBrowserModal:
        'div[role="dialog"].rate-browser-modal-ZhvaN06, div[role="dialog"][class*="rate-viewer-modal"], div[role="dialog"][class*="rate-browser-modal"]',

      // Shipment modal
      shipmentModalHintSelectors: [
        'div[role="dialog"][class*="shipment-details-modal"]',
      ],

      // Manual Order Details modal with Configure Shipment section
      manualOrderModalHintSelectors: [
        'div[class*="drawer-container"]',
        'div[class*="order-details"]',
      ],

      // Order Drawer (new modal type)
      orderDrawerHintSelectors: [
        'div[class*="order-drawer"]',
        'div[class*="drawer"][class*="order"]',
      ],

      // Export dialog footer selector
      exportFooter: '.export-records-modal-footer-QL79vX8, [class*="export-records-modal-footer"]',

      // Carrier tiles on the left are buttons with this class pattern
      carrierButtons: 'button[class*="seller-provider-list-item"]',

      // IMPORTANT: don't hardcode "selected-DijZlFi" because it's hashed.
      // We'll detect selection via class prefix:
      selectedClassPrefix: "selected-",

      // Browse Rates button
      browseRatesButton: "button.button-primary",

      // Refresh button (from your HTML)
      refreshRateButton:
        'button[aria-label="Refresh rate"], button[class*="refresh-rate-button"]',

      // Configure Shipment fields (events will be attached; NOT mutation-based)
    //   configureShipmentFieldSelectors: [
    //     "input",
    //     "select",
    //     "textarea",
    //     '[contenteditable="true"]',
    //   ].join(","),

      configureShipmentFieldSelectors: [
        "input",
        "select",
        "textarea",
        '[contenteditable="true"]',
        'button[role="combobox"]',
        'button[class*="dropdown-toggler"]'
      ].join(","),
    },

    text: {
      // Rate Browser: detect FedEx Account button by this label (your button has "FedEx Account #: 2061901…")
      fedexAccountLabelRegex: /\bFedEx\s+Account\s*#\s*:/i,

      // Exclude the "FedEx by ShipStation" provider tile if it appears
      fedexByShipStationRegex: /\bFedEx\s+by\s+ShipStation\b/i,

      browseRatesText: "Browse Rates",

      // --- Shipment classification heuristics ---
      // Shipment modal should match Shipment #
      shipmentTitleMatchers: [
        /\bShipment\s*#\d+\b/i,
      ],

      // Manual Order dialog should NOT be confused with Shipment modal
    //   manualOrderTitleMatchers: [
    //     /\bManual\s*Orders?\b/i,
    //     /\bManual\s*Order\b/i,
    //     /\bOrder\s*#\d+\b/i,
    //   ],

      manualOrderTitleMatchers: [
        /\bManual\s*Orders?\b/i,
        /\bOrder\s*#\d+\b/i,
      ],

      // Helps detect configure shipment context (optional)
      configureShipmentTitleMatchers: [
        /\bConfigure\s*Shipment\b/i,
      ],

      // Export modal detection (header text varies; footer selector is primary)
      exportTitleMatchers: [
        /\bExport\b/i,
        /\bExport\s*records?\b/i,
      ],

      // Order Drawer detection
      orderDrawerTitleMatchers: [
        /\bOrder\s*Drawer\b/i,
        /\bOrder\s*Details\b/i,
      ],
    },

    // Debounce scanning after mutations
    scanDebounceMs: 75,
  };

  /********************************************************************
   * Utils
   ********************************************************************/
  const log = (...args) => console.log(CONFIG.debugPrefix, ...args);

  function safeText(el) {
    return (el?.textContent ?? "").trim();
  }

  function elSig(el) {
    if (!el) return "null";
    const r = el.getBoundingClientRect?.();
    const dim = r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "no-rect";
    const title =
      safeText(el.querySelector("h1, h2, [class*='modal-title'], [class*='header']")) || "no-title";
    return `${title}|${dim}`;
  }

  function firstTitleText(modal) {
    return safeText(modal?.querySelector("h1, h2, [class*='modal-title'], [class*='header']"));
  }

  function getManualOrderTitle(modal) {
    if (!modal) return null;

    // Primary anchor: the drawer header area
    const header = modal.querySelector(
      '[class*="order-details-nav-bar"], [class*="order-info"]'
    );

    if (!header) return null;

    // Collect visible h4 text nodes
    const parts = Array.from(header.querySelectorAll("h4"))
      .map(el => el.textContent.trim())
      .filter(Boolean);

    if (!parts.length) return null;

    // Example result:
    // "Manual Orders: Order #100002"
    return parts.join(" ");
  }

  function anyMatcherMatches(text, matchers) {
    if (!text) return false;
    return (matchers || []).some((re) => re.test(text));
  }

  function matchesBrowseRatesButton(btn) {
    if (!btn) return false;
    if (!btn.matches(CONFIG.selectors.browseRatesButton)) return false;
    return safeText(btn) === CONFIG.text.browseRatesText;
  }

  function isSelectedCarrier(btn) {
    if (!btn) return false;
    // Detect any class like "selected-XYZ123"
    return Array.from(btn.classList).some((c) => c.startsWith(CONFIG.selectors.selectedClassPrefix));
  }

  function isShipmentModal(modal) {
    return modal.querySelector('[class*="shipment-number"]');
  }

  function isFedexAccountCarrierTile(btn) {
    if (!btn) return false;
    const t = safeText(btn);
    if (!t) return false;

    // Exclude "FedEx by ShipStation"
    if (CONFIG.text.fedexByShipStationRegex.test(t)) return false;

    // console.log("Checking FedEx Account tile text:", t, CONFIG.text.fedexAccountLabelRegex.test(t));

    // Must contain "FedEx Account #:" (your tile does)
    return CONFIG.text.fedexAccountLabelRegex.test(t);
  }

  function findFedexAccountTile(modal) {
    const carriers = Array.from(modal.querySelectorAll(CONFIG.selectors.carrierButtons));
    return carriers.find((b) => isFedexAccountCarrierTile(b)) || null;
  }

  /********************************************************************
   * State: log-once guards + re-arm gates
   ********************************************************************/
  const state = {
    // Modals (by type)
    seenRateBrowserModals: new WeakSet(),
    seenShipmentModals: new WeakSet(),
    seenManualOrderModals: new WeakSet(),
    seenOrderDrawers: new WeakSet(),
    seenExportModals: new WeakSet(),

    // Once-per-modal detection that the FedEx Account tile exists
    seenFedexAccountTileLoadedByModal: new WeakSet(),

    // Per-modal gates (key -> armed boolean)
    gateByModal: new WeakMap(), // modal -> Map<string, boolean>

    // Observers/timers
    modalObserverByModal: new WeakMap(),
    debounceTimerByModal: new WeakMap(),


    // For manual order modal field listeners (avoid double-binding)
    manualOrderFieldListenersBound: new WeakSet(),
    // prevConfigureShipmentValueSnapByModal: new WeakMap(),
    // lastFulfillmentPlanId: null
  };

  // --- Gate helpers (re-usable “allow once until re-armed”) ---
  function getModalGate(modal) {
    let gate = state.gateByModal.get(modal);
    if (!gate) {
      gate = new Map();
      state.gateByModal.set(modal, gate);
    }
    return gate;
  }

  // Fire only if armed; then disarm.
  function fireOnceWhileArmed(modal, key) {
    const gate = getModalGate(modal);
    const armed = gate.get(key) ?? true; // default armed=true
    if (!armed) return false;
    gate.set(key, false);
    return true;
  }

  // Explicitly set armed on/off (used to re-arm when unselected)
  function setArmed(modal, key, armed) {
    const gate = getModalGate(modal);
    gate.set(key, !!armed);
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  // Element helpers
  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function norm(s) {
    return (s ?? "").toString().trim().replace(/\s+/g, " ");
  }

  function getFieldKey(el) {
    // stable-ish identifier
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("name") ||
      el.getAttribute("id") ||
      el.closest("label")?.textContent?.trim() ||
      el.className ||
      el.tagName
    );
  }

  function isVisibleish(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0;
  }

  function findVisibleModals(root = document) {
    const candidates = [
      ...qsa('[role="dialog"]', root),
      ...qsa('.modal, .Modal, .ReactModal__Content', root),
      ...qsa('[data-testid*="modal"], [data-test*="modal"]', root),
    ];

    // De-dupe + visible-ish
    const uniq = Array.from(new Set(candidates));
    return uniq.filter(isVisibleish);
  }

  function stableFieldKey(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("name") ||
      el.getAttribute("id") ||
      el.getAttribute("aria-labelledby") ||
      el.closest(".field-Evt5XwF")?.querySelector("label")?.textContent?.trim() ||
      el.tagName
    );
  }
  
  function extractFieldValue(el) {
    if (el instanceof HTMLInputElement) {
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" || t === "radio") return el.checked ? "1" : "0";
      return (el.value ?? "").trim();
    }

    if (el instanceof HTMLSelectElement) {
      return (el.value ?? "").trim();
    }

    if (el instanceof HTMLTextAreaElement) {
      return (el.value ?? "").trim();
    }

    if (el.isContentEditable) {
      return (el.textContent || "").trim();
    }

    // ShipStation dropdowns (Package / Insurance / Confirmation / Service)
    const dropdownLabel =
      el.closest('[role="combobox"]')?.querySelector('[class*="single-value"]') ||
      el.closest('[class*="dropdown"]')?.querySelector('[class*="dropdown-toggler-content"]');

    if (dropdownLabel) return dropdownLabel.textContent.trim();

    return "";
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0; // 32-bit
    }
    return h.toString(16);
  }

  function fieldValueState(el) {
    // --- Native inputs ---
    if (el instanceof HTMLInputElement) {
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" || t === "radio") return el.checked ? "1" : "0";
      return (el.value ?? "").trim();
    }

    if (el instanceof HTMLSelectElement) {
      return (el.value ?? "").trim();
    }

    if (el instanceof HTMLTextAreaElement) {
      return (el.value ?? "").trim();
    }

    // --- Contenteditable ---
    if (el.isContentEditable) {
      return (el.textContent || "").trim();
    }

    // --- ShipStation dropdown buttons (Package / Confirmation / Insurance) ---
    const dropdownVal = dropdownButtonValue(el);
    if (dropdownVal != null) return dropdownVal;

    return "";
  }

  function dropdownButtonValue(el) {
    // Walk up to the dropdown root
    const root =
      el.closest?.('[role="combobox"]') ||
      el.closest?.('[class*="dropdown"]');

    if (!root) return null;

    // Common ShipStation patterns
    const label =
      root.querySelector('[class*="dropdown-toggler-content"]') ||
      root.querySelector('[class*="single-value"]');

    if (!label) return null;

    return (label.textContent || "").trim();
  }

//   function didConfigureShipmentFieldsChange(modal) {
//     const form = modal.querySelector('div[class*="configure-shipment-form"]');
//     if (!form) return false;

//     console.log('DID CONFIGURE SHIPMENT FIELDS CHANGE - form found', form);

//     const nodes = Array.from(
//       form.querySelectorAll(CONFIG.selectors.configureShipmentFieldSelectors)
//     );

//     // build current snapshot
//     const curr = Object.create(null);
//     const seen = Object.create(null);

//     for (const el of nodes) {
//       let key = stableFieldKey(el);
//       // de-dupe if repeated keys
//       if (seen[key]) key = `${key}__${++seen[key]}`;
//       else seen[key] = 1;
  
//       curr[key] = fieldValueState(el);
//     }

//     const prev = state.prevConfigureShipmentValueSnapByModal.get(modal) || null;
//     state.prevConfigureShipmentValueSnapByModal.set(modal, curr);

//     console.log("CURRENT SNAPSHOT", curr);

//     console.log("COMPARE CONFIGURE SHIPMENT FIELDS", { prev, curr });

//     if (!prev) return false; // first snapshot, no "change" yet

//     // Compare keys + values
//     const prevKeys = Object.keys(prev);
//     const currKeys = Object.keys(curr);

    
//     if (prevKeys.length !== currKeys.length) return true;

//     // If keys differ, changed (field added/removed/reordered in a way that changes identity)
//     const prevSet = new Set(prevKeys);
//     for (const k of currKeys) if (!prevSet.has(k)) return true;

//     // Values differ
//     for (const k of currKeys) {
//       if (String(prev[k]) !== String(curr[k])) return true;
//     }

//     return false;
//   }

  function snapshotConfigureShipmentForm(modal) {
    const root = modal.querySelector('div[class*="configure-shipment-form"]');
    if (!root) return null;

    const fields = Array.from(
      root.querySelectorAll(CONFIG.selectors.configureShipmentFieldSelectors)
    );

    const snapshot = fields.map(el => {
      const key =
        el.getAttribute("aria-label") ||
        el.getAttribute("name") ||
        el.getAttribute("id") ||
        el.closest("label")?.textContent?.trim() ||
        el.className ||
        el.tagName;

      return `${key}=${fieldValueState(el)}`;
    });

    // Ensure stable ordering
    snapshot.sort();

    return snapshot.join("|");
  }

  function configureShipmentSnapshotChanged(modal) {
    const snapshot = snapshotConfigureShipmentForm(modal);
    if (!snapshot) return false;

    const hash = hashString(snapshot);
    const prev = state.lastConfigureShipmentHash?.get(modal);
    if (!state.lastConfigureShipmentHash) {
        state.lastConfigureShipmentHash = new WeakMap();
    }

    if (prev !== hash) {
        state.lastConfigureShipmentHash.set(modal, hash);

        log("Configure Shipment form CHANGED", {
        sig: elSig(modal),
        hash,
        });

        return true; // ← changed
    }

    return false; // ← unchanged
  }

  /********************************************************************
   * Modal Classification (Shipment, Rate Browser, Manual Orders)
   ********************************************************************/
  function isRateBrowserModal(modal) {
    return modal.matches(CONFIG.selectors.rateBrowserModal);
  }

  function isManualOrderModal(modal) {
    // REQUIRED: order-details-drawer-OB4zhHW class must exist (indicates dialog is actually open/visible)
    // Check if modal itself has the class, or if it contains an element with that class
    const hasDrawerClass = modal.classList.contains('order-details-drawer-OB4zhHW') || 
                           modal.querySelector('.order-details-drawer-OB4zhHW') !== null ||
                           Array.from(modal.classList).some(cls => cls.includes('order-details-drawer'));
    
    if (!hasDrawerClass) {
      // Dialog is not open/visible, don't detect it
      return false;
    }

    // Dialog is visible, now verify it's a Manual Order by checking title/content
    const title = getManualOrderTitle(modal) || firstTitleText(modal) || safeText(modal);
    return anyMatcherMatches(title, CONFIG.text.manualOrderTitleMatchers);
  }

  function isShipmentModal(modal) {
    // IMPORTANT: do NOT classify as Shipment if it's clearly Manual Order or Order Drawer
    if (isManualOrderModal(modal)) return false;
    if (isOrderDrawer(modal)) return false;

    // Use title matchers (Configure Shipment / Shipment #)
    const title = firstTitleText(modal) || safeText(modal);
    if (anyMatcherMatches(title, CONFIG.text.shipmentTitleMatchers)) return true;

    // Optional hint selectors
    return CONFIG.selectors.shipmentModalHintSelectors.some((sel) => modal.matches(sel));
  }

  function isOrderDrawer(modal) {
    // Check hint selectors first
    for (const sel of CONFIG.selectors.orderDrawerHintSelectors) {
      if (modal.matches(sel)) return true;
    }

    // Use title matchers
    const title = firstTitleText(modal) || safeText(modal);
    return anyMatcherMatches(title, CONFIG.text.orderDrawerTitleMatchers);
  }

  function isExportModal(modal) {
    // Primary: footer selector exists anywhere inside modal
    if (modal.querySelector(CONFIG.selectors.exportFooter)) return true;

    // Secondary: title matchers
    const title = getManualOrderTitle(modal) || firstTitleText(modal) || safeText(modal);
    return anyMatcherMatches(title, CONFIG.text.exportTitleMatchers);
  }

  function isFedexAccountCarrierButton(btn) {
    const name = safeText(btn).toLowerCase();
    return name.includes('fedex') && name.includes('account') && !name.includes('by shipstation');
  }

//   function getRateBrowserFulfillmentId(modal) {
//     // easiest reliable reuse: if shipment modal is open behind, reuse its fulfillmentPlanId
//     const shipmentModal = document.querySelector(CONFIG.selectors.shipmentModal);
//     if (shipmentModal) return getShipmentFulfillmentIdFromModal(shipmentModal);

//     // fallback: if you already store last seen shipment fulfillmentId somewhere, use it here
//     return state.lastFulfillmentPlanId || null;
//   }

  function getRateRows(modal) {
    // NOTE: adjust selector to whatever your rate rows use once rates render
    return Array.from(modal.querySelectorAll('[data-testid="rate-row"], .rate-row, .rate-item'))
        .filter(Boolean);
  }

  function getRateRowServiceLabel(rowEl) {
    // NOTE: adjust to actual service label element in the row
    return safeText(rowEl.querySelector('.service-name, [data-testid="service-name"]')) || safeText(rowEl);
  }

  function setRateRowPrice(rowEl, amount) {
    const priceEl =
        rowEl.querySelector('.rate-price, [data-testid="rate-price"]') ||
        rowEl.querySelector('span, div');

    if (!priceEl) return;
    priceEl.textContent = `$${Number(amount).toFixed(2)}`;
  }

  /********************************************************************
   * Detectors: Rate Browser
   ********************************************************************/
  function detectRateBrowserModal(root = document) {
    const modals = root.querySelectorAll(CONFIG.selectors.rateBrowserModal);
    modals.forEach((modal) => {
      if (state.seenRateBrowserModals.has(modal)) return;
      state.seenRateBrowserModals.add(modal);

      log("Rate Browser modal detected", { sig: elSig(modal) });
      attachModalObserver(modal, scanRateBrowserModal);

      const runRateBrowserQuote = debouncedRateBrowserQuote();
      runRateBrowserQuote(modal);

      // One immediate scan
      scanRateBrowserModal(modal);
    });
  }

  function detectFedexAccountCarrierTileLoaded(modal) {
    if (state.seenFedexAccountTileLoadedByModal.has(modal)) return false;

    const tile = findFedexAccountTile(modal);
    if (!tile) return false;

    state.seenFedexAccountTileLoadedByModal.add(modal);
    log("FedEx Account carrier tile detected", {
      sig: elSig(modal),
      tileText: safeText(tile),
      selected: isSelectedCarrier(tile),
    });
    return true;
  }

  // logs on select, re-arms on unselect
  function detectFedexAccountCarrierTileSelected(modal) {
    const tile = findFedexAccountTile(modal);
    if (!tile) return false;

    const selectedNow = isSelectedCarrier(tile);

    // If unselected, re-arm so next select logs again
    if (!selectedNow) {
      setArmed(modal, "fedex_selected", true);
      return false;
    }

    // If selected, fire only once while armed
    if (fireOnceWhileArmed(modal, "fedex_selected")) {
      log("FedEx Account carrier tile is SELECTED", {
        sig: elSig(modal),
        tileText: safeText(tile),
        className: tile.className,
      });
      return true;
    }

    return false;
  }

  function scanRateBrowserModal(modal) {
    detectFedexAccountCarrierTileLoaded(modal);
    detectFedexAccountCarrierTileSelected(modal);
    // Explicitly NOT scanning rates list.
  }

  /********************************************************************
   * Detectors: Shipment Modal
   ********************************************************************/
  function detectShipmentModal(root = document) {
    const dialogs = root.querySelectorAll(CONFIG.selectors.anyDialog);
    dialogs.forEach((modal) => {
      if (!isShipmentModal(modal)) return;
      if (state.seenShipmentModals.has(modal)) return;
      state.seenShipmentModals.add(modal);

      log("Shipment modal detected", { sig: elSig(modal) });

      const runShipmentQuote = debouncedShipmentQuote();
      runShipmentQuote(modal);

      // Attach a debounced observer (not for spam; just to re-run scan when the modal is re-rendered)
      attachModalObserver(modal, scanShipmentModal);
      scanShipmentModal(modal);
    });
  }

  function scanShipmentModal(modal) {
    // For now, just confirm we can identify configure shipment context if present.
    // You can add more specific detections later.
  }

  /********************************************************************
   * Detectors: Manual Order (Order Details modal)
   ********************************************************************/
  function detectManualOrderModal(root = document) {
    const modal = root;
    if (!isManualOrderModal(modal)) return;
    if (state.seenManualOrderModals.has(modal)) return;
    state.seenManualOrderModals.add(modal);

    log("Manual Order dialog detected", { sig: elSig(modal) });

    // Initialize debounced quote function
    const runManualOrderQuote = debouncedManualOrderQuote();
    runManualOrderQuote(modal);

    attachModalObserver(modal, scanManualOrderModal);
    // Bind field listeners once (more reliable than mutations for form edits)
    bindConfigureShipmentFieldListeners(modal);
    scanManualOrderModal(modal);
  }


  function bindConfigureShipmentFieldListeners(modal) {
    if (state.manualOrderFieldListenersBound.has(modal)) return;
    state.manualOrderFieldListenersBound.add(modal);

    const handler = (e) => {
      const t = e.target;
      if (!t) return;
      
      // Ensure this event came from within this modal
      if (!modal.contains(t)) return;

      // Only care about configured fields
      if (!t.matches?.(CONFIG.selectors.configureShipmentFieldSelectors)) return;

      log("Configure Shipment field changed", {
        sig: elSig(modal),
        tag: t.tagName,
        name: t.getAttribute("name") || "",
        id: t.id || "",
        value: (() => {
          try { return t.value; } catch { return ""; }
        })(),
      });

      // Trigger quote update when form fields change
      const runManualOrderQuote = debouncedManualOrderQuote();
      runManualOrderQuote(modal);
    };

    // console.log("TEST", modal.querySelector('div[class*="configure-shipment-form"]'), modal.querySelector('div[class*="configure-shipment-form"]').querySelectorAll(CONFIG.selectors.configureShipmentFieldSelectors));

    // modal.querySelector('div[class*="configure-shipment-form"]').querySelectorAll(CONFIG.selectors.configureShipmentFieldSelectors).forEach((field) => {      
    //   field.addEventListener("input", handler, true);
    //   field.addEventListener("change", handler, true);
    // });

    // modal.querySelector('div[class*="configure-shipment-form"]').querySelectorAll(CONFIG.selectors.configureShipmentFieldSelectors).addEventListener("change", handler, true);
    modal.addEventListener("input", handler, true);
    modal.addEventListener("change", handler, true);

    log('Attached field listeners "manualOrderModal"', modal);
  }

  function scanManualOrderModal(modal) {
    const form = modal.querySelector('div[class*="configure-shipment-form"]');
    
    const changed = configureShipmentSnapshotChanged(modal);
    if (changed) {
        log("Configure Shipment fields changed", { sig: elSig(modal) });
        // Trigger quote update when form fields change
        const runManualOrderQuote = debouncedManualOrderQuote();
        runManualOrderQuote(modal);
    } 

    // Keep minimal for now (test only).
    // You can add specific button/section detection here later.    
    const title = getManualOrderTitle(modal) || firstTitleText(modal) || safeText(modal);
    if (title && anyMatcherMatches(title, CONFIG.text.manualOrderTitleMatchers)) {
      if (fireOnceWhileArmed(modal, "manual_order_title_seen")) {
        log("Manual Order title confirmed", { sig: elSig(modal), title });
      }
    }

    if (title && anyMatcherMatches(title, CONFIG.text.configureShipmentTitleMatchers)) {
      if (fireOnceWhileArmed(modal, "configure_shipment_title_seen")) {
        log("Configure Shipment section present", { sig: elSig(modal), title });
      }
    }
  }

  /********************************************************************
   * Detectors: Order Drawer
   ********************************************************************/
  function detectOrderDrawer(root = document) {
    const dialogs = root.querySelectorAll(CONFIG.selectors.anyDialog);
    dialogs.forEach((modal) => {
      if (!isOrderDrawer(modal)) return;
      if (state.seenOrderDrawers.has(modal)) return;
      state.seenOrderDrawers.add(modal);

      log("Order Drawer detected", { sig: elSig(modal) });

      // Initialize debounced quote function
      const runOrderDrawerQuote = debouncedOrderDrawerQuote();
      runOrderDrawerQuote(modal);

      attachModalObserver(modal, scanOrderDrawer);
      scanOrderDrawer(modal);
    });
  }

  function scanOrderDrawer(modal) {
    // Scan for changes that might require quote update
    // You can add specific detections here later
  }

  /********************************************************************
   * Detectors: Export dialog
   ********************************************************************/
  function detectExportModal(root = document) {
    const dialogs = root.querySelectorAll(CONFIG.selectors.anyDialog);
    dialogs.forEach((modal) => {
      if (!isExportModal(modal)) return;
      if (state.seenExportModals.has(modal)) return;
      state.seenExportModals.add(modal);

      const footer = modal.querySelector(CONFIG.selectors.exportFooter);
      log("Export dialog detected", {
        sig: elSig(modal),
        footerFound: !!footer,
      });

      attachModalObserver(modal, scanExportModal);
      scanExportModal(modal);
    });
  }

  function scanExportModal(modal) {
    const footer = modal.querySelector(CONFIG.selectors.exportFooter);
    if (footer && fireOnceWhileArmed(modal, "export_footer_seen")) {
      addRateWarningMessage(footer);
      log("Export dialog footer found (ready for injected text later)", {
        sig: elSig(modal),
        footerClass: footer.className,
      });
    }
  }

  /********************************************************************
   * Mutation observer (generic + debounced; NO document-wide spam logging)
   ********************************************************************/
  function attachModalObserver(modal, scanFn) {
    if (state.modalObserverByModal.has(modal)) return;

    const obs = new MutationObserver(() => {
      const prev = state.debounceTimerByModal.get(modal);
      if (prev) clearTimeout(prev);

      const t = setTimeout(() => scanFn(modal), CONFIG.scanDebounceMs);
      state.debounceTimerByModal.set(modal, t);
    });

    obs.observe(modal, {
      childList: true,
      subtree: true,
      // class changes are important for selection toggles and UI state
      attributes: true,
      attributeFilter: ["class"],
      characterData: true,
    });

    state.modalObserverByModal.set(modal, obs);
    log('Attached observer', { sig: elSig(modal) });
  }

  /********************************************************************
   * Click detection (Browse Rates + Refresh rate)
   ********************************************************************/
  function onDocumentClick(e) {
    const target = e.target;
    if (!target) return;

    // Browse Rates button click
    {
      const btn = target.closest?.(CONFIG.selectors.browseRatesButton);
      if (btn && matchesBrowseRatesButton(btn)) {
        const modal = btn.closest?.(CONFIG.selectors.rateBrowserModal);
        log(
          "Browse Rates clicked",
          btn.tagName + "." + Array.from(btn.classList).join("."),
          `"${safeText(btn)}"`
        );
        if (modal) setTimeout(() => scanRateBrowserModal(modal), 0);
        return;
      }
    }

    // Refresh rate button click
    {
      const refreshBtn = target.closest?.(CONFIG.selectors.refreshRateButton);
      if (refreshBtn) {
        log("Refresh rate clicked", {
          tag: refreshBtn.tagName,
          className: refreshBtn.className,
          ariaLabel: refreshBtn.getAttribute("aria-label") || "",
        });
        return;
      }
    }
  }

  /********************************************************************
   * Change detection (Manual Orders - Configure Shipment fields)
   ********************************************************************/
//   function onDocumentChange(e) {
//     const target = e.target;
//     if (!target) return;

//     // Configure Shipment element change
//     {  
//         // must be inside the manual-order drawer
//         const modal = t.closest?.(CONFIG.selectors.manualOrderModalHintSelectors.join(","));
//         if (!modal) return;
//         if (!isManualOrderModal(modal)) return;

//         // must be a form field
//         if (!t.matches?.(CONFIG.selectors.configureShipmentFieldSelectors)) return;

//         log("Configure Shipment change", {
//             type: e.type,
//             field: getFieldKey(t),
//             value: (t.value ?? "").toString().slice(0, 80),
//             sig: elSig(modal),
//         });
//     }
//   }


  /********************************************************************
   * Input detection (Manual Orders - Configure Shipment fields)
   ********************************************************************/
//   function onDocumentInput(e) {
//     const target = e.target;
//     if (!target) return;

//     // Configure Shipment element input
//     {
//         // must be inside the manual-order drawer
//         const modal = t.closest?.(CONFIG.selectors.manualOrderModalHintSelectors.join(","));
//         if (!modal) return;
//         if (!isManualOrderModal(modal)) return;

//         // must be a form field
//         if (!t.matches?.(CONFIG.selectors.configureShipmentFieldSelectors)) return;

//         // must be in Configure Shipment section
//         if (!t.closest?.('section[aria-label*="Configure Shipment"]')) return;

//         log("Configure Shipment input", {
//             type: e.type,
//             field: getFieldKey(t),
//             value: (t.value ?? "").toString().slice(0, 80),
//             sig: elSig(modal),
//         });
//     }
//   }

  /********************************************************************
   * UI Updater: change only specific UI artifacts
   ********************************************************************/
    function addRateWarningMessage(footer) {
        const warningClass = 'fedex-rate-warning';
        
        // Check if warning message already exists in this footer
        if (footer.querySelector(`.${warningClass}`)) {
            return;
        }
        
        try {
            // Create warning message
            const warningMessage = document.createElement('div');
            warningMessage.className = warningClass;
            warningMessage.textContent = 'The rates shown may not represent updated rates.';
            warningMessage.style.cssText = 'display: block; margin: auto auto 0 0; padding: 0; font-size: 13px; font-weight: smaller; font-style: italic; color: #dc2626; width: fit-content;';
            // Add warning message to footer (before the buttons)
            footer.insertBefore(warningMessage, footer.firstChild);
        } catch (error) {
            // Send email message couldn't be added to footer!!!
            // return;
        }
    }

    function addTickMark(titleElement, isSuccess = false) {
        const statusClass = 'fedex-dialog-tick';       
        if (titleElement.querySelector(`.${statusClass}`)) {
            return;
        }
        const tickMark = document.createElement('span');
        tickMark.className = statusClass;
        tickMark.textContent = isSuccess ? '✓' : '☓';
        tickMark.style.cssText = `display: inline-block; margin-left: 8px; color: ${isSuccess ? '#10b981' : '#ef4444'}; font-size: 1em; font-weight: bold; vertical-align: middle;`;
        // Check if status mark already exists in this title element

        titleElement.appendChild(tickMark);
    }

    function hideTickMark(rateElement) {
        const markClass = 'fedex-rate-mark';
        const existingMarks = rateElement.querySelectorAll(`.${markClass}`);
        existingMarks.forEach(mark => mark.remove());
    }

    function setShipmentTotalCost(modal, amountNumber, source = 'quote') {
        const rateRow = modal.querySelector('div[class*="rate-"] > div');
        if (!rateRow) return false;

        const formatted = `$${Number(amountNumber).toFixed(2)}`;
        rateRow.textContent = `Total Cost: ${formatted}`;

        // optional: add a subtle marker
        rateRow.setAttribute('data-fedex-ext-source', source);
        return true;
    }

    function upsertTitleSpinner(modal, show) {
        const title = modal.querySelector('div[class*="shipment-title"]');
        if (!title) return false;

        const pills = title.querySelector('div[class*="shipment-pills"]');
        if (!pills) return false;

        const id = 'fedex-ext-title-spinner';
        let spinner = pills.querySelector(`#${id}`);

        // Create spinner if it doesn't exist
        if (!spinner) {
            spinner = document.createElement('span');
            spinner.id = id;

            spinner.style.cssText = `
                margin-left: 8px;
                display: inline-flex;
                align-items: center;
                width: 16px;
                height: 16px;
            `;

            // Simple CSS spinner
            spinner.innerHTML = `
                <span style="
                    width: 16px;
                    height: 16px;
                    border: 2px solid #ccc;
                    border-top-color: #3b82f6;
                    border-radius: 50%;
                    display: inline-block;
                    animation: fedex-ext-spin 0.6s linear infinite;
                "></span>
            `;

            pills.appendChild(spinner);

            // Inject keyframes once
            if (!document.getElementById('fedex-ext-spinner-style')) {
                const style = document.createElement('style');
                style.id = 'fedex-ext-spinner-style';
                style.textContent = `
                    @keyframes fedex-ext-spin {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                `;
                document.head.appendChild(style);
            }
        }

        // Toggle visibility - check if spinner is still in DOM
        if (spinner && spinner.parentElement === pills) {
            spinner.style.display = show ? 'inline-flex' : 'none';
        } else if (spinner && !show) {
            // Spinner exists but is orphaned, try to remove it safely
            try {
                if (spinner.parentElement) {
                    spinner.parentElement.removeChild(spinner);
                }
            } catch (e) {
                // Ignore errors if element is already removed
            }
        }

        return true;
    }

    function upsertTitleStatus(modal, ok) {
        const title = modal.querySelector('div[class*="shipment-title"]');
        if (!title) return false;

        const pills = title.querySelector('div[class*="shipment-pills"]');
        if (!pills) return false;

        upsertTitleSpinner(modal, false);

        const id = 'fedex-ext-title-status';
        let badge = pills.querySelector(`#${id}`);

        if (!badge) {
            badge = document.createElement('span');
            badge.id = id;
            badge.style.cssText = `
            margin-left: 8px;
            font-weight: 700;
            font-size: 16px;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            color: ${ok ? '#10b981' : '#ef4444'};
            `;
            try {
                pills.appendChild(badge);
            } catch (e) {
                // Element might have been removed, return false
                return false;
            }
        }

        // Check if badge is still in DOM before updating
        if (badge && badge.parentElement === pills) {
            badge.textContent = ok ? '✓' : '☓';
            badge.title = ok ? 'Quote updated successfully' : 'Quote failed / using fallback';
            // Always update color: ✓ = green, ☓ = red
            badge.style.color = ok ? '#10b981' : '#ef4444';
        } else {
            // Badge was orphaned, try to recreate it
            try {
                badge = document.createElement('span');
                badge.id = id;
                badge.style.cssText = `
                margin-left: 8px;
                font-weight: 700;
                font-size: 16px;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                color: ${ok ? '#10b981' : '#ef4444'};
                `;
                badge.textContent = ok ? '✓' : '☓';
                badge.title = ok ? 'Quote updated successfully' : 'Quote failed / using fallback';
                pills.appendChild(badge);
            } catch (e) {
                return false;
            }
        }

        return true;
    }

    function updateQuoteUI(modal, quoteData) {
      const ok = !!quoteData?.totalAmount;

     upsertTitleStatus(modal, ok);

     if (ok) {
        modal.querySelector('.rate-total').textContent =
            '$' + quoteData.totalAmount.toFixed(2);
     }
   }

   function getShipFromLabel(modal) {
        // "Ship From" row in read-only shipment section
        const labels = Array.from(modal.querySelectorAll('label.label-yCk_C6J'));
        const el = labels.find(x => (x.textContent || '').trim() === 'Ship From');
        const row = el?.closest('.row-_9XYeFv');
        const valueEl = row?.querySelector('.children-qCf7U5z');
        return (valueEl?.textContent || '').trim() || null; // e.g. "Test Locale"
    }

    async function getSenderZip(modal) {
        // Read visible "Ship From" text from Shipment modal
        const shipFromName = getShipFromLabel(modal); // your existing helper from earlier
        if (!shipFromName) return null;

        const list = await fetchShipFromList();
        const hit = list.find(x => (x?.name || "").trim() === shipFromName.trim());

        // prefer originAddress.postalCode (matches your JSON)
        return hit?.originAddress?.postalCode || hit?.postalCode || null;
    }

    /********************************************************************
     * Unified Quote Request Builder (used by all modals)
     ********************************************************************/
    function buildQuoteRequestFromGrid(modal, data, serviceCode, carrierCode) {
        // Unified function for building quote requests from grid data
        // Used by: ShipmentModal, RateBrowserModal, ManualOrderModal, OrderDrawer
        const q = {
            carrierCode,
            serviceCode,
            sender: {
                country: data.senderCountry || 'US',
                zip: data.senderZip
            },
            receiver: {
                country: data.receiverCountry || 'US',
                zip: data.receiverZip,
            },
            weightUnit: normalizeWeightUnit(data.weightUnit),
            dimUnit: normalizeDimUnit(data.dimUnit),
            currency: data.currency || 'USD',
            customsCurrency: data.customsCurrency || 'USD',
            pieces: [{
                weight: String(data.weightValue * 1.0),
                length: String(data.length * 1.0),
                width: String(data.width * 1.0),
                height: String(data.height * 1.0),
                insuranceAmount: data.insuranceAmount > 0
                    ? String(data.insuranceAmount * 1.0)
                    : null,
                declaredValue: null,
            }],
            packageTypeCode: "fedex_custom_package",
            residential: data.residential || false,
            signatureOptionCode: data.signatureOptionCode || null
        };
        
        // Fallback for receiver data if missing
        if (q.receiver && (q.receiver?.zip == null || q?.receiver.country == null)) {
            const receiverData = parseShipToZipAndCountry(modal);
            q.receiver.zip = q.receiver.zip ?? receiverData?.zip;
            q.receiver.country = q.receiver.country ?? receiverData?.country;
        }
        return q;
    }

//    async function buildQuoteRequestBodyFromShipmentModal(modal) {
//         const orderNumber = getShipmentOrderNumber(modal);
//         const serviceLabel = getShipmentServiceLabel(modal);
//         const serviceCode = await toServiceCode(serviceLabel);
//         const senderZip = await getSenderZip(modal);

//         if (!orderNumber || !serviceCode || !senderZip) {
//             return {
//             ok: false,
//             missing: { orderNumber: !orderNumber, serviceCode: !serviceCode, senderZip: !senderZip },
//             requestBody: null
//             };
//         }

//         return {
//             ok: true,
//             missing: null,
//             requestBody: { orderNumber, serviceCode, senderZip }
//         };
//     }

    // async function buildQuoteRequestBodyFromShipmentModal(modal) {
    //     const orderNumber = getShipmentOrderNumber(modal);

    //     // Service info
    //     const serviceLabel = getShipmentServiceLabel(modal); // e.g., "FedEx Ground®"
    //     const carrierCode = inferCarrierCodeFromServiceLabel(serviceLabel);
    //     const serviceCode = await toServiceCode(serviceLabel); // you already have this mapping

    //     // Receiver (Ship To)
    //     const receiver = parseShipToZipAndCountry(modal);

    //     // Weight + size
    //     const weightText = getShipmentFieldValue(modal, "Weight"); // "6 lb 2 oz"
    //     const sizeText = getShipmentFieldValue(modal, "Size");     // "1l x 2w x 1h (in)"
    //     const weightLb = parseWeightToLbDecimal(weightText);
    //     const dims = parseDimsInInches(sizeText);

    //     // Insurance
    //     const insuranceText = getShipmentFieldValue(modal, "Insurance"); // "None" or "$12.15" depending on UI
    //     const insuranceAmount =
    //         !insuranceText || insuranceText.toLowerCase() === "none"
    //         ? null
    //         : (insuranceText.replace(/[^0-9.]/g, '') || null);

    //     // Sender: prefer ship-from lookup (more reliable than trying to scrape zip)
    //     const shipFromName = getShipmentFieldValue(modal, "Ship From"); // "Test Locale"
    //     const senderFromLookup = await getSenderFromShipFromName(shipFromName);

    //     const senderZip = senderFromLookup?.zip || (await getSenderZip(modal)); // fallback to your existing method
    //     const senderCountry = senderFromLookup?.country || "US";

    //     // Validate required fields
    //     const missing = {
    //         orderNumber: !orderNumber,
    //         carrierCode: !carrierCode,        // optional by API, but recommended
    //         serviceCode: !serviceCode,
    //         senderZip: !senderZip,
    //         receiverZip: !receiver?.zip,
    //         receiverCountry: !receiver?.country,
    //         weight: !(weightLb != null),
    //         dims: !dims,
    //     };

    //     const ok =
    //         !!orderNumber &&
    //         !!serviceCode &&
    //         !!senderZip &&
    //         !!receiver?.zip &&
    //         !!receiver?.country &&
    //         (weightLb != null) &&
    //         !!dims;

    //     if (!ok) {
    //         return { ok: false, missing, requestBody: null };
    //     }

    //     const requestBody = {
    //         carrierCode: carrierCode || undefined,          // optional by API
    //         serviceCode,                                   // optional by API but you want single-service quote
    //         packageTypeCode: undefined,                     // optional for now (add mapping later if needed)

    //         sender: { country: senderCountry, zip: senderZip },
    //         receiver: { country: receiver.country, zip: receiver.zip },

    //         // optional knobs (can add later)
    //         // residential: true/false,
    //         // signatureOptionCode: null,
    //         // contentDescription: "",

    //         weightUnit: "lb",
    //         dimUnit: "in",
    //         currency: "USD",
    //         customsCurrency: "USD",

    //         pieces: [
    //         {
    //             weight: String(weightLb),
    //             length: String(dims.length),
    //             width: String(dims.width),
    //             height: String(dims.height),
    //             insuranceAmount: insuranceAmount ? String(insuranceAmount) : null,
    //             declaredValue: null, // domestic
    //         },
    //         ],

    //         // optional:
    //         // billing: { party: "sender" },
    //         providerAccountId: null,

    //         // keep for debugging / correlation (your backend can ignore unknown fields)
    //         _orderNumber: orderNumber,
    //     };

    //     return { ok: true, missing: null, requestBody };
    // }

    function getShipmentOrderNumber(modal) {
        // Left section "Order Number" value
        const label = Array.from(modal.querySelectorAll('.label-Z7VsoXa'))
            .find(el => (el.textContent || '').trim() === 'Order Number');

        if (!label) return null;

        const valueEl = getNextSiblingWithClass(label, 'content-wdcYlRS');
        return (valueEl?.textContent || '').trim() || null;
    }

    function getShipmentServiceLabel(modal) {
        // Right section read-only "Service" row value
        const labels = Array.from(modal.querySelectorAll('label.label-yCk_C6J'));
        const serviceLabelEl = labels.find(el => (el.textContent || '').trim() === 'Service');
        // console.log('labels', labels, serviceLabelEl);
        if (!serviceLabelEl) return null;

        const row = serviceLabelEl.closest('.row-_9XYeFv');
        const valueEl = row?.querySelector('.children-qCf7U5z');
        // console.log('service row', row, valueEl, valueEl?.textContent);
        return (valueEl?.textContent || '').trim() || null;
    }

    async function toServiceCode(serviceLabel) {
        if (!serviceLabel) return null;

        // Use the toServiceCode from helper.js if available
        if (typeof window.toServiceCode === 'function') {
            return await window.toServiceCode(serviceLabel);
        }

        // Fallback: if helper.js hasn't loaded yet, try to build the map
        console.warn('[Content] window.toServiceCode not available, using fallback');
        if (typeof window.buildServiceMap === 'function') {
            const serviceMap = await window.buildServiceMap();
            const s = serviceLabel
                .replace(/[®™]/g, "")
                .trim()
                .toLowerCase();

            // direct match
            if (serviceMap && serviceMap[s]) return serviceMap[s];

            // soft match
            if (serviceMap) {
                const hit = Object.keys(serviceMap).find(k => s.includes(k));
                return hit ? serviceMap[hit] : null;
            }
        }

        return null;
    }

    // Minimal service mapping (extend as you see more values)
    // function toServiceCode(serviceLabel) {
    //     if (!serviceLabel) return null;

    //     const s = serviceLabel
    //         .replace(/[®™]/g, '')
    //         .trim()
    //         .toLowerCase();

    //     const map = {
    //         'fedex ground': 'fedex_ground',
    //         'fedex home delivery': 'fedex_home_delivery',
    //         'fedex 2day': 'fedex_2day',
    //         'fedex express saver': 'fedex_express_saver',
    //         'fedex standard overnight': 'fedex_standard_overnight',
    //         'fedex priority overnight': 'fedex_priority_overnight',
    //     };

    //     // direct map
    //     if (map[s]) return map[s];

    //     // soft match (handles "FedEx Ground®" etc)
    //     const hit = Object.keys(map).find(k => s.includes(k));
    //     return hit ? map[hit] : null;
    // }

    async function getSenderFromShipFromName(shipFromName) {
        if (!shipFromName) return null;

        // background should respond with shipFrom list (cached)
        const resp = await sendMessageAsync({ action: "getShipFromList" });
        const list = resp?.data || resp; // depends on your background wrapper
        if (!Array.isArray(list)) return null;

        const match = list.find(x => (x?.name || '').trim() === shipFromName.trim());
        const zip = match?.originAddress?.postalCode || null;
        const country = match?.originAddress?.countryCode || 'US';

        return { zip, country };
    }

    function getShipmentFieldValue(modal, labelText) {
        // matches rows like: <label class="label-yCk_C6J">Weight</label> ... <span class="info-jxhWsVo">6 lb 2 oz</span>
        const labels = Array.from(modal.querySelectorAll('label.label-yCk_C6J'));
        const label = labels.find(l => (l.textContent || '').trim() === labelText);
        if (!label) return null;

        const row = label.closest('[class*="row-"]') || label.parentElement;
        if (!row) return null;

        // value is usually in span.info-jxhWsVo or span.insurance-label... etc
        const valueEl =
            row.querySelector('span.info-jxhWsVo') ||
            row.querySelector('span.insurance-label-bmRd4W8') ||
            row.querySelector('a.button-link') ||
            row.querySelector('span') ||
            row.querySelector('div');

        const txt = (valueEl?.textContent || '').trim();
        return txt || null;
    }

    function getShipmentFulfillmentIdFromModal(modal) {
        const el = modal.querySelector('[class*="shipment-number"], .shipment-number-lGuL9a9');
        const txt = (el?.textContent || '').trim(); // "Shipment #223567388"
        const m = txt.match(/Shipment\s*#\s*(\d+)/i);
        return m ? m[1] : null;
    }

    function parseWeightToLbDecimal(weightText) {
        // "6 lb 2 oz" -> 6.125
        if (!weightText) return null;

        const lbMatch = weightText.match(/(\d+(?:\.\d+)?)\s*lb/i);
        const ozMatch = weightText.match(/(\d+(?:\.\d+)?)\s*oz/i);

        const lb = lbMatch ? parseFloat(lbMatch[1]) : 0;
        const oz = ozMatch ? parseFloat(ozMatch[1]) : 0;

        const total = lb + (oz / 16);
        return Number.isFinite(total) ? total : null;
    }

    function parseDimsInInches(sizeText) {
        // "1l x 2w x 1h (in)" -> {length:"1", width:"2", height:"1"}
        if (!sizeText) return null;

        const m = sizeText.match(/(\d+(?:\.\d+)?)\s*l\s*x\s*(\d+(?:\.\d+)?)\s*w\s*x\s*(\d+(?:\.\d+)?)\s*h/i);
        if (!m) return null;

        return {
            length: m[1],
            width: m[2],
            height: m[3],
        };
    }

    function parseShipToZipAndCountry(modal) {
        // Your left panel includes: "Houston, TX 77077 US"
        const shipToBlock = modal.querySelector('[data-testid="read-only-address"]');
        const lines = shipToBlock ? Array.from(shipToBlock.querySelectorAll('div')).map(d => (d.textContent || '').trim()).filter(Boolean) : [];

        // find line like "Houston, TX 77077 US" (or similar)
        const lastLine = lines.slice().reverse().find(l => /\b\d{5}(?:-\d{4})?\b/.test(l)) || '';
        const zipMatch = lastLine.match(/\b(\d{5}(?:-\d{4})?)\b/);
        const countryMatch = lastLine.match(/\b([A-Z]{2})\b\s*$/); // trailing US

        const zip = zipMatch ? zipMatch[1] : null;
        const country = countryMatch ? countryMatch[1] : "US"; // safe default if absent

        return { zip, country };
    }

    function inferCarrierCodeFromServiceLabel(serviceLabel) {
        const s = (serviceLabel || '').toLowerCase();
        if (s.startsWith('fedex')) return 'fedex';
        if (s.startsWith('ups')) return 'ups';
        if (s.startsWith('usps')) return 'usps';
        if (s.startsWith('dhl')) return 'dhl';
        return null; // unknown
    }

   /********************************************************************
   * API Retriever: call quote API and email service
   ********************************************************************/
    function debouncedRateBrowserQuote() {
        return debounce(async (modal) => {
            upsertTitleSpinner(modal, true);

            // const fulfillmentId = getRateBrowserFulfillmentId(modal);
            // if (!fulfillmentId) {
            //     upsertTitleStatus(modal, false);
            //     return;
            // }

            // Extract sender zip from DOM
            const senderZip = getSenderZipFromModal(modal);
            console.log('[RateBrowser] Extracted sender zip:', senderZip);
            
            const os = await sendMessageAsync({
                action: 'getOrderGrids',
                // fulfillmentId,
                senderZip: senderZip,
                origin: location.origin
            });

            console.log('Order grid data', os?.data);

            if (!os?.success || !os?.data) {
                upsertTitleStatus(modal, false);
                return;
            }

            // only operate when the FedEx Account carrier is selected
            const carrierBtns = Array.from(modal.querySelectorAll('.seller-provider-list-item-eRfqP0N'));
            const selectedCarrier = carrierBtns.find(b => b.classList.contains('selected-DijZlFi'));
            console.log('Selected carrier', selectedCarrier);
            if (!selectedCarrier || !isFedexAccountCarrierButton(selectedCarrier)) {
                upsertTitleStatus(modal, true); // modal is fine, just not the carrier we target
                return;
            }
            
            // You’ll need to tune these selectors once rates render in the modal
            const rows = getRateRows(modal);
            console.log('Rate rows', rows);
            if (!rows.length) {
                upsertTitleStatus(modal, false);
                return;
            }

            // Quote each service and patch the UI
            let anyOk = false;

            for (const row of rows) {
                const serviceLabel = getRateRowServiceLabel(row);
                const serviceCode = await toServiceCode(serviceLabel);
                if (!serviceCode) continue;

                const requestBody = buildQuoteRequestFromGrid(
                    modal,
                    os.data,
                    serviceCode,
                    CONFIG.carrierCode // fedex
                );

                const quote = await sendMessageAsync({ action: 'callQuoteAPI', requestBody });
                const ok = !!quote?.data?.totalAmount;

                if (ok) {
                    anyOk = true;
                    setRateRowPrice(row, quote.data.totalAmount);
                }
            }

            upsertTitleStatus(modal, anyOk);
        }, 1500);
    }

   function debouncedShipmentQuote() {
        return debounce(async (modal) => {
            upsertTitleSpinner(modal, true);
            const fulfillmentId = getShipmentFulfillmentIdFromModal(modal);
            if (!fulfillmentId) return;

            const ss = await sendMessageAsync({
                action: 'getShipmentGrids',
                fulfillmentId,
                origin: location.origin
            });

            console.log('Shipment grid data', ss);
            
            if (!ss?.success || !ss?.data) {
                upsertTitleStatus(modal, false);
                return;
            }
            
            const serviceLabel = getShipmentServiceLabel(modal);
            const serviceCode = await toServiceCode(serviceLabel);
            const requestBody = buildQuoteRequestFromGrid(modal, ss.data, serviceCode, CONFIG.carrierCode);

            console.log('Built quote request body', requestBody);

            const quote = await sendMessageAsync({
                action: 'callQuoteAPI',
                requestBody
            });

            console.log('Quote response', quote);

            const ok = !!quote?.data?.totalAmount;

            if (ok) {
                setShipmentTotalCost(modal, quote.data.totalAmount);
            }

            upsertTitleStatus(modal, ok);
        }, 1500);
    }

     /********************************************************************
      * Data Extraction: Manual Order Modal
      ********************************************************************/
     function getManualOrderOrderNumberFromModal(modal) {
         console.log('[ManualOrder] Extracting order number from modal');
         const el = modal.querySelector('[class*="order-number"], .order-info-order-number-vbTaRbB > .h4-yAR2Zwb');
         console.log('[ManualOrder] Order number element found:', !!el, el?.textContent?.trim());
         const txt = (el?.textContent || '').trim(); // "Order # 100002" or "Order #100002"
         const m = txt.match(/Order\s*#\s*(\d+)/i);
         const orderNumber = m ? m[1] : null;
         console.log('[ManualOrder] Extracted order number:', orderNumber);
         return orderNumber;
     }

     function getSenderZipFromModal(modal) {
         console.log('[ManualOrder] Extracting sender zip from modal');
         const el = modal.querySelector('.title-xfcwNVW');
         if (!el) {
             console.log('[ManualOrder] Sender zip element not found');
             return null;
         }
         const txt = (el?.textContent || '').trim();
         console.log('[ManualOrder] Sender zip element text:', txt);
         
         // If it's "Test Locale", return "80224"
         if (txt.toLowerCase() === 'test locale') {
             console.log('[ManualOrder] Detected "Test Locale", using zip: 80224');
             return '80224';
         }
         
         // Otherwise, try to extract zip code from the text
         // Could be just the zip, or could contain other text
         const zipMatch = txt.match(/\b\d{5}(?:-\d{4})?\b/);
         if (zipMatch) {
             console.log('[ManualOrder] Extracted zip from text:', zipMatch[0]);
             return zipMatch[0];
         }
         
         // If no zip pattern found, return the text as-is (might be just the zip)
         console.log('[ManualOrder] No zip pattern found, using text as-is:', txt);
         return txt || null;
     }

    function getManualOrderServiceLabel(modal) {
        console.log('[ManualOrder] Extracting service label from modal');
        // Extract service label from Manual Order modal
        // Look in Configure Shipment form
        const form = modal.querySelector('div[class*="configure-shipment-form"]');
        console.log('[ManualOrder] Configure shipment form found:', !!form);
        
        if (form) {
            const serviceField = form.querySelector('.configure-shipment-form-a7ygSon .flex-column-ZRDBtph .dropdown-field-x5ueAwa .base-combobox-IQILhMX .single-value-zLWJOKx');
            console.log('[ManualOrder] Service field found:', !!serviceField);
            if (serviceField) {
                const serviceLabel = fieldValueState(serviceField);
                console.log('[ManualOrder] Service label from form field:', serviceLabel);
                return serviceLabel;
            }
        }

        // Fallback: look for service in read-only sections
        const serviceLabel = getShipmentFieldValue(modal, "Service");
        console.log('[ManualOrder] Service label from fallback:', serviceLabel);
        return serviceLabel;
    }

   /********************************************************************
   * Data Extraction: Order Drawer
   ********************************************************************/
   function getOrderDrawerFulfillmentId(modal) {
        // Extract fulfillment ID or order number from Order Drawer
        // Try to find order number in title
        const title = firstTitleText(modal) || safeText(modal);
        if (title) {
            const orderMatch = title.match(/Order\s*#\s*(\d+)/i);
            if (orderMatch) return orderMatch[1];
        }

        // Try to find fulfillment ID
        const fulfillmentEl = modal.querySelector('[class*="fulfillment"], [data-fulfillment-id], [data-testid*="fulfillment"]');
        if (fulfillmentEl) {
            const id = fulfillmentEl.getAttribute('data-fulfillment-id') || 
                      fulfillmentEl.getAttribute('data-testid')?.match(/\d+/)?.[0] ||
                      safeText(fulfillmentEl).match(/\d+/)?.[0];
            if (id) return id;
        }

        return null;
    }

    function getOrderDrawerServiceLabel(modal) {
        // Extract service label from Order Drawer
        // Look for service in various locations
        const serviceEl = modal.querySelector('[class*="service"], [aria-label*="Service" i], [data-testid*="service"]');
        if (serviceEl) {
            return fieldValueState(serviceEl) || safeText(serviceEl);
        }

        // Fallback: use same method as shipment
        return getShipmentServiceLabel(modal);
    }

   /********************************************************************
   * UI Updates: Manual Order Modal
   ********************************************************************/
    function upsertManualOrderSpinner(modal, show) {
        console.log('[ManualOrder] upsertManualOrderSpinner called:', { show });
        // Add spinner to Manual Order modal title/header
        const title = modal.querySelector('.order-info-order-number-vbTaRbB > .h4-yAR2Zwb');
        console.log('[ManualOrder] Title element found:', !!title);
        if (!title) {
            console.error('[ManualOrder] ❌ Title element not found for spinner');
            return false;
        }

        const id = 'fedex-ext-manualorder-spinner';
        let spinner = title.querySelector(`#${id}`);

        if (!spinner && show) {
            spinner = document.createElement('span');
            spinner.id = id;
            spinner.style.cssText = `
                margin-left: 8px;
                display: inline-flex;
                align-items: center;
                width: 16px;
                height: 16px;
            `;
            spinner.innerHTML = `
                <span style="
                    width: 16px;
                    height: 16px;
                    border: 2px solid #ccc;
                    border-top-color: #3b82f6;
                    border-radius: 50%;
                    display: inline-block;
                    animation: fedex-ext-spin 0.6s linear infinite;
                "></span>
            `;
            title.appendChild(spinner);

            if (!document.getElementById('fedex-ext-spinner-style')) {
                const style = document.createElement('style');
                style.id = 'fedex-ext-spinner-style';
                style.textContent = `
                    @keyframes fedex-ext-spin {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                `;
                document.head.appendChild(style);
            }
        }

        // Toggle visibility - check if spinner is still in DOM
        if (spinner && spinner.parentElement === title) {
            spinner.style.display = show ? 'inline-flex' : 'none';
        } else if (spinner && !show) {
            // Spinner exists but is orphaned, try to remove it safely
            try {
                if (spinner.parentElement) {
                    spinner.parentElement.removeChild(spinner);
                }
            } catch (e) {
                // Ignore errors if element is already removed
            }
        }

        return true;
    }

    function upsertManualOrderStatus(modal, ok) {
        console.log('[ManualOrder] upsertManualOrderStatus called:', { ok, status: ok ? 'SUCCESS ✓' : 'FAILED ☓' });
        // Add status badge to Manual Order modal
        const title = modal.querySelector('.order-info-order-number-vbTaRbB > .h4-yAR2Zwb');
        console.log('[ManualOrder] Title element found:', !!title);
        if (!title) {
            console.error('[ManualOrder] ❌ Title element not found for status badge');
            return false;
        }

        console.log('[ManualOrder] Hiding spinner');
        upsertManualOrderSpinner(modal, false);

        const id = 'fedex-ext-manualorder-status';
        let badge = title.querySelector(`#${id}`);

        if (!badge) {
            console.log('[ManualOrder] Creating new status badge');
            badge = document.createElement('span');
            badge.id = id;
            badge.style.cssText = `
                margin-left: 8px;
                font-weight: 700;
                font-size: 16px;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                color: ${ok ? '#10b981' : '#ef4444'};
            `;
            try {
                title.appendChild(badge);
            } catch (e) {
                console.error('[ManualOrder] ❌ Failed to append badge:', e);
                return false;
            }
        } else {
            console.log('[ManualOrder] Using existing status badge');
        }

        // Check if badge is still in DOM before updating
        if (badge && badge.parentElement === title) {
            badge.textContent = ok ? '✓' : '☓';
            badge.title = ok ? 'Quote updated successfully' : 'Quote failed / using fallback';
            // Always update color: ✓ = green, ☓ = red
            badge.style.color = ok ? '#10b981' : '#ef4444';
            console.log('[ManualOrder] ✓ Status badge updated:', ok ? 'SUCCESS ✓' : 'FAILED ☓');
        } else {
            // Badge was orphaned, try to recreate it
            console.log('[ManualOrder] Badge was orphaned, recreating...');
            try {
                badge = document.createElement('span');
                badge.id = id;
                badge.style.cssText = `
                    margin-left: 8px;
                    font-weight: 700;
                    font-size: 16px;
                    line-height: 1;
                    display: inline-flex;
                    align-items: center;
                    color: ${ok ? '#10b981' : '#ef4444'};
                `;
                badge.textContent = ok ? '✓' : '☓';
                badge.title = ok ? 'Quote updated successfully' : 'Quote failed / using fallback';
                title.appendChild(badge);
                console.log('[ManualOrder] ✓ Status badge recreated');
            } catch (e) {
                console.error('[ManualOrder] ❌ Failed to recreate badge:', e);
                return false;
            }
        }

        return true;
    }

    function setManualOrderTotalCost(modal, amountNumber, source = 'quote') {
        console.log('[ManualOrder] setManualOrderTotalCost called:', { amountNumber, source });
        // Update rate display in Manual Order modal
        const rateRow = modal.querySelector('.rate-amount-R6LSuka');
        console.log('[ManualOrder] Rate row element found:', !!rateRow);
        
        if (!rateRow) {
            console.error('[ManualOrder] ❌ Rate row element not found');
            return false;
        }

        const formatted = `$${Number(amountNumber).toFixed(2)}`;
        console.log('[ManualOrder] Updating rate display:', formatted);
        rateRow.textContent = `Total Cost: ${formatted}`;
        rateRow.setAttribute('data-fedex-ext-source', source);
        console.log('[ManualOrder] ✓ Rate display updated successfully');
        return true;
    }

   /********************************************************************
   * UI Updates: Order Drawer
   ********************************************************************/
   function upsertOrderDrawerSpinner(modal, show) {
        // Add spinner to Order Drawer header/title
        const title = modal.querySelector('h1, h2, h3, [class*="drawer-header"], [class*="drawer-title"], [class*="order-header"]');
        if (!title) return false;

        const id = 'fedex-ext-orderdrawer-spinner';
        let spinner = title.querySelector(`#${id}`);

        if (!spinner && show) {
            spinner = document.createElement('span');
            spinner.id = id;
            spinner.style.cssText = `
                margin-left: 8px;
                display: inline-flex;
                align-items: center;
                width: 16px;
                height: 16px;
            `;
            spinner.innerHTML = `
                <span style="
                    width: 16px;
                    height: 16px;
                    border: 2px solid #ccc;
                    border-top-color: #3b82f6;
                    border-radius: 50%;
                    display: inline-block;
                    animation: fedex-ext-spin 0.6s linear infinite;
                "></span>
            `;
            title.appendChild(spinner);

            if (!document.getElementById('fedex-ext-spinner-style')) {
                const style = document.createElement('style');
                style.id = 'fedex-ext-spinner-style';
                style.textContent = `
                    @keyframes fedex-ext-spin {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                `;
                document.head.appendChild(style);
            }
        }

        // Toggle visibility - check if spinner is still in DOM
        if (spinner && spinner.parentElement === title) {
            spinner.style.display = show ? 'inline-flex' : 'none';
        } else if (spinner && !show) {
            // Spinner exists but is orphaned, try to remove it safely
            try {
                if (spinner.parentElement) {
                    spinner.parentElement.removeChild(spinner);
                }
            } catch (e) {
                // Ignore errors if element is already removed
            }
        }

        return true;
    }

    function upsertOrderDrawerStatus(modal, ok) {
        // Add status badge to Order Drawer
        const title = modal.querySelector('h1, h2, h3, [class*="drawer-header"], [class*="drawer-title"], [class*="order-header"]');
        if (!title) return false;

        upsertOrderDrawerSpinner(modal, false);

        const id = 'fedex-ext-orderdrawer-status';
        let badge = title.querySelector(`#${id}`);

        if (!badge) {
            badge = document.createElement('span');
            badge.id = id;
            badge.style.cssText = `
                margin-left: 8px;
                font-weight: 700;
                font-size: 16px;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                color: ${ok ? '#10b981' : '#ef4444'};
            `;
            try {
                title.appendChild(badge);
            } catch (e) {
                // Element might have been removed, return false
                return false;
            }
        }

        // Check if badge is still in DOM before updating
        if (badge && badge.parentElement === title) {
            badge.textContent = ok ? '✓' : '☓';
            badge.title = ok ? 'Quote updated successfully' : 'Quote failed / using fallback';
            // Always update color: ✓ = green, ☓ = red
            badge.style.color = ok ? '#10b981' : '#ef4444';
        } else {
            // Badge was orphaned, try to recreate it
            try {
                badge = document.createElement('span');
                badge.id = id;
                badge.style.cssText = `
                    margin-left: 8px;
                    font-weight: 700;
                    font-size: 16px;
                    line-height: 1;
                    display: inline-flex;
                    align-items: center;
                    color: ${ok ? '#10b981' : '#ef4444'};
                `;
                badge.textContent = ok ? '✓' : '☓';
                badge.title = ok ? 'Quote updated successfully' : 'Quote failed / using fallback';
                title.appendChild(badge);
            } catch (e) {
                return false;
            }
        }

        return true;
    }

    function setOrderDrawerTotalCost(modal, amountNumber, source = 'quote') {
        // Update rate display in Order Drawer
        const rateRow = modal.querySelector('div[class*="rate-"], div[class*="total-cost"], div[class*="shipping-cost"], [class*="rate"] > div');
        if (!rateRow) return false;

        const formatted = `$${Number(amountNumber).toFixed(2)}`;
        rateRow.textContent = `Total Cost: ${formatted}`;
        rateRow.setAttribute('data-fedex-ext-source', source);
        return true;
    }

   /********************************************************************
   * Quote Request Builders: Manual Order & Order Drawer
   ********************************************************************/

   /********************************************************************
   * Debounced Quote Functions: Manual Order & Order Drawer
   ********************************************************************/
   function debouncedManualOrderQuote() {
        return debounce(async (modal) => {
            console.log('[ManualOrder] ========== Quote process started ==========');
            console.log('[ManualOrder] Modal signature:', elSig(modal));
            
            // Step 1: Show spinner
            console.log('[ManualOrder] Step 1: Showing spinner');
            upsertManualOrderSpinner(modal, true);
            
            // Step 2: Extract order number
            console.log('[ManualOrder] Step 2: Extracting order number');
            const orderNumber = getManualOrderOrderNumberFromModal(modal);
            if (!orderNumber) {
                console.error('[ManualOrder] ❌ Failed: No order number found');
                upsertManualOrderStatus(modal, false);
                return;
            }
            console.log('[ManualOrder] ✓ Order number extracted:', orderNumber);

            // Step 3: Extract sender zip from DOM
            const senderZip = getSenderZipFromModal(modal);
            console.log('[ManualOrder] Extracted sender zip:', senderZip);
            
            // Step 4: Fetch order grid data
            console.log('[ManualOrder] Step 4: Fetching order grid data');
            console.log('[ManualOrder] Request params:', { orderNumber, senderZip, origin: location.origin });
            
            const orderData = await sendMessageAsync({
                action: 'getOrderGrids',
                orderNumber: orderNumber,
                senderZip: senderZip,
                origin: location.origin
            });

            console.log('[ManualOrder] Order grid response received');
            console.log('[ManualOrder] Order grid success:', orderData?.success);
            console.log('[ManualOrder] Order grid data keys:', orderData?.data ? Object.keys(orderData.data) : 'no data');
            console.log('[ManualOrder] Full order grid data:', orderData);
            
            if (!orderData?.success || !orderData?.data) {
                console.error('[ManualOrder] ❌ Failed: Invalid order grid response');
                console.error('[ManualOrder] Response:', orderData);
                upsertManualOrderStatus(modal, false);
                return;
            }
            console.log('[ManualOrder] ✓ Order grid data fetched successfully');
            
            // Step 4: Extract service label
            console.log('[ManualOrder] Step 4: Extracting service label');
            const serviceLabel = getManualOrderServiceLabel(modal);
            if (!serviceLabel) {
                console.warn('[ManualOrder] ⚠️ Warning: No service label found, continuing anyway');
            } else {
                console.log('[ManualOrder] ✓ Service label extracted:', serviceLabel);
            }
            
            // Step 5: Map service label to service code
            console.log('[ManualOrder] Step 5: Mapping service label to service code');
            const serviceCode = await toServiceCode(serviceLabel);
            if (!serviceCode) {
                console.warn('[ManualOrder] ⚠️ Warning: Could not map service label to code');
                console.log('[ManualOrder] Service label was:', serviceLabel);
            } else {
                console.log('[ManualOrder] ✓ Service code mapped:', serviceCode);
            }
            
            // Step 6: Build quote request body
            console.log('[ManualOrder] Step 6: Building quote request body');
            console.log('[ManualOrder] Grid data structure:', {
                senderCountry: orderData.data.senderCountry,
                senderZip: orderData.data.senderZip,
                receiverCountry: orderData.data.receiverCountry,
                receiverZip: orderData.data.receiverZip,
                weightUnit: orderData.data.weightUnit,
                weightValue: orderData.data.weightValue,
                dimUnit: orderData.data.dimUnit,
                length: orderData.data.length,
                width: orderData.data.width,
                height: orderData.data.height,
                residential: orderData.data.residential,
                signatureOptionCode: orderData.data.signatureOptionCode,
                insuranceAmount: orderData.data.insuranceAmount,
                currency: orderData.data.currency
            });
            
            const requestBody = buildQuoteRequestFromGrid(modal, orderData.data, serviceCode, CONFIG.carrierCode);

            console.log('[ManualOrder] ✓ Quote request body built');
            console.log('[ManualOrder] Request body:', JSON.stringify(requestBody, null, 2));

            // Step 7: Call quote API
            console.log('[ManualOrder] Step 7: Calling quote API');
            const quote = await sendMessageAsync({
                action: 'callQuoteAPI',
                requestBody
            });

            console.log('[ManualOrder] Quote API response received');
            console.log('[ManualOrder] Quote success:', quote?.success);
            console.log('[ManualOrder] Quote cached:', quote?.cached);
            console.log('[ManualOrder] Quote deduped:', quote?.deduped);
            console.log('[ManualOrder] Quote totalAmount:', quote?.data?.totalAmount);
            console.log('[ManualOrder] Full quote response:', quote);

            // Step 8: Process result
            const ok = !!quote?.data?.totalAmount;
            console.log('[ManualOrder] Step 8: Processing result');
            console.log('[ManualOrder] Quote status:', ok ? 'SUCCESS ✓' : 'FAILED ☓');

            if (ok) {
                console.log('[ManualOrder] Updating UI with new rate:', quote.data.totalAmount);
                const updateSuccess = setManualOrderTotalCost(modal, quote.data.totalAmount);
                console.log('[ManualOrder] UI update result:', updateSuccess ? 'SUCCESS' : 'FAILED');
            } else {
                console.error('[ManualOrder] ❌ Quote failed - no totalAmount in response');
            }

            // Step 9: Update status badge
            console.log('[ManualOrder] Step 9: Updating status badge');
            upsertManualOrderStatus(modal, ok);
            console.log('[ManualOrder] ========== Quote process completed ==========');
        }, 1500);
    }

    function debouncedOrderDrawerQuote() {
        return debounce(async (modal) => {
            upsertOrderDrawerSpinner(modal, true);
            
            const fulfillmentId = getOrderDrawerFulfillmentId(modal);
            if (!fulfillmentId) {
                upsertOrderDrawerStatus(modal, false);
                return;
            }

            // Extract sender zip from DOM
            const senderZip = getSenderZipFromModal(modal);
            console.log('[OrderDrawer] Extracted sender zip:', senderZip);
            
            // Try to get order grid data
            // NOTE: You may need to adjust the API call based on Order Drawer structure
            const orderData = await sendMessageAsync({
                action: 'getOrderGrids',
                orderNumber: fulfillmentId,
                senderZip: senderZip,
                origin: location.origin
            });

            console.log('Order Drawer grid data', orderData);
            
            if (!orderData?.success || !orderData?.data) {
                upsertOrderDrawerStatus(modal, false);
                return;
            }
            
            const serviceLabel = getOrderDrawerServiceLabel(modal);
            const serviceCode = await toServiceCode(serviceLabel);
            
            // Build request body from order grid data
            // NOTE: You may need to transform orderData.data to match the expected structure
            const requestBody = buildQuoteRequestFromGrid(modal, orderData.data, serviceCode, CONFIG.carrierCode);

            console.log('Order Drawer quote request body', requestBody);

            const quote = await sendMessageAsync({
                action: 'callQuoteAPI',
                requestBody
            });

            console.log('Order Drawer quote response', quote);

            const ok = !!quote?.data?.totalAmount;

            if (ok) {
                setOrderDrawerTotalCost(modal, quote.data.totalAmount);
            }

            upsertOrderDrawerStatus(modal, ok);
        }, 1500);
    }

//    function debouncedShipmentQuote() {
//      return debounce(async (modal) => {
//         const built = await buildQuoteRequestBodyFromShipmentModal(modal);
//         console.log('REQUEST BODY', built.requestBody, built.missing);
//         if (!built.ok) {
//             upsertTitleStatus(modal, false);
//             return;
//         }
//         // const resp = await callQuoteAPI(requestBody);
//         // const resp = null;
//         // const result = await chrome.runtime.sendMessage({
//         //     action: 'callQuoteAPI',
//         //     // requestBody: requestBody
//         // }, (response) => {
//         //     return response;
//         // });
//         const response = await sendMessageAsync({
//             action: 'callQuoteAPI',
//             requestBody: built.requestBody
//         })
//         const quoteResponse = response?.data;
//         console.log('QUOTE RESPONSE', response);
//         const totalAmount = extractTotalAmountFromQuoteResponse(
//             quoteResponse,
//             built?.requestBody?.serviceCode
//         );
//         const ok = totalAmount != null;
//         // console.log('QUOTE RESPONSE RESULT', result);

//         // const ok = !!resp?.success && !!resp?.data?.totalAmount;
//         if (ok) setShipmentTotalCost(modal, totalAmount);
//         upsertTitleStatus(modal, ok);
//      }, 1200);
//    }

  /********************************************************************
   * Root router: detect only the things we care about (no generic modal spam)
   ********************************************************************/
  function routeRootNode(node) {
    // console.log('Routing root node', node);
    if (!node || node.nodeType !== 1) return;

    // If a rate-browser modal exists inside this subtree, detect it
    detectRateBrowserModal(node);

    // Detect shipment/manual/order drawer/export dialogs by classification
    detectShipmentModal(node);
    detectManualOrderModal(node);
    detectOrderDrawer(node);
    detectExportModal(node);
  }

  /********************************************************************
   * Boot
   ********************************************************************/
  function boot() {
    document.addEventListener("click", onDocumentClick, true);
    // document.addEventListener("change", onDocumentChange, true);
    // document.addEventListener("input", onDocumentInput, true);

    // Root observer: detect when relevant dialogs are inserted
    const rootObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          routeRootNode(node);
        }
      }
    });

    rootObs.observe(document.documentElement || document.body, { childList: true, subtree: true });

    // Initial scan
    routeRootNode(document);

    log("FedEx Extension script loaded");
  }

  boot();
})();
