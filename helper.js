const quotePromiseByKey = new Map();        // key -> Promise
const quoteResultByKey = new Map();         // key -> { ts, result }
const emailNotificationCache = new Set();   // Simple cache to prevent duplicate emails
let quoteCacheTtlMs = 60_000;               // 1 min (tweak)
let serviceListCache = null;
let dynamicServiceMap = null;
let shipFromCache = null;
let shipFromCacheAt = 0;

const clientEmailAddresses = [
    'nashid.toptal@gmail.com'
    // 'mattblainehill@gmail.com',
    // 'spencer@freightwire.com'
];

const DEBUG_LOG_RATES = true; // Set to false to silence rate comparison logs.

// Helper function to check if we're on a ShipStation domain
function isShipStationDomain() {
    try {
        const hostname = window.location.hostname.toLowerCase();
        return hostname.includes('shipstation.com');
    } catch (e) {
        return false;
    }
}

function debugRateLog(...args) {
    if (!DEBUG_LOG_RATES) return;
    console.log('[FedEx Rates]', ...args);
}

function debounce(func, timeout = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func.apply(this, args);
    }, timeout);
  };
}

// Injects CSS needed for our lightweight loading spinner
function ensureFedExSpinnerStyles() {
    if (document.getElementById('fedex-spinner-styles')) return;
    const style = document.createElement('style');
    style.id = 'fedex-spinner-styles';
    style.textContent = `
        @keyframes fedex-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .fedex-inline-spinner {
            width: 14px;
            height: 14px;
            border: 2px solid rgba(0,0,0,0.25);
            border-top-color: rgba(0,0,0,0.75);
            border-radius: 50%;
            display: inline-block;
            animation: fedex-spin 0.9s linear infinite;
        }
    `;
    document.head.appendChild(style);
}

function sendMessageAsync(message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                const err = chrome.runtime.lastError;
                if (err) reject(err);
                resolve(response);
            });
        } catch (e) {
            reject(e);
        }
    });
}

// Calls the background script to get a shipping quote
async function callQuoteAPI(requestBody) {
    const key = makeQuoteRequestKey(requestBody);

    // Return cached result if fresh
    const cached = quoteResultByKey.get(key);
    if (cached && (Date.now() - cached.ts) < quoteCacheTtlMs) {
        return cached.result;
    }

    // If already in flight, reuse the same promise
    const inFlight = quotePromiseByKey.get(key);
    if (inFlight) return inFlight;

    const p = (async () => {
        try {
            const data = await new Promise((resolve, reject) => {
                let responded = false;

                const timeout = setTimeout(() => {
                    if (!responded) {
                        responded = true;
                        reject(new Error('Timeout waiting for response from background script'));
                    }
                }, 30000);

                try {
                    // Extension reload / invalid context
                    if (!chrome.runtime || !chrome.runtime.id) {
                        clearTimeout(timeout);
                        responded = true;
                        reject(new Error('Extension context invalidated'));
                        return;
                    }

                    debugRateLog('[TRACE callQuoteAPI -> sendMessage]', {
                        traceId: requestBody?._traceId || null,
                        serviceCode: requestBody?.serviceCode,
                        senderZip: requestBody?.sender?.zip,
                        receiverZip: requestBody?.receiver?.zip
                    });

                    chrome.runtime.sendMessage(
                        { action: 'callQuoteAPI', requestBody },
                        (response) => {
                            if (responded) return;

                            if (chrome.runtime.lastError) {
                                responded = true;
                                clearTimeout(timeout);
                                const msg = chrome.runtime.lastError.message;

                                // Expected during extension reloads
                                if (
                                    msg.includes('Extension context invalidated') ||
                                    msg.includes('message channel closed')
                                ) {
                                    reject(new Error('Extension context invalidated'));
                                } else {
                                    reject(new Error(msg));
                                }
                                return;
                            }

                            responded = true;
                            clearTimeout(timeout);

                            if (!response) {
                                reject(new Error('No response received from background script'));
                                return;
                            }

                            debugRateLog('[TRACE callQuoteAPI <- response]', {
                                traceId: response?.data?._traceId || requestBody?._traceId,
                                success: !!response?.success,
                                cached: !!response?.cached,
                                deduped: !!response?.deduped,
                                hasData: !!response?.data,
                                totalAmount: response?.data?.totalAmount,
                                keys: response?.data ? Object.keys(response.data) : null
                            });

                            if (response.success) {
                                resolve(response.data);
                            } else {
                                reject(new Error(response.error || 'Unknown error'));
                            }
                        }
                    );
                } catch (err) {
                    if (!responded) {
                        responded = true;
                        clearTimeout(timeout);
                        reject(err);
                    }
                }
            });

            // Cache successful result
            quoteResultByKey.set(key, { ts: Date.now(), result: data });

            return data;

        } finally {
            // Always clear in-flight marker so retries work
            quotePromiseByKey.delete(key);
        }
    })();

    quotePromiseByKey.set(key, p);
    return p;
}

// Converts various unit strings to standardized ISO unit codes
function convertToISOUnit(unit) {
    if (!unit || typeof unit !== 'string') {
        return unit;
    }
    const normalized = unit.toLowerCase().trim();
    const unitMap = {
        'lb': 'lb',
        'lbs': 'lb',
        'pound': 'lb',
        'pounds': 'lb',
        'oz': 'oz',
        'ounce': 'oz',
        'ounces': 'oz',
        'kg': 'kg',
        'kilogram': 'kg',
        'kilograms': 'kg',
        'g': 'g',
        'gram': 'g',
        'grams': 'g',
        'in': 'in',
        'inch': 'in',
        'inches': 'in',
        'cm': 'cm',
        'centimeter': 'cm',
        'centimeters': 'cm',
        'ft': 'ft',
        'foot': 'ft',
        'feet': 'ft',
        'm': 'm',
        'meter': 'm',
        'meters': 'm'
    };
    return unitMap[normalized] || unit;
}

async function fetchUpdatedRateForOrder(orderNumber, serviceCode, senderZip) {
    const requestBody = {
        orderNumber,
        serviceCode,
        senderZip
    };
    const resp = await callQuoteAPI(requestBody);
    if (!resp || !resp.success || resp.error) {
        throw new Error(resp?.error || 'Quote API failed');
    }
    return resp?.totalAmount;
}

// Formats a number as USD currency string
function formatCurrency(amount) {
    return '$' + amount.toFixed(2);
}

function getNextSiblingWithClass(element, className) {
    if (!(element instanceof Element)) {
    console.error("Invalid element provided.");
    return null;
    }
    if (typeof className !== "string" || !className.trim()) {
    console.error("Invalid class name provided.");
    return null;
    }

    let sibling = element.nextElementSibling;
    while (sibling) {
    if (sibling.classList.contains(className)) {
        return sibling;
    }
    sibling = sibling.nextElementSibling;
    }
    return null; // No matching sibling found
}

// Generates a stable key for quote requests based on the request body
function makeQuoteRequestKey(body) {  
    // Stable key so equivalent objects map to the same cache entry
    // (Sort keys to avoid JSON.stringify key-order differences)
    const keys = Object.keys(body).sort();
    return JSON.stringify(body, keys);
}

function extractTotalAmountFromQuoteResponse(quoteResponse, serviceCode = null) {
  if (!quoteResponse) return null;

  if (quoteResponse.totalAmount != null) {
    const n = parseFloat(quoteResponse.totalAmount);
    return Number.isFinite(n) ? n : null;
  }

  const quotes = quoteResponse.quotes;
  if (Array.isArray(quotes) && quotes.length) {
    if (serviceCode) {
      const match = quotes.find(q => q.serviceCode === serviceCode);
      if (match?.totalAmount != null) {
        const n = parseFloat(match.totalAmount);
        return Number.isFinite(n) ? n : null;
      }
    }
    const n = parseFloat(quotes[0]?.totalAmount);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function normalizeWeightUnit(unit) {
  return unit?.toLowerCase().startsWith('ounce') ? 'oz' : 'lb';
}

function normalizeDimUnit(unit) {
  return unit?.toLowerCase().startsWith('inch') ? 'in' : 'cm';
}

async function fetchServiceList() {
    if (serviceListCache) return serviceListCache;

    const resp = await fetch(`${location.origin}/api/seller/services`, {
        credentials: "include"
    });

    if (!resp.ok) throw new Error("Failed to fetch service list");

    const data = await resp.json();
    serviceListCache = data;
    return data;
}

async function buildServiceMap() {
    const services = await fetchServiceList();
    // const response = await sendMessageAsync({ 
    //     action: 'fetchServices',
    //     origin: location.origin 
    // });
    // console.log('Service list response', response);
    // const services = response?.data || [];
    // console.log('Fetched service list', services);

    const map = {};

    for (const svc of services) {
        const name = svc.name
            .replace(/[®™]/g, "")
            .trim()
            .toLowerCase();

        map[name] = svc.carrierApiCode;
    }

    return map;
}

async function toServiceCode(serviceLabel) {
    if (!serviceLabel) return null;

    if (!dynamicServiceMap) {
        dynamicServiceMap = await buildServiceMap();
    }

    const s = serviceLabel
        .replace(/[®™]/g, "")
        .trim()
        .toLowerCase();

    // direct match
    if (dynamicServiceMap[s]) return dynamicServiceMap[s];

    // soft match (e.g., “FedEx Ground®”)
    const hit = Object.keys(dynamicServiceMap).find(k => s.includes(k));
    return hit ? dynamicServiceMap[hit] : null;
}

async function fetchShipFromList({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (shipFromCache && (now - shipFromCacheAt) < maxAgeMs) {
    return shipFromCache;
  }

  const url = new URL("/api/seller/shipfrom", window.location.origin).toString();

  const resp = await fetch(url, {
    method: "GET",
    credentials: "include", // important for ShipStation cookies/auth
    headers: {
      "accept": "application/json",
    },
  });

  if (!resp.ok) {
    throw new Error(`shipfrom GET failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error(`shipfrom GET unexpected response type`);
  }

  shipFromCache = data;
  shipFromCacheAt = now;
  return data;
}

// Sends an email notification for quote API/ShipStation UI errors
function sendEmailNotification(orderNumber, serviceCode, errorMessage, rateElement, originalRateValues) {
    // Skip Rate Browser FedEx-by-ShipStation null-serviceCode case
    if (rateElement?.classList?.contains('rate-value-xslVnIC') && !serviceCode) {
        return;
    }

    // Cache key includes serviceCode to avoid collisions
    const emailCacheKey = `${orderNumber}-${serviceCode || 'none'}-${errorMessage}`;

    // Duplicate suppression
    if (emailNotificationCache.has(emailCacheKey)) {
        return;
    }

    emailNotificationCache.add(emailCacheKey);

    // TTL eviction
    setTimeout(() => {
        emailNotificationCache.delete(emailCacheKey);
    }, 5 * 60 * 1000);

    // Extract rate value
    let rateValue = 'N/A';

    if (originalRateValues?.has(rateElement)) {
        rateValue = formatCurrency(originalRateValues.get(rateElement));
    } else {
        const rateText = rateElement?.textContent || '';
        const rateMatch = rateText.match(/\$[\d,]+\.?\d*/);
        rateValue = rateMatch ? rateMatch[0] : 'N/A';
    }

    const pageUrl = window.location.href;

    const baseEmailData = {
        orderNumber: orderNumber || 'N/A',
        errorMessage: errorMessage || 'Quote API failed',
        serviceCode: serviceCode || 'N/A',
        rateValue,
        pageUrl,
        timestamp: new Date().toISOString()
    };

    try {
        if (chrome.runtime?.id) {
            clientEmailAddresses.forEach(toEmail => {
                chrome.runtime.sendMessage({
                    action: 'sendEmailNotification',
                    emailData: { ...baseEmailData, toEmail }
                }, () => {
                    // Optional: log chrome.runtime.lastError during development
                });
            });
        }
    } catch (err) {
        // Optional: log err during development
    }
}