const API_CONFIG = {
    baseUrl: 'https://englandship.rocksolidinternet.com',
    customerId: '20602272',
    apiKey: 'xuPIA6eg6yww4hExnitxZkXqg11pf0pj',
    endpoints: {
        shipments: '/restapi/v1/customers/:customerId/shipments'
    }
};

const EMAILJS_CONFIG = {
    serviceId: 'service_62c7sdm',        // Replace with your EmailJS Service ID
    templateId: 'template_qhuf9ih',      // Replace with your EmailJS Template ID
    publicKey: 'bKonCVnt2BerB3oxS'         // Replace with your EmailJS Public Key
};

class FedExAPI {
    constructor(config) {
        this.baseUrl = config.baseUrl;
        this.customerId = config.customerId;
        this.apiKey = config.apiKey;
    }

    getAuthHeader() {
        return `RSIS ${this.apiKey}`;
    }

    buildUrl(endpoint, params = {}) {
        let url = `${this.baseUrl}${endpoint}`.replace(':customerId', this.customerId);
        
        if (Object.keys(params).length > 0) {
            const queryString = new URLSearchParams(params).toString();
            url += `?${queryString}`;
        }
        
        return url;
    }

    async fetchShipments(queryParams = {}) {
        const defaultParams = {
            minBookNumber: '1',
            limit: '100'
        };
        
        const params = { ...defaultParams, ...queryParams };
        const endpoint = API_CONFIG.endpoints.shipments;
        const url = this.buildUrl(endpoint, params);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.getAuthHeader()
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const data = await response.json();
            
            return {
                success: true,
                data: data
            };
        } catch (error) {
            console.error('Fetch error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// let serviceListCache = null;
const fedExAPI = new FedExAPI(API_CONFIG);

// ---- Quote API governor (prevents 429s) ----
const QUOTE_GOV = {
  minIntervalMs: 900,        // 1 request every ~0.9s (tune if needed)
  cacheTtlMs: 2 * 60 * 1000, // 2 minutes cache
  lastStartTs: 0,
  inFlight: new Map(),       // key -> Promise
  cache: new Map(),          // key -> { ts, payload }
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeQuoteKey(body) {
  // Good enough: stable for identical payloads coming from your content script
  return JSON.stringify(body);
}

async function throttleQuoteStart() {
  const now = Date.now();
  const wait = Math.max(0, QUOTE_GOV.lastStartTs + QUOTE_GOV.minIntervalMs - now);
  if (wait > 0) await sleep(wait);
  QUOTE_GOV.lastStartTs = Date.now();
}

async function fetchQuoteWithBackoff(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttleQuoteStart();

    const res = await fetch(url, options);

    if (res.status !== 429) return res;

    // 429 handling
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? (parseInt(retryAfterHeader, 10) * 1000) : 0;

    // exponential backoff w/ cap (plus small jitter)
    const backoffMs = Math.min(
      8000,
      (retryAfterMs || (500 * Math.pow(2, attempt))) + Math.floor(Math.random() * 250)
    );

    console.warn(`[Background] Quote API 429 - backing off ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
    await sleep(backoffMs);
  }

  // If we got here, we exhausted retries
  return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchShipments') {
        fedExAPI.fetchShipments(request.params || {})
            .then(result => {
                sendResponse(result);
            })
            .catch(error => {
                console.error('API Error', error);
                sendResponse({
                    success: false,
                    error: error.message
                });
            });
        
        return true;
    // } else if (request.action == 'fetchServices') {
    //     if (serviceListCache) {
    //         sendResponse({ success: true, data: serviceListCache });
    //         return true;
    //     }
    //     fetch(`${request.origin}/api/seller/services`, {
    //         method: 'GET',
    //         // credentials: "include",
    //         headers: {
    //             'Content-Type': 'application/json'
    //         }
    //     }).then(response => {
    //         if (!response.ok) throw new Error("Failed to fetch service list");
    //         const data = response.json();
    //         serviceListCache = data;
    //         sendResponse({ success: true, data: data });
    //     }).catch(error => {
    //         console.error('[Background] Fetch Services API error:', error);
    //         sendResponse({
    //             success: false,
    //             error: error.message
    //         });
    //     });
    } else if (request.action == 'getOrderGrids') {
        const orderNumber = request.orderNumber || null;
        const payload = {
            page: { pageNumber: 1, pageSize: 250 },
            filter: {
                orderGridStatus: "AwaitingShipment"
            },
            orderBys: [{ orderBy: "OrderNumber", orderByDirection: "Ascending" }],
            includeQueryCount: true
        };
        if (request.orderNumber) payload.searchTerm = String(orderNumber);
        fetch(`${request.origin}/api/ordergrid/shipmentmode/simple`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(response => response.json())
        .then(json => { 
            sendResponse({ success: true, data: json });
        }).catch(error => {
            console.error('[Background] Get Shipments API fetch error:', error);
            sendResponse({
                success: false,
                error: error.message
            });
        });

        return true;
    } else if (request.action == 'getShipmentGrids') {
        const payload = {
            page: { pageNumber: 1, pageSize: 250 },
            filter: {
            booleanFilters: [{ column: "IsVoid", value: false }]
            },
            searchTerm: ""
        };
        fetch(`${request.origin}/api/shippinggrid/simple`, {
            method: 'POST',
            // credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(response => response.json())
        .then(json => { 
            const f = json.fulfillments?.find(x =>
                String(x.fulfillmentPlanId) === String(request.fulfillmentId)
            );

            const fps = json.fulfillmentPlans || [];
            const fulfillmentPlan = fps.find(fp =>
                String(fp.fulfillmentPlanId || fp.id || '') === String(request.fulfillmentId)
            ) || fps[0];
            

            if (!f) throw new Error('Shipment not found');

            const pkg = f.packages?.[0];
            const shipFrom = f.labelFulfillment?.shipFrom?.originAddress;
            const shipTo = f.labelFulfillment?.shipTo;

            const labelConfig = fulfillmentPlan?.labelConfiguration || {};
            const fpOptions = labelConfig?.options || {};

            let signatureOptionCode = null;
            switch (fpOptions.confirmation) {
                case 'Delivery':
                    signatureOptionCode = 'DIRECT';
                    break;
                case 'Adult':
                    signatureOptionCode = 'ADULT';
                    break;
                case 'Indirect':
                    signatureOptionCode = 'INDIRECT';
                    break;
                case 'None':
                default:
                    signatureOptionCode = null;
            }

            const firstPkg = (labelConfig.packages && labelConfig.packages[0]) ? labelConfig.packages[0] : null;
            const insuredCode = firstPkg?.insuredValue?.code || null;
            const postagePaidCode = labelConfig?.customs?.postagePaid?.code || null;
            
            const rateCode = fulfillmentPlan?.rateSummary?.rate?.totalCost?.code || null;
            const currency = rateCode || insuredCode || 'USD';
            const customsCurrency = postagePaidCode || currency;

            data = {
                // json: json,
                residential: (shipTo?.residentialIndicator || '')?.toLowerCase() === 'residential',
                signatureOptionCode,
                currency,
                customsCurrency,

                senderZip: shipFrom?.postalCode,
                senderCountry: shipFrom?.countryCode || 'US',

                receiverZip: f.labelFulfillment?.shipTo?.postalCode,
                receiverCountry: f.labelFulfillment?.shipTo?.countryCode || 'US',

                weightUnit: pkg?.weight?.unit,
                weightValue: pkg?.weight?.value,

                dimUnit: pkg?.dimensions?.unit,
                length: pkg?.dimensions?.length,
                width: pkg?.dimensions?.width,
                height: pkg?.dimensions?.height,

                insuranceAmount: pkg?.insuredValue?.value ?? null,

                carrierId: f.labelFulfillment?.carrierId,
                serviceId: f.labelFulfillment?.serviceId,

                confirmation: f.confirmationType || null
            };
            sendResponse({ success: true, data: data });
        }).catch(error => {
            console.error('[Background] Get Shipments API fetch error:', error);
            sendResponse({
                success: false,
                error: error.message
            });
        });

        return true;
    } else if (request.action === 'getServices') {
        const API_CONFIG = {
            baseUrl: 'https://englandship.rocksolidinternet.com',
            customerId: '20602272',
            apiKey: 'xuPIA6eg6yww4hExnitxZkXqg11pf0pj'
        };

        const url = `${API_CONFIG.baseUrl}/restapi/v1/customers/${API_CONFIG.customerId}/services`;
        
        console.log('[Background] Calling Services API:', url);

        fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `RSIS ${API_CONFIG.apiKey}`
            }
        })
        .then(response => {
            if (!response.ok) {
                return response.text().then(errorText => {
                    console.error('[Background] Services API error:', response.status, errorText);
                    sendResponse({
                        success: false,
                        error: `API error: ${response.status} - ${errorText}`
                    });
                });
            }
            return response.json().then(data => {
                console.log('[Background] Services API response received');
                sendResponse({
                    success: true,
                    data: data
                });
            });
        })
        .catch(error => {
            console.error('[Background] Services API fetch error:', error);
            sendResponse({
                success: false,
                error: error.message
            });
        });
        
        return true;
    } else if (request.action === 'callQuoteAPI') {
        const API_CONFIG = {
            baseUrl: 'https://englandship.rocksolidinternet.com',
            customerId: '20602272',
            apiKey: 'xuPIA6eg6yww4hExnitxZkXqg11pf0pj'
        };

        const url = `${API_CONFIG.baseUrl}/restapi/v1/customers/${API_CONFIG.customerId}/quote`;
        const key = makeQuoteKey(request.requestBody);

        // 1) Cache (fast return)
        const cached = QUOTE_GOV.cache.get(key);
        if (cached && (Date.now() - cached.ts) < QUOTE_GOV.cacheTtlMs) {
            console.log('[Background] Quote API cache hit');
            sendResponse({ success: true, data: cached.payload, cached: true });
            return true;
        }

        // 2) In-flight de-dupe (if the same payload is already being fetched, reuse it)
        const existing = QUOTE_GOV.inFlight.get(key);
        if (existing) {
            console.log('[Background] Quote API de-dupe (reusing in-flight request)');
            existing
            .then(data => sendResponse({ success: true, data, deduped: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }

        console.log('[Background] Calling Quote API:', url);

        const options = {
            method: 'POST',
            headers: {
            'Content-Type': 'application/json',
            'Authorization': `RSIS ${API_CONFIG.apiKey}`
            },
            body: JSON.stringify(request.requestBody)
        };

        const p = (async () => {
            const res = await fetchQuoteWithBackoff(url, options, 3);
            if (!res) throw new Error('API error: 429 (retries exhausted)');

            if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`API error: ${res.status} - ${errorText}`);
            }

            const data = await res.json();

            // Save to cache
            QUOTE_GOV.cache.set(key, { ts: Date.now(), payload: data });

            return data;
        })();

        QUOTE_GOV.inFlight.set(key, p);

        p.then(data => {
            sendResponse({ success: true, data });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        }).finally(() => {
            QUOTE_GOV.inFlight.delete(key);
        });

        return true;
    } else if (request.action === 'sendEmailNotification') {
        console.log('[Background] ========== Email Notification Request Received ==========');
        console.log('[Background] Email data:', JSON.stringify(request.emailData, null, 2));
        
        // Send email notification when quote API fails (non-blocking)
        // Don't wait for response - fire and forget
        sendEmailNotification(request.emailData)
            .then(result => {
                console.log('[Background] Email notification result:', result);
                if (result.success) {
                    console.log('[Background] ✓ Email sent successfully!');
                    // Also send message to content script to show in page console
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) {
                            chrome.tabs.sendMessage(tabs[0].id, {
                                action: 'emailStatus',
                                success: true,
                                message: 'Email sent successfully to inbox'
                            }).catch(() => {
                                // Ignore errors if content script not ready
                            });
                        }
                    });
                } else {
                    console.error('[Background] ✗ Email failed to send:', result.error);
                    // Send error message to content script to show in page console
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) {
                            chrome.tabs.sendMessage(tabs[0].id, {
                                action: 'emailStatus',
                                success: false,
                                error: result.error
                            }).catch(() => {
                                // Ignore errors if content script not ready
                            });
                        }
                    });
                }
            })
            .catch(error => {
                console.error('[Background] Email notification error:', error);
                // Send error message to content script
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            action: 'emailStatus',
                            success: false,
                            error: error.message
                        }).catch(() => {
                            // Ignore errors if content script not ready
                        });
                    }
                });
            });
        
        // Return immediately without waiting
        sendResponse({ success: true });
        return true;
    } else {
        sendResponse({ success: false, error: 'Unknown action' });
    }
});

// Email notification function - Uses EmailJS to send emails directly to Gmail inbox
// Setup Instructions (5 minutes):
// 1. Go to https://www.emailjs.com/ and create a free account
// 2. Go to Email Services and add Gmail (or any email service)
// 3. Go to Email Templates and create a new template with these variables:
//    - {{to_email}}
//    - {{subject}}
//    - {{message}}
// 4. Copy your Service ID, Template ID, and Public Key
// 5. Paste them inside in EMAILJS_CONFIG
async function sendEmailNotification(emailData) {
    console.log('[Background] ========== sendEmailNotification called ==========');
    console.log('[Background] Email data received:', emailData);
    
    try {
        // Validate email data
        if (!emailData || !emailData.toEmail) {
            console.error('[Background] ✗ Missing email data or recipient');
            return {
                success: false,
                error: 'Missing email data or recipient'
            };
        }
        
        console.log('[Background] Recipient email:', emailData.toEmail);
        
        // Check if EmailJS is configured
        console.log('[Background] Checking EmailJS configuration...');
        console.log('[Background] Service ID:', EMAILJS_CONFIG.serviceId);
        console.log('[Background] Template ID:', EMAILJS_CONFIG.templateId);
        console.log('[Background] Public Key:', EMAILJS_CONFIG.publicKey ? '***' + EMAILJS_CONFIG.publicKey.slice(-4) : 'NOT SET');
        
        if (EMAILJS_CONFIG.serviceId === 'YOUR_SERVICE_ID' || 
            EMAILJS_CONFIG.templateId === 'YOUR_TEMPLATE_ID' || 
            EMAILJS_CONFIG.publicKey === 'YOUR_PUBLIC_KEY') {
            console.error('[Background] ✗ EmailJS not configured! Please set up EmailJS credentials in background.js');
            console.error('[Background] Current config:', EMAILJS_CONFIG);
            return {
                success: false,
                error: 'EmailJS not configured. Please set up EmailJS credentials in background.js'
            };
        }
        
        console.log('[Background] ✓ EmailJS configuration looks good');
        
        // Prepare email content
        const subject = 'FedEx Quote API Failure Notification';
        const message = `Quote API failed for order ${emailData.orderNumber || 'N/A'}\n\n` +
                       `Error: ${emailData.errorMessage || 'Unknown error'}\n` +
                       `Service Code: ${emailData.serviceCode || 'N/A'}\n` +
                       `Rate Value: ${emailData.rateValue || 'N/A'}\n` +
                       `Timestamp: ${emailData.timestamp || new Date().toISOString()}\n` +
                       `URL: ${emailData.pageUrl || 'N/A'}`;
        
        console.log('[Background] Email subject:', subject);
        console.log('[Background] Email message length:', message.length);
        
        // Send email via EmailJS API
        const emailjsUrl = 'https://api.emailjs.com/api/v1.0/email/send';
        
        const emailPayload = {
            service_id: EMAILJS_CONFIG.serviceId,
            template_id: EMAILJS_CONFIG.templateId,
            user_id: EMAILJS_CONFIG.publicKey,
            template_params: {
                to_email: emailData.toEmail,
                subject: subject,
                message: message
            }
        };
        
        console.log('[Background] Sending email to EmailJS API...');
        console.log('[Background] EmailJS URL:', emailjsUrl);
        console.log('[Background] Email payload (without sensitive data):', {
            service_id: emailPayload.service_id,
            template_id: emailPayload.template_id,
            user_id: '***' + emailPayload.user_id.slice(-4),
            template_params: emailPayload.template_params
        });
        
        const response = await fetch(emailjsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(emailPayload)
        });
        
        console.log('[Background] EmailJS API response status:', response.status);
        console.log('[Background] EmailJS API response ok:', response.ok);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Background] ✗ EmailJS API error response:', errorText);
            console.error('[Background] Response status:', response.status);
            return {
                success: false,
                error: `EmailJS API error: ${response.status} - ${errorText}`
            };
        }
        
        // EmailJS sometimes returns "OK" as plain text instead of JSON
        const responseText = await response.text();
        console.log('[Background] EmailJS API response text:', responseText);
        
        let responseData;
        try {
            responseData = JSON.parse(responseText);
            console.log('[Background] EmailJS API response data (parsed JSON):', responseData);
        } catch (parseError) {
            // If it's not JSON, check if it's a success message like "OK"
            if (responseText.trim().toUpperCase() === 'OK' || response.status === 200) {
                console.log('[Background] EmailJS API returned plain text success message');
                responseData = { status: 'success', text: responseText };
            } else {
                console.warn('[Background] EmailJS API response is not JSON and not "OK":', responseText);
                responseData = { status: 'unknown', text: responseText };
            }
        }
        
        console.log('[Background] ✓ Email sent successfully to inbox!');
        console.log('[Background] ============================================');
        
        return {
            success: true,
            message: 'Email sent successfully to inbox'
        };
        
    } catch (error) {
        console.error('[Background] ✗ Exception in sendEmailNotification:', error);
        console.error('[Background] Error message:', error.message);
        console.error('[Background] Error stack:', error.stack);
        return {
            success: false,
            error: error.message
        };
    }
}
