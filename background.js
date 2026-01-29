const API_CONFIG = {
    baseUrl: 'https://englandship.rocksolidinternet.com',
    customerId: '20602272',
    apiKey: 'xuPIA6eg6yww4hExnitxZkXqg11pf0pj',
    endpoints: {
        shipments: '/restapi/v1/customers/:customerId/shipments'
    }
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
            // console.error('Fetch error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

const fedExAPI = new FedExAPI(API_CONFIG);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchShipments') {
        fedExAPI.fetchShipments(request.params || {})
            .then(result => {
                sendResponse(result);
            })
            .catch(error => {
                // console.error('API Error', error);
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
        
        // console.log('[Background] Calling Services API:', url);

        fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `RSIS ${API_CONFIG.apiKey}`
            }
        })
        .then(response => {
            // console.log('[Background] Services API response status:', response.status);
            if (!response.ok) {
                return response.text().then(errorText => {
                    // console.error('[Background] Services API error:', response.status, errorText);
                    sendResponse({
                        success: false,
                        error: `API error: ${response.status} - ${errorText}`
                    });
                });
            }
            return response.json().then(data => {
                // console.log('[Background] Services API response received');
                sendResponse({
                    success: true,
                    data: data
                });
            });
        })
        .catch(error => {
            // console.error('[Background] Services API fetch error:', error);
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
        
        // console.log('[Background] Calling Quote API:', url);
        // console.log('[Background] Request body:', JSON.stringify(request.requestBody, null, 2));

        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `RSIS ${API_CONFIG.apiKey}`
            },
            body: JSON.stringify(request.requestBody)
        })
        .then(response => {
            // console.log('[Background] Quote API response status:', response.status);
            if (!response.ok) {
                return response.text().then(errorText => {
                    // console.error('[Background] Quote API error:', response.status, errorText);
                    sendResponse({
                        success: false,
                        error: `API error: ${response.status} - ${errorText}`
                    });
                });
            }
            return response.json().then(data => {
                // console.log('[Background] ========== Quote API Response ==========');
                // console.log('[Background] Response status: SUCCESS');
                // console.log('[Background] Response data:', JSON.stringify(data, null, 2));
                
                if (data.totalAmount) {
                    // console.log('[Background] ✓ Single service response - totalAmount:', data.totalAmount);
                } else if (data.quotes && Array.isArray(data.quotes)) {
                    // console.log('[Background] ✓ Multi-service response - quotes count:', data.quotes.length);
                    data.quotes.forEach((quote, idx) => {
                        // console.log(`[Background]   Quote ${idx + 1}: serviceCode="${quote.serviceCode}", totalAmount="${quote.totalAmount}"`);
                    });
                }
                // console.log('[Background] ============================================');
                
                sendResponse({
                    success: true,
                    data: data
                });
            });
        })
        .catch(error => {
            // console.error('[Background] Quote API fetch error:', error);
            sendResponse({
                success: false,
                error: error.message
            });
        });
        
        return true;
    } else if (request.action === 'sendEmailNotification') {
        // console.log('[Background] ========== Email Notification Request Received ==========');
        // console.log('[Background] Email data:', JSON.stringify(request.emailData, null, 2));
        
        // Send email notification when quote API fails (non-blocking)
        // Don't wait for response - fire and forget
        sendEmailNotification(request.emailData)
            .then(result => {
                // console.log('[Background] Email notification result:', result);
                if (result.success) {
                    // console.log('[Background] ✓ Email sent successfully!');
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
                    // console.error('[Background] ✗ Email failed to send:', result.error);
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
                // console.error('[Background] Email notification error:', error);
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
// 5. Paste them below in EMAILJS_CONFIG
const EMAILJS_CONFIG = {
    serviceId: 'service_62c7sdm',        // Replace with your EmailJS Service ID
    templateId: 'template_qhuf9ih',      // Replace with your EmailJS Template ID
    publicKey: 'bKonCVnt2BerB3oxS'         // Replace with your EmailJS Public Key
};

async function sendEmailNotification(emailData) {
    // console.log('[Background] ========== sendEmailNotification called ==========');
    // console.log('[Background] Email data received:', emailData);
    
    try {
        // Validate email data
        if (!emailData || !emailData.toEmail) {
            // console.error('[Background] ✗ Missing email data or recipient');
            return {
                success: false,
                error: 'Missing email data or recipient'
            };
        }
        
        // console.log('[Background] Recipient email:', emailData.toEmail);
        
        // Check if EmailJS is configured
        // console.log('[Background] Checking EmailJS configuration...');
        // console.log('[Background] Service ID:', EMAILJS_CONFIG.serviceId);
        // console.log('[Background] Template ID:', EMAILJS_CONFIG.templateId);
        // console.log('[Background] Public Key:', EMAILJS_CONFIG.publicKey ? '***' + EMAILJS_CONFIG.publicKey.slice(-4) : 'NOT SET');
        
        if (EMAILJS_CONFIG.serviceId === 'YOUR_SERVICE_ID' || 
            EMAILJS_CONFIG.templateId === 'YOUR_TEMPLATE_ID' || 
            EMAILJS_CONFIG.publicKey === 'YOUR_PUBLIC_KEY') {
            // console.error('[Background] ✗ EmailJS not configured! Please set up EmailJS credentials in background.js');
            // console.error('[Background] Current config:', EMAILJS_CONFIG);
            return {
                success: false,
                error: 'EmailJS not configured. Please set up EmailJS credentials in background.js'
            };
        }
        
        // console.log('[Background] ✓ EmailJS configuration looks good');
        
        // Prepare email content
        const subject = 'FedEx Quote API Failure Notification';
        const message = `Quote API failed for order ${emailData.orderNumber || 'N/A'}\n\n` +
                       `Error: ${emailData.errorMessage || 'Unknown error'}\n` +
                       `Service Code: ${emailData.serviceCode || 'N/A'}\n` +
                       `Rate Value: ${emailData.rateValue || 'N/A'}\n` +
                       `Timestamp: ${emailData.timestamp || new Date().toISOString()}\n` +
                       `URL: ${emailData.pageUrl || 'N/A'}`;
        
        // console.log('[Background] Email subject:', subject);
        // console.log('[Background] Email message length:', message.length);
        
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
        
        // console.log('[Background] Sending email to EmailJS API...');
        // console.log('[Background] EmailJS URL:', emailjsUrl);
        // console.log('[Background] Email payload (without sensitive data):', {
        //     service_id: emailPayload.service_id,
        //     template_id: emailPayload.template_id,
        //     user_id: '***' + emailPayload.user_id.slice(-4),
        //     template_params: emailPayload.template_params
        // });
        
        const response = await fetch(emailjsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(emailPayload)
        });
        
        // console.log('[Background] EmailJS API response status:', response.status);
        // console.log('[Background] EmailJS API response ok:', response.ok);
        
        if (!response.ok) {
            const errorText = await response.text();
            // console.error('[Background] ✗ EmailJS API error response:', errorText);
            // console.error('[Background] Response status:', response.status);
            return {
                success: false,
                error: `EmailJS API error: ${response.status} - ${errorText}`
            };
        }
        
        const responseData = await response.json();
        // console.log('[Background] EmailJS API response data:', responseData);
        // console.log('[Background] ✓ Email sent successfully to inbox!');
        // console.log('[Background] ============================================');
        
        return {
            success: true,
            message: 'Email sent successfully to inbox'
        };
        
    } catch (error) {
        // console.error('[Background] ✗ Exception in sendEmailNotification:', error);
        // console.error('[Background] Error message:', error.message);
        // console.error('[Background] Error stack:', error.stack);
        return {
            success: false,
            error: error.message
        };
    }
}
