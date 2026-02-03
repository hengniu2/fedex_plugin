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
    console.log('[Helper] ============================================');
    console.log('[Helper] FUNCTION: fetchServiceList() called');
    console.log('[Helper] ============================================');
    
    if (serviceListCache) {
        console.log('[Helper] STEP 1: Cache Check - HIT');
        console.log('[Helper]   - Using cached service list');
        console.log('[Helper]   - Cached services count:', serviceListCache?.length || 0);
        console.log('[Helper]   - Cache type:', Array.isArray(serviceListCache) ? 'array' : typeof serviceListCache);
        console.log('[Helper] ============================================');
        return serviceListCache;
    }

    console.log('[Helper] STEP 1: Cache Check - MISS');
    console.log('[Helper]   - No cache found, fetching from API');
    
    console.log('[Helper] STEP 2: Preparing message to background script');
    const message = { action: 'getServices' };
    console.log('[Helper]   - Message:', JSON.stringify(message, null, 2));
    
    console.log('[Helper] STEP 3: Calling sendMessageAsync...');
    console.log('[Helper]   - Waiting for background script response...');
    
    // Use the getServices action from background.js
    const response = await sendMessageAsync(message);
    
    console.log('[Helper] STEP 4: Response received from background script');
    console.log('[Helper]   - Full Response Object:', JSON.stringify(response, null, 2));
    console.log('[Helper]   - Response Properties:');
    console.log('[Helper]     * success:', response?.success);
    console.log('[Helper]     * hasData:', !!response?.data);
    console.log('[Helper]     * dataType:', Array.isArray(response?.data) ? 'array' : typeof response?.data);
    console.log('[Helper]     * dataLength:', Array.isArray(response?.data) ? response.data.length : 'N/A');
    console.log('[Helper]     * error:', response?.error);
    
    if (!response?.success || !response?.data) {
        console.error('[Helper] STEP 5: ❌ Response Validation FAILED');
        console.error('[Helper]   - Success:', response?.success);
        console.error('[Helper]   - Has Data:', !!response?.data);
        console.error('[Helper]   - Error:', response?.error);
        console.error('[Helper]   - Full Response:', response);
        throw new Error(response?.error || "Failed to fetch service list");
    }

    console.log('[Helper] STEP 5: Response Validation PASSED');
    const data = response.data;
    
    console.log('[Helper] STEP 6: Processing response data');
    console.log('[Helper]   - Data Type:', Array.isArray(data) ? 'ARRAY' : typeof data);
    console.log('[Helper]   - Data Keys (if object):', !Array.isArray(data) && data ? Object.keys(data) : 'N/A');
    
    // Handle response structure: could be array directly or wrapped in {services: [...]}
    let servicesArray = null;
    
    if (Array.isArray(data)) {
        console.log('[Helper] STEP 7: Data is array - using directly');
        servicesArray = data;
    } else if (data && typeof data === 'object' && data.services) {
        console.log('[Helper] STEP 7: Data is object with "services" property');
        console.log('[Helper]   - Extracting services array from data.services');
        servicesArray = data.services;
        console.log('[Helper]   - services array length:', Array.isArray(servicesArray) ? servicesArray.length : 'N/A');
    } else {
        console.log('[Helper] STEP 7: Unknown data structure');
        console.log('[Helper]   - Full Data:', JSON.stringify(data, null, 2));
    }
    
    if (servicesArray && Array.isArray(servicesArray)) {
        console.log('[Helper] STEP 8: Services array extracted');
        console.log('[Helper]   - Services count:', servicesArray.length);
        console.log('[Helper]   - Showing all services:');
        servicesArray.forEach((svc, idx) => {
            console.log(`[Helper]   Service [${idx + 1}]:`, JSON.stringify(svc, null, 2));
        });
    } else {
        console.error('[Helper] STEP 8: ❌ Could not extract services array');
        console.error('[Helper]   - servicesArray:', servicesArray);
        console.error('[Helper]   - Is Array:', Array.isArray(servicesArray));
    }
    
    console.log('[Helper] STEP 9: Caching service list');
    serviceListCache = servicesArray || data;
    console.log('[Helper]   - Cache stored:', Array.isArray(serviceListCache) ? serviceListCache.length : 0, 'services');
    console.log('[Helper]   - Cache type:', Array.isArray(serviceListCache) ? 'array' : typeof serviceListCache);
    console.log('[Helper] ============================================');
    return servicesArray || data;
}

async function buildServiceMap() {
    console.log('[Helper] ============================================');
    console.log('[Helper] FUNCTION: buildServiceMap() called');
    console.log('[Helper] ============================================');
    
    console.log('[Helper] STEP 1: Fetching service list...');
    const services = await fetchServiceList();
    
    console.log('[Helper] STEP 2: Validating service list');
    console.log('[Helper]   - Is Array:', Array.isArray(services));
    console.log('[Helper]   - Type:', typeof services);
    console.log('[Helper]   - Value:', services);
    
    if (!Array.isArray(services)) {
        console.error('[Helper] STEP 2a: ❌ VALIDATION FAILED');
        console.error('[Helper]   - Expected: Array');
        console.error('[Helper]   - Got:', typeof services);
        console.error('[Helper]   - Value:', JSON.stringify(services, null, 2));
        return {};
    }

    console.log('[Helper] STEP 2a: ✓ VALIDATION PASSED');
    console.log('[Helper]   - Services count:', services.length);
    
    console.log('[Helper] STEP 3: Initializing map object');
    const map = {};
    let skippedCount = 0;
    let mappedCount = 0;

    console.log('[Helper] STEP 4: Processing each service...');
    console.log('[Helper]   - Starting loop for', services.length, 'services');
    
    for (let i = 0; i < services.length; i++) {
        const svc = services[i];
        console.log(`[Helper] ────────────────────────────────────────`);
        console.log(`[Helper] STEP 4.${i + 1}: Processing service ${i + 1}/${services.length}`);
        console.log(`[Helper]   - Full Service Object:`, JSON.stringify(svc, null, 2));
        console.log(`[Helper]   - Service Keys:`, Object.keys(svc));
        
        // Map serviceLabel to serviceCode
        // The API response has 'serviceLabel' and 'serviceCode' properties directly
        console.log(`[Helper]   STEP 4.${i + 1}.a: Extracting serviceLabel`);
        console.log(`[Helper]     - svc.serviceLabel:`, svc.serviceLabel);
        console.log(`[Helper]     - svc.name:`, svc.name);
        console.log(`[Helper]     - svc.label:`, svc.label);
        const serviceLabel = svc.serviceLabel || svc.name || svc.label || svc.serviceName;
        console.log(`[Helper]     - RESULT serviceLabel (raw):`, serviceLabel);
        console.log(`[Helper]     - serviceLabel type:`, typeof serviceLabel);
        console.log(`[Helper]     - serviceLabel truthy:`, !!serviceLabel);
        
        console.log(`[Helper]   STEP 4.${i + 1}.b: Extracting serviceCode`);
        console.log(`[Helper]     - svc.serviceCode:`, svc.serviceCode);
        console.log(`[Helper]     - svc.code:`, svc.code);
        console.log(`[Helper]     - svc.carrierApiCode:`, svc.carrierApiCode);
        const serviceCode = svc.serviceCode || svc.code || svc.carrierApiCode || svc.apiCode;
        console.log(`[Helper]     - RESULT serviceCode (raw):`, serviceCode);
        console.log(`[Helper]     - serviceCode type:`, typeof serviceCode);
        console.log(`[Helper]     - serviceCode truthy:`, !!serviceCode);
        
        if (!serviceLabel || !serviceCode) {
            console.warn(`[Helper]   STEP 4.${i + 1}.c: ⚠️ SKIPPING - Missing data`);
            console.warn(`[Helper]     - Has Label:`, !!serviceLabel, `(${serviceLabel})`);
            console.warn(`[Helper]     - Has Code:`, !!serviceCode, `(${serviceCode})`);
            console.warn(`[Helper]     - Full Service Object:`, JSON.stringify(svc, null, 2));
            skippedCount++;
            continue;
        }

        console.log(`[Helper]   STEP 4.${i + 1}.c: ✓ Data validation passed`);
        
        // Normalize the service label (remove special chars, lowercase)
        console.log(`[Helper]   STEP 4.${i + 1}.d: Normalizing serviceLabel`);
        console.log(`[Helper]     - Original:`, serviceLabel);
        const step1 = serviceLabel.replace(/[®™]/g, "");
        console.log(`[Helper]     - After removing ®™:`, step1);
        const step2 = step1.trim();
        console.log(`[Helper]     - After trim:`, step2);
        const normalizedLabel = step2.toLowerCase();
        console.log(`[Helper]     - After toLowerCase:`, normalizedLabel);
        console.log(`[Helper]     - FINAL normalizedLabel:`, normalizedLabel);
        
        console.log(`[Helper]   STEP 4.${i + 1}.e: Adding to map`);
        console.log(`[Helper]     - Key:`, normalizedLabel);
        console.log(`[Helper]     - Value:`, serviceCode);
        map[normalizedLabel] = serviceCode;
        mappedCount++;
        console.log(`[Helper]   STEP 4.${i + 1}.f: ✓ MAPPED: "${normalizedLabel}" -> "${serviceCode}"`);
    }

    console.log('[Helper] ────────────────────────────────────────');
    console.log('[Helper] STEP 5: Mapping Complete - Summary');
    console.log('[Helper] ========== SERVICE MAP SUMMARY ==========');
    console.log('[Helper]   - Total services processed:', services.length);
    console.log('[Helper]   - Successfully mapped:', mappedCount);
    console.log('[Helper]   - Skipped:', skippedCount);
    console.log('[Helper]   - Map entries:', Object.keys(map).length);
    console.log('[Helper]   - Map object:', JSON.stringify(map, null, 2));
    console.log('[Helper]   - All mappings:');
    Object.entries(map).forEach(([key, value], idx) => {
        console.log(`[Helper]     [${idx + 1}] "${key}" -> "${value}"`);
    });
    console.log('[Helper] =========================================');
    
    console.log('[Helper] STEP 6: Storing map in dynamicServiceMap');
    dynamicServiceMap = map;
    console.log('[Helper]   - dynamicServiceMap set:', !!dynamicServiceMap);
    console.log('[Helper]   - dynamicServiceMap keys:', Object.keys(dynamicServiceMap).length);
    console.log('[Helper] ============================================');
    return map;
}

async function toServiceCode(serviceLabel) {
    console.log('[Helper] ============================================');
    console.log('[Helper] FUNCTION: toServiceCode() called');
    console.log('[Helper] ============================================');
    
    console.log('[Helper] STEP 1: Input Validation');
    console.log('[Helper]   - Input serviceLabel (raw):', serviceLabel);
    console.log('[Helper]   - Input type:', typeof serviceLabel);
    console.log('[Helper]   - Input truthy:', !!serviceLabel);
    console.log('[Helper]   - Input length:', serviceLabel?.length);
    
    if (!serviceLabel) {
        console.warn('[Helper] STEP 1a: ❌ VALIDATION FAILED');
        console.warn('[Helper]   - serviceLabel is null/undefined/empty');
        console.warn('[Helper]   - Returning null');
        console.log('[Helper] ============================================');
        return null;
    }

    console.log('[Helper] STEP 1a: ✓ VALIDATION PASSED');
    
    console.log('[Helper] STEP 2: Checking service map initialization');
    console.log('[Helper]   - dynamicServiceMap exists:', !!dynamicServiceMap);
    console.log('[Helper]   - dynamicServiceMap type:', typeof dynamicServiceMap);
    console.log('[Helper]   - dynamicServiceMap keys count:', dynamicServiceMap ? Object.keys(dynamicServiceMap).length : 0);
    
    if (!dynamicServiceMap) {
        console.log('[Helper] STEP 2a: Service map not initialized');
        console.log('[Helper]   - Building service map now...');
        dynamicServiceMap = await buildServiceMap();
        console.log('[Helper]   - Service map built, keys count:', Object.keys(dynamicServiceMap).length);
    } else {
        console.log('[Helper] STEP 2a: ✓ Service map already initialized');
    }

    if (!dynamicServiceMap || Object.keys(dynamicServiceMap).length === 0) {
        console.warn('[Helper] STEP 2b: ❌ Service map is EMPTY');
        console.warn('[Helper]   - Cannot map service label:', serviceLabel);
        console.warn('[Helper]   - Map state:', {
            exists: !!dynamicServiceMap,
            isObject: typeof dynamicServiceMap === 'object',
            keys: dynamicServiceMap ? Object.keys(dynamicServiceMap).length : 0,
            mapValue: dynamicServiceMap
        });
        console.log('[Helper] ============================================');
        return null;
    }

    console.log('[Helper] STEP 2b: ✓ Service map is ready');
    console.log('[Helper]   - Map has', Object.keys(dynamicServiceMap).length, 'entries');
    console.log('[Helper]   - All map keys:', Object.keys(dynamicServiceMap));
    
    console.log('[Helper] STEP 3: Normalizing input serviceLabel');
    console.log('[Helper]   - Original:', serviceLabel);
    const step1 = serviceLabel.replace(/[®™]/g, "");
    console.log('[Helper]   - After removing ®™:', step1);
    const step2 = step1.trim();
    console.log('[Helper]   - After trim:', step2);
    const s = step2.toLowerCase();
    console.log('[Helper]   - After toLowerCase:', s);
    console.log('[Helper]   - FINAL normalized:', s);

    console.log('[Helper] STEP 4: Attempting DIRECT match');
    console.log('[Helper]   - Looking for key:', s);
    console.log('[Helper]   - Key exists in map:', s in dynamicServiceMap);
    const directMatch = dynamicServiceMap[s];
    console.log('[Helper]   - Direct match result:', directMatch);
    
    if (directMatch) {
        console.log('[Helper] STEP 4a: ✓ DIRECT MATCH FOUND!');
        console.log('[Helper]   - Input:', serviceLabel);
        console.log('[Helper]   - Normalized:', s);
        console.log('[Helper]   - Service Code:', directMatch);
        console.log('[Helper]   - Mapping: "' + s + '" -> "' + directMatch + '"');
        console.log('[Helper] ============================================');
        return directMatch;
    }
    
    console.log('[Helper] STEP 4a: ❌ No direct match');
    console.log('[Helper]   - Tried key:', s);
    console.log('[Helper]   - Key not found in map');

    console.log('[Helper] STEP 5: Attempting SOFT match');
    const mapKeys = Object.keys(dynamicServiceMap);
    console.log('[Helper]   - Total map keys:', mapKeys.length);
    console.log('[Helper]   - All map keys:', mapKeys);
    console.log('[Helper]   - Searching for keys that are contained in:', s);
    
    const matchingKeys = mapKeys.filter(k => s.includes(k));
    console.log('[Helper]   - Keys that match (contained in input):', matchingKeys);
    
    if (matchingKeys.length > 0) {
        console.log('[Helper]   - Found', matchingKeys.length, 'matching keys');
        matchingKeys.forEach((key, idx) => {
            console.log(`[Helper]     [${idx + 1}] Key: "${key}" -> Value: "${dynamicServiceMap[key]}"`);
        });
    }
    
    const hit = mapKeys.find(k => s.includes(k));
    console.log('[Helper]   - First matching key:', hit);
    
    if (hit) {
        const softMatch = dynamicServiceMap[hit];
        console.log('[Helper] STEP 5a: ✓ SOFT MATCH FOUND!');
        console.log('[Helper]   - Input:', serviceLabel);
        console.log('[Helper]   - Normalized:', s);
        console.log('[Helper]   - Matched Key:', hit);
        console.log('[Helper]   - Service Code:', softMatch);
        console.log('[Helper]   - Mapping: "' + hit + '" -> "' + softMatch + '"');
        console.log('[Helper]   - Reason: Input "' + s + '" contains key "' + hit + '"');
        console.log('[Helper] ============================================');
        return softMatch;
    }
    
    console.log('[Helper] STEP 5a: ❌ No soft match found');
    
    console.log('[Helper] STEP 6: ❌ NO MATCH FOUND (Summary)');
    console.log('[Helper]   - Input (raw):', serviceLabel);
    console.log('[Helper]   - Input (normalized):', s);
    console.log('[Helper]   - Map has', mapKeys.length, 'keys');
    console.log('[Helper]   - All available keys:');
    mapKeys.forEach((key, idx) => {
        const value = dynamicServiceMap[key];
        console.log(`[Helper]     [${idx + 1}] "${key}" -> "${value}"`);
    });
    console.log('[Helper]   - Comparison:');
    console.log('[Helper]     * Input normalized:', JSON.stringify(s));
    mapKeys.forEach((key, idx) => {
        const contains = s.includes(key);
        const reverseContains = key.includes(s);
        console.log(`[Helper]     * Key [${idx + 1}] "${key}": input contains key=${contains}, key contains input=${reverseContains}`);
    });
    console.log('[Helper] ============================================');
    return null;
}

// Expose functions globally for content.js to use
window.buildServiceMap = buildServiceMap;
window.toServiceCode = toServiceCode;
window.getDynamicServiceMap = () => dynamicServiceMap;

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