(function() {
    'use strict';

    // console.log('[FedEx Extension] ========== Script Loading ==========');
    // console.log('[FedEx Extension] Current URL:', window.location.href);
    // console.log('[FedEx Extension] Hostname:', window.location.hostname);

    // Only run on ShipStation domains
    const hostname = window.location.hostname.toLowerCase();
    // console.log('[FedEx Extension] Hostname check (lowercase):', hostname);
    // console.log('[FedEx Extension] Includes shipstation.com?', hostname.includes('shipstation.com'));
    
    if (!hostname.includes('shipstation.com')) {
        // console.log('[FedEx Extension] Not a ShipStation domain, skipping initialization');
        return;
    }
    
    // console.log('[FedEx Extension] ✓ ShipStation domain detected, continuing initialization...');

    let globalQuoteRequests = {};
    let mostRecentOrderNumber = null; // Store most recently scraped orderNumber
    let serviceLabelToCodeMap = null; // Cache for service label to code mapping
    
    // Expose globalQuoteRequests to window for debugging (read-only access)
    Object.defineProperty(window, 'fedExGlobalQuoteRequests', {
        get: function() { return globalQuoteRequests; },
        enumerable: true,
        configurable: true
    });

    // Helper function to check if we're on a ShipStation domain
    function isShipStationDomain() {
        try {
            const hostname = window.location.hostname.toLowerCase();
            return hostname.includes('shipstation.com');
        } catch (e) {
            return false;
        }
    }

    class RateDialogHandler {
        constructor() {
            this.processedHeaders = new WeakSet();
            this.processedRates = new WeakSet();
            this.rateObservers = new Map();
            this.originalRateValues = new Map();
            this.rateServiceLabels = new Map(); // Track serviceLabel for each rate element
            this.quoteRequestsCache = {};
            this.observer = null;
            this.rateBrowserCheckInterval = null;
            this.rateBrowserStatusMap = new Map(); // Track success/failure status for each Rate Browser rate element
            this.shipmentDialogStatusMap = new Map(); // Track success/failure status for each Rate1 rate element in shipment dialog
            this.init();
        }

        init() {
            // console.log('[RateDialogHandler] Initializing...');
            this.observeDialogs();
            this.checkExistingDialogs();
            this.checkExistingRates();
            this.checkRateBrowserRates().catch(error => {
                // console.error('[RateDialogHandler] Error in checkRateBrowserRates (init):', error);
            });
            this.addRateWarningMessage();
            // Fetch services API to build serviceLabel -> serviceCode mapping
            this.fetchServicesAndBuildMapping();
            // Start periodic check for Rate Browser rates (in case dialog opens later)
            this.startRateBrowserPolling();
            // Set up click listener for Rates button
            this.setupRatesButtonListener();
        }

        // Set up click listener for Rates button to trigger API fetch
        setupRatesButtonListener() {
            // console.log('[RateDialogHandler] Setting up Rates button click listener...');
            
            // Function to attach listener to Rates button
            const attachListener = () => {
                const ratesButton = document.querySelector('.rate-browser-button-SG_yXx6');
                if (ratesButton) {
                    // Check if we've already attached a listener to this button
                    if (ratesButton.hasAttribute('data-fedex-listener-attached')) {
                        return; // Already has listener
                    }
                    
                    // console.log('[RateDialogHandler] ✓ Found Rates button, attaching click listener');
                    ratesButton.setAttribute('data-fedex-listener-attached', 'true');
                    
                    ratesButton.addEventListener('click', async (event) => {
                        // console.log('[RateDialogHandler] ========== Rates Button Clicked ==========');
                        // console.log('[RateDialogHandler] Button clicked:', event.target);
                        // console.log('[RateDialogHandler] Triggering ShipStation API fetch...');
                        
                        // Trigger fetch of order data when Rates button is clicked
                        try {
                            await this.ensureQuoteRequestsForRateBrowser();
                            // console.log('[RateDialogHandler] ✓ ShipStation API fetch completed after Rates button click');
                        } catch (error) {
                            // console.error('[RateDialogHandler] ✗ Error fetching order data after Rates button click:', error);
                        }
                        
                        // console.log('[RateDialogHandler] ============================================');
                    }, { once: false }); // Allow multiple clicks
                    
                    // console.log('[RateDialogHandler] ✓ Click listener attached to Rates button');
                } else {
                    // console.log('[RateDialogHandler] Rates button not found yet, will retry...');
                }
            };
            
            // Try to attach immediately
            attachListener();
            
            // Also watch for the button to appear (in case it's added dynamically)
            const observer = new MutationObserver((mutations) => {
                if (!isShipStationDomain()) {
                    return;
                }
                
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) {
                            // Check if the button was added or if it's inside the added node
                            if (node.classList && node.classList.contains('rate-browser-button-SG_yXx6')) {
                                // console.log('[RateDialogHandler] Rates button detected in DOM, attaching listener...');
                                attachListener();
                            } else if (node.querySelector && node.querySelector('.rate-browser-button-SG_yXx6')) {
                                // console.log('[RateDialogHandler] Rates button found inside added node, attaching listener...');
                                attachListener();
                            }
                        }
                    });
                });
            });
            
            // Observe the document body for new buttons
            if (document.body) {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });
                // console.log('[RateDialogHandler] ✓ MutationObserver set up to watch for Rates button');
            }
            
            // Also check periodically (fallback)
            const checkInterval = setInterval(() => {
                if (!isShipStationDomain()) {
                    clearInterval(checkInterval);
                    return;
                }
                const button = document.querySelector('.rate-browser-button-SG_yXx6');
                if (button && !button.hasAttribute('data-fedex-listener-attached')) {
                    // console.log('[RateDialogHandler] Rates button found via polling, attaching listener...');
                    attachListener();
                }
            }, 1000);
            
            // Clear interval after 30 seconds (button should be found by then)
            setTimeout(() => {
                clearInterval(checkInterval);
            }, 30000);
        }

        // Start periodic polling for Rate Browser rates
        startRateBrowserPolling() {
            if (!isShipStationDomain()) {
                return;
            }

            // Clear any existing interval
            if (this.rateBrowserCheckInterval) {
                clearInterval(this.rateBrowserCheckInterval);
            }

            // Check every 2 seconds for Rate Browser rates
            this.rateBrowserCheckInterval = setInterval(() => {
                if (!isShipStationDomain()) {
                    clearInterval(this.rateBrowserCheckInterval);
                    this.rateBrowserCheckInterval = null;
                    return;
                }
                this.checkRateBrowserRates().catch(error => {
                    // console.error('[RateDialogHandler] Error in checkRateBrowserRates (polling):', error);
                });
            }, 2000);

            // console.log('[RateDialogHandler] Started Rate Browser polling (every 2 seconds)');
        }

        observeDialogs() {
            this.observer = new MutationObserver((mutations) => {
                // Only process if we're on a ShipStation domain
                if (!isShipStationDomain()) {
                    return;
                }
                
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) {
                            this.processNode(node);
                        }
                    });
                });
            });

            // Only observe if we're on a ShipStation domain
            if (isShipStationDomain() && document.body) {
                this.observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            }
        }

        processNode(node) {
            // Only process if we're on a ShipStation domain
            if (!isShipStationDomain()) {
                return;
            }
            
            if (node.classList && node.classList.contains('modal-header-E8CcJ7Y')) {
                this.enhanceDialogHeader(node).catch(error => {
                    // console.error('[RateDialogHandler] Error in enhanceDialogHeader:', error);
                });
            } else if (node.classList && node.classList.contains('shipment-number-lGuL9a9')) {
                // Shipment dialog title detected
                // console.log('[RateDialogHandler] Shipment dialog title element detected');
                this.showShipmentDialogMark();
            } else if (node.querySelector) {
                const header = node.querySelector('.modal-header-E8CcJ7Y');
                if (header) {
                    this.enhanceDialogHeader(header).catch(error => {
                        // console.error('[RateDialogHandler] Error in enhanceDialogHeader:', error);
                    });
                }
                // Also check if shipment title is inside this node
                const shipmentTitle = node.querySelector('.shipment-number-lGuL9a9');
                if (shipmentTitle) {
                    // console.log('[RateDialogHandler] Shipment dialog title found inside node');
                    this.showShipmentDialogMark();
                }
            }

            // Skip Rate Browser rates - they're handled separately
            if (node.classList && node.classList.contains('rate-value-xslVnIC')) {
                // Rate Browser rate - handled by checkRateBrowserRates()
                return;
            }
            
            if (node.classList && (node.classList.contains('with-rate-lasqlhb') || node.classList.contains('rate-amount-R6LSuka'))) {
                // console.log('[RateDialogHandler] Found direct rate element:', node);
                this.applyRateMarkup(node);
            } else if (node.classList && node.classList.contains('rate-list-content-tVqLqSX')) {
                // Rate Browser container detected
                // console.log('[RateDialogHandler] ========== Rate Browser Container Detected ==========');
                // console.log('[RateDialogHandler] Found Rate Browser container (.rate-list-content-tVqLqSX)');
                // console.log('[RateDialogHandler] Ensuring quote requests are available, then processing rates...');
                // Ensure quote requests first, then process rates
                this.ensureQuoteRequestsForRateBrowser().then(() => {
                    // console.log('[RateDialogHandler] Quote requests ready, now processing rates...');
                    return this.checkRateBrowserRates();
                }).catch(error => {
                    // console.error('[RateDialogHandler] Error in ensureQuoteRequestsForRateBrowser or checkRateBrowserRates:', error);
                });
            } else if (node.classList && node.classList.contains('rate-information-vbp6sBx')) {
                // Rate Browser rate information container detected
                // console.log('[RateDialogHandler] Found Rate Browser rate information container');
                const rateValueEl = node.querySelector('.rate-value-xslVnIC');
                if (rateValueEl && !this.processedRates.has(rateValueEl)) {
                    this.applyRateBrowserMarkup(rateValueEl, node);
                }
            } else if (node.querySelector) {
                const rateElements1 = node.querySelectorAll('.with-rate-lasqlhb');
                const rateElements2 = node.querySelectorAll('.rate-amount-R6LSuka');
                const allRateElements = [...rateElements1, ...rateElements2];
                if (allRateElements.length > 0) {
                    // console.log('[RateDialogHandler] Found', allRateElements.length, 'rate elements in node');
                    allRateElements.forEach(element => this.applyRateMarkup(element));
                }
                // Also check for Rate Browser rates
                const rateBrowserContainer = node.querySelector('.rate-list-content-tVqLqSX');
                if (rateBrowserContainer) {
                    // console.log('[RateDialogHandler] ========== Rate Browser Container Found Inside Node ==========');
                    // console.log('[RateDialogHandler] Found Rate Browser container inside node');
                    // console.log('[RateDialogHandler] Ensuring quote requests are available, then processing rates...');
                    // Ensure quote requests first, then process rates
                    this.ensureQuoteRequestsForRateBrowser().then(() => {
                        // console.log('[RateDialogHandler] Quote requests ready, now processing rates...');
                        return this.checkRateBrowserRates();
                    }).catch(error => {
                        // console.error('[RateDialogHandler] Error in ensureQuoteRequestsForRateBrowser or checkRateBrowserRates:', error);
                    });
                }
            }
        }

        checkExistingDialogs() {
            const headers = document.querySelectorAll('.modal-header-E8CcJ7Y');
            headers.forEach(header => {
                this.enhanceDialogHeader(header).catch(error => {
                    // console.error('[RateDialogHandler] Error in enhanceDialogHeader (existing):', error);
                });
            });
            
            // Also check for shipment dialog title
            const shipmentTitle = document.querySelector('.shipment-number-lGuL9a9');
            if (shipmentTitle) {
                // console.log('[RateDialogHandler] Found existing shipment dialog title');
                this.showShipmentDialogMark();
            }
        }

        checkExistingRates() {
            // Only check on ShipStation domains
            if (!isShipStationDomain()) {
                return;
            }
            
            // console.log('[RateDialogHandler] ========== checkExistingRates called ==========');
            const rateElements1 = document.querySelectorAll('.with-rate-lasqlhb');
            const rateElements2 = document.querySelectorAll('.rate-amount-R6LSuka');
            // console.log('[RateDialogHandler] Found .with-rate-lasqlhb elements:', rateElements1.length);
            // console.log('[RateDialogHandler] Found .rate-amount-R6LSuka elements:', rateElements2.length);
            const allRateElements = [...rateElements1, ...rateElements2];
            // console.log('[RateDialogHandler] Total rate elements found:', allRateElements.length);
            
            if (allRateElements.length === 0) {
                // No rate elements found on this page - this is normal for some pages
                return;
            }
            
            allRateElements.forEach((element, index) => {
                // console.log(`[RateDialogHandler] ========== Processing rate element ${index + 1} ==========`);
                // console.log('[RateDialogHandler] Element:', element);
                // console.log('[RateDialogHandler] Element classes:', element.className);
                // console.log('[RateDialogHandler] Element text:', element.textContent.trim());
                this.applyRateMarkup(element);
            });
        }

        async enhanceDialogHeader(header) {
            // Check if this is the Rate Browser dialog
            const titleElement = this.findTitleElement(header);
            const isRateBrowserDialog = titleElement && titleElement.textContent.trim() === 'Rate Browser';
            
            if (isRateBrowserDialog) {
                // For Rate Browser dialog, ensure we have quote requests before processing rates
                // console.log('[RateDialogHandler] ========== Rate Browser Dialog Detected ==========');
                // console.log('[RateDialogHandler] Ensuring quote requests are available before processing rates...');
                
                // CRITICAL: Wait for quote requests to be fetched before processing rates
                await this.ensureQuoteRequestsForRateBrowser();
                
                // console.log('[RateDialogHandler] Quote requests check completed, now processing rates...');
                
                // For Rate Browser dialog, we'll add/update the mark based on rate update status
                // The mark will be updated by showRateBrowserDialogMark()
                this.showRateBrowserDialogMark();
                
                // Also trigger rate processing after a short delay to ensure DOM is ready
                setTimeout(() => {
                    this.checkRateBrowserRates().catch(error => {
                        // console.error('[RateDialogHandler] Error in checkRateBrowserRates (after dialog open):', error);
                    });
                }, 500);
            } else {
                // For other dialogs, remove any existing tick marks
                const existingTickMarks = header.querySelectorAll('.fedex-dialog-tick');
                existingTickMarks.forEach(tick => tick.remove());
            }
            
            if (!this.processedHeaders.has(header)) {
                this.processedHeaders.add(header);
            }
        }
        
        // Show/hide mark next to Rate Browser dialog title based on overall status
        showRateBrowserDialogMark(isSuccess = null) {
            // Find the Rate Browser dialog header
            const headers = document.querySelectorAll('.modal-header-E8CcJ7Y');
            let rateBrowserHeader = null;
            let titleContainer = null;
            
            for (const header of headers) {
                // Find the header-content element that contains the title
                titleContainer = header.querySelector('.header-content-U4DCnOb');
                if (titleContainer) {
                    const title = this.findTitleElement(header);
                    if (title && title.textContent.trim() === 'Rate Browser') {
                        rateBrowserHeader = header;
                        break;
                    }
                }
            }
            
            if (!rateBrowserHeader || !titleContainer) {
                return; // Rate Browser dialog not found
            }
            
            // Remove existing mark
            const existingMark = titleContainer.querySelector('.fedex-rate-browser-dialog-mark');
            if (existingMark) {
                existingMark.remove();
            }
            
            // Remove existing wrapper if it exists
            const existingWrapper = titleContainer.querySelector('.fedex-rate-browser-title-wrapper');
            if (existingWrapper) {
                // Restore original structure
                const titleText = existingWrapper.textContent.replace(/[✓✗]/g, '').trim();
                titleContainer.innerHTML = titleText;
            }
            
            // Check if there are any FedEx rates in the Rate Browser dialog
            const rateValueElements = document.querySelectorAll('.rate-value-xslVnIC');
            let hasFedExRates = false;
            const fedExRateElements = [];
            
            for (const rateEl of rateValueElements) {
                const rateInfoContainer = rateEl.closest('.rate-information-vbp6sBx') || rateEl.parentElement;
                const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                if (serviceNameEl) {
                    const serviceLabel = serviceNameEl.textContent.trim().toLowerCase();
                    const isFedExService = serviceLabel.startsWith('fedex');
                    const isFedExByShipStation = serviceLabel.includes('by shipstation');
                    if (isFedExService && !isFedExByShipStation) {
                        hasFedExRates = true;
                        fedExRateElements.push(rateEl);
                    }
                }
            }
            
            // Only show mark if there are FedEx rates
            if (!hasFedExRates) {
                // Remove any existing mark and wrapper, restore original title
                const existingWrapper = titleContainer.querySelector('.fedex-rate-browser-title-wrapper');
                if (existingWrapper) {
                    const titleText = existingWrapper.textContent.replace(/[✓✗]/g, '').trim();
                    titleContainer.innerHTML = titleText;
                }
                return;
            }
            
            // Filter status map to only include FedEx rates
            const fedExStatusMap = new Map();
            for (const [rateEl, status] of this.rateBrowserStatusMap.entries()) {
                if (fedExRateElements.includes(rateEl)) {
                    fedExStatusMap.set(rateEl, status);
                }
            }
            
            // If isSuccess is null, determine status from FedEx rates only
            if (isSuccess === null) {
                const allStatuses = Array.from(fedExStatusMap.values());
                if (allStatuses.length === 0) {
                    // No FedEx rates processed yet, don't show mark
                    return;
                }
                // Show green if all succeeded, red if any failed
                isSuccess = allStatuses.every(status => status === true);
            }
            
            // Create wrapper div
            const wrapperDiv = document.createElement('div');
            wrapperDiv.className = 'fedex-rate-browser-title-wrapper';
            wrapperDiv.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
            
            // Get the title text (remove any existing marks)
            const titleText = titleContainer.textContent.replace(/[✓✗]/g, '').trim();
            
            // Create title span
            const titleSpan = document.createElement('span');
            titleSpan.textContent = titleText;
            titleSpan.className = 'header-content-U4DCnOb';
            
            // Create mark element
            const markElement = document.createElement('span');
            markElement.className = 'fedex-rate-browser-dialog-mark';
            markElement.style.cssText = 'display: inline-block; font-size: 1.8em; font-weight: bold; vertical-align: middle; line-height: 1;';
            
            if (isSuccess) {
                markElement.textContent = '✓';
                markElement.style.color = '#10b981';
            } else {
                markElement.textContent = '✗';
                markElement.style.color = '#ef4444';
            }
            
            // Add title and mark to wrapper
            wrapperDiv.appendChild(titleSpan);
            wrapperDiv.appendChild(markElement);
            
            // Replace titleContainer content with wrapper
            titleContainer.innerHTML = '';
            titleContainer.appendChild(wrapperDiv);
        }

        // Show/hide mark next to Shipment dialog title based on overall status
        showShipmentDialogMark(isSuccess = null) {
            // console.log('[RateDialogHandler] ========== showShipmentDialogMark called ==========');
            
            // Find the shipment dialog title element with class "shipment-number-lGuL9a9"
            const shipmentTitleEl = document.querySelector('.shipment-number-lGuL9a9');
            
            if (!shipmentTitleEl) {
                // console.log('[RateDialogHandler] Shipment dialog title (.shipment-number-lGuL9a9) not found');
                return;
            }
            
            // console.log('[RateDialogHandler] ✓ Found shipment dialog title element');
            
            // Remove existing mark
            const existingMark = shipmentTitleEl.querySelector('.fedex-shipment-dialog-mark');
            if (existingMark) {
                existingMark.remove();
            }
            
            // Remove existing wrapper if it exists
            const existingWrapper = shipmentTitleEl.querySelector('.fedex-shipment-title-wrapper');
            if (existingWrapper) {
                // Restore original structure
                const titleText = existingWrapper.textContent.replace(/[✓✗]/g, '').trim();
                shipmentTitleEl.innerHTML = titleText;
            }
            
            // Check if there are any Rate1 rates (with-rate-lasqlhb) in the shipment dialog
            const rate1Elements = document.querySelectorAll('.with-rate-lasqlhb');
            let hasFedExRates = false;
            const fedExRateElements = [];
            
            // Check service for each Rate1 element
            const serviceContainer = document.querySelector('div[aria-label="Service"]');
            if (serviceContainer) {
                const button = serviceContainer.querySelector('button.dropdown-toggler.dropdown-menu-toggler-Kfi3ANB');
                if (button) {
                    const serviceEl = button.querySelector('.dropdown-toggler-content-XHHDfD3');
                    if (serviceEl) {
                        const serviceLabel = serviceEl.textContent.trim().toLowerCase();
                        const isFedExService = serviceLabel.startsWith('fedex');
                        const isFedExByShipStation = serviceLabel.includes('by shipstation');
                        
                        if (isFedExService && !isFedExByShipStation) {
                            hasFedExRates = true;
                            // Add all Rate1 elements if service is FedEx
                            rate1Elements.forEach(rateEl => {
                                fedExRateElements.push(rateEl);
                            });
                            // console.log('[RateDialogHandler] Found FedEx service in shipment dialog:', serviceLabel);
                        } else {
                            // console.log('[RateDialogHandler] Service in shipment dialog is not FedEx:', serviceLabel);
                        }
                    }
                }
            }
            
            // If we couldn't determine from service dropdown, check status map
            // (rates that were already processed will be in the status map)
            if (!hasFedExRates && this.shipmentDialogStatusMap.size > 0) {
                // console.log('[RateDialogHandler] No FedEx service found in dropdown, but status map has entries - assuming FedEx rates exist');
                hasFedExRates = true;
                rate1Elements.forEach(rateEl => {
                    if (this.shipmentDialogStatusMap.has(rateEl)) {
                        fedExRateElements.push(rateEl);
                    }
                });
            }
            
            // Only show mark if there are FedEx rates
            if (!hasFedExRates) {
                // console.log('[RateDialogHandler] No FedEx rates found in shipment dialog, not showing mark');
                // Remove any existing mark and wrapper, restore original title
                const existingWrapper = shipmentTitleEl.querySelector('.fedex-shipment-title-wrapper');
                if (existingWrapper) {
                    const titleText = existingWrapper.textContent.replace(/[✓✗]/g, '').trim();
                    shipmentTitleEl.innerHTML = titleText;
                }
                return;
            }
            
            // Filter status map to only include FedEx rates
            const fedExStatusMap = new Map();
            for (const [rateEl, status] of this.shipmentDialogStatusMap.entries()) {
                if (fedExRateElements.includes(rateEl)) {
                    fedExStatusMap.set(rateEl, status);
                }
            }
            
            // If isSuccess is null, determine status from FedEx rates only
            if (isSuccess === null) {
                const allStatuses = Array.from(fedExStatusMap.values());
                if (allStatuses.length === 0) {
                    // No FedEx rates processed yet, don't show mark
                    // console.log('[RateDialogHandler] No FedEx rates processed yet, not showing mark');
                    return;
                }
                // Show green if all succeeded, red if any failed
                isSuccess = allStatuses.every(status => status === true);
                // console.log('[RateDialogHandler] Determined status from rates:', isSuccess ? 'SUCCESS (all passed)' : 'FAILURE (some failed)');
            }
            
            // Create wrapper div
            const wrapperDiv = document.createElement('div');
            wrapperDiv.className = 'fedex-shipment-title-wrapper';
            wrapperDiv.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
            
            // Get the title text (remove any existing marks)
            const titleText = shipmentTitleEl.textContent.replace(/[✓✗]/g, '').trim();
            
            // Create title span
            const titleSpan = document.createElement('span');
            titleSpan.textContent = titleText;
            
            // Create mark element
            const markElement = document.createElement('span');
            markElement.className = 'fedex-shipment-dialog-mark';
            markElement.style.cssText = 'display: inline-block; font-size: 1.8em; font-weight: bold; vertical-align: middle; line-height: 1;';
            
            if (isSuccess) {
                markElement.textContent = '✓';
                markElement.style.color = '#10b981';
                // console.log('[RateDialogHandler] ✓ Showing green checkmark (success)');
            } else {
                markElement.textContent = '✗';
                markElement.style.color = '#ef4444';
                // console.log('[RateDialogHandler] ✗ Showing red cross (failure)');
            }
            
            // Add title and mark to wrapper
            wrapperDiv.appendChild(titleSpan);
            wrapperDiv.appendChild(markElement);
            
            // Replace shipmentTitleEl content with wrapper
            shipmentTitleEl.innerHTML = '';
            shipmentTitleEl.appendChild(wrapperDiv);
            
            // console.log('[RateDialogHandler] ========== showShipmentDialogMark completed ==========');
        }

        findTitleElement(header) {
            const allTextNodes = this.getAllTextNodes(header);
            
            for (const textNode of allTextNodes) {
                if (textNode.textContent.trim() === 'Rate Browser') {
                    return textNode.parentElement;
                }
            }

            const titleElements = header.querySelectorAll('*');
            for (const element of titleElements) {
                if (element.textContent.trim() === 'Rate Browser') {
                    return element;
                }
            }

            return null;
        }

        getAllTextNodes(element) {
            const textNodes = [];
            const walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );

            let node;
            while (node = walker.nextNode()) {
                textNodes.push(node);
            }

            return textNodes;
        }

        hasTickMark(element) {
            const tickMark = element.querySelector('.fedex-dialog-tick');
            return tickMark !== null;
        }

        addTickMark(titleElement) {
            const tickMark = document.createElement('span');
            tickMark.className = 'fedex-dialog-tick';
            tickMark.textContent = '✓';
            tickMark.style.cssText = 'display: inline-block; margin-left: 8px; color: #10b981; font-size: 1em; font-weight: bold; vertical-align: middle;';

            if (titleElement.firstChild && titleElement.firstChild.nodeType === Node.TEXT_NODE) {
                titleElement.insertBefore(tickMark, titleElement.firstChild.nextSibling);
            } else {
                titleElement.appendChild(tickMark);
            }
        }

        applyRateMarkup(rateElement) {
            // console.log('[RateDialogHandler] ========== applyRateMarkup called ==========');
            // console.log('[RateDialogHandler] Rate element:', rateElement);
            // console.log('[RateDialogHandler] Rate element classes:', rateElement.className);
            // console.log('[RateDialogHandler] Rate element text:', rateElement.textContent.trim());
            // console.log('[RateDialogHandler] Already processed?', this.processedRates.has(rateElement));

            // Skip Rate Browser rates - they should be handled by applyRateBrowserMarkup
            if (rateElement.classList && rateElement.classList.contains('rate-value-xslVnIC')) {
                // console.log('[RateDialogHandler] ⏭️ Skipping Rate Browser rate (handled by applyRateBrowserMarkup)');
                return;
            }

            if (this.processedRates.has(rateElement)) {
                // console.log('[RateDialogHandler] Rate element already processed, skipping');
                return;
            }

            const originalText = rateElement.textContent.trim();
            // console.log('[RateDialogHandler] Original text:', originalText);
            const dollarAmount = this.extractDollarAmount(originalText);
            // console.log('[RateDialogHandler] Extracted dollar amount:', dollarAmount);

            if (dollarAmount === null) {
                // console.warn('[RateDialogHandler] Could not extract dollar amount, skipping');
                return;
            }

            this.originalRateValues.set(rateElement, dollarAmount);
            
            // Hide original rate value immediately to prevent users from seeing it
            this.hideRateValue(rateElement);
            
            // Don't mark as processed until after update attempt
            // This allows retry if dialog opens later
            this.updateRateWithQuoteAPI(rateElement).then(() => {
                // Only mark as processed if update was successful or attempted
                this.processedRates.add(rateElement);
                this.setupRateObserver(rateElement);
                // console.log('[RateDialogHandler] Rate observer set up for element');
            }).catch(error => {
                // console.error('[RateDialogHandler] Error in updateRateWithQuoteAPI:', error);
                
                const isRateBrowser = rateElement.classList.contains('rate-value-xslVnIC');
                const isRate1 = rateElement.classList.contains('with-rate-lasqlhb');
                
                // For Rate Browser rates, track status and update dialog title mark
                if (isRateBrowser) {
                    this.rateBrowserStatusMap.set(rateElement, false); // Mark as failure
                    this.showRateBrowserDialogMark(); // Update dialog title mark
                } else if (isRate1) {
                    // For Rate1 (shipment dialog), show mark on rate element AND update dialog title mark
                    this.shipmentDialogStatusMap.set(rateElement, false); // Mark as failure
                    this.showRateMark(rateElement, false); // Show mark on the rate element itself
                    this.showShipmentDialogMark(); // Update dialog title mark
                } else {
                    // For Rate2, show individual error marks
                    this.showRateMark(rateElement, false);
                }
                
                // Restore original value if update failed
                this.restoreRateValue(rateElement);
                // Still mark as processed to avoid infinite retries
                this.processedRates.add(rateElement);
                this.setupRateObserver(rateElement);
            });
        }

        extractOrderNumberForRate1(rateElement) {
            // console.log('[RateDialogHandler] Extracting orderNumber for Rate1...');
            // console.log('[RateDialogHandler] Searching entire document for .order-number-part-sgF7off');
            const orderNumberEl = document.querySelector('.order-number-part-sgF7off');
            // console.log('[RateDialogHandler] Order number element found:', orderNumberEl);
            if (orderNumberEl) {
                const orderNumber = orderNumberEl.textContent.trim();
                // console.log('[RateDialogHandler] Order number text:', orderNumber);
                // Store most recent orderNumber
                mostRecentOrderNumber = orderNumber;
                return orderNumber;
            }
            // console.warn('[RateDialogHandler] Order number element not found in document');
            // console.warn('[RateDialogHandler] Available elements with similar classes:');
            const allElements = document.querySelectorAll('[class*="order"], [class*="number"]');
            // console.log('[RateDialogHandler] Found', allElements.length, 'elements with "order" or "number" in class');
            return null;
        }

        extractOrderNumberForRate2(rateElement) {
            // console.log('[RateDialogHandler] ========== Extracting orderNumber for Rate2 ==========');
            // console.log('[RateDialogHandler] Searching for .h4-yAR2Zwb inside .order-info-order-number-vbTaRbB');
            
            const container = document.querySelector('.order-info-order-number-vbTaRbB');
            // console.log('[RateDialogHandler] Container found:', container);
            
            if (container) {
                const orderNumberEl = container.querySelector('.h4-yAR2Zwb');
                // console.log('[RateDialogHandler] Order number element found:', orderNumberEl);
                
                if (orderNumberEl) {
                    const text = orderNumberEl.textContent.trim();
                    // console.log('[RateDialogHandler] Order number text:', text);
                    const match = text.match(/\d+/);
                    const orderNumber = match ? match[0] : null;
                    // console.log('[RateDialogHandler] Extracted digits:', orderNumber);
                    // console.log('[RateDialogHandler] ✓ Final orderNumber:', orderNumber);
                    // Store most recent orderNumber
                    if (orderNumber) {
                        mostRecentOrderNumber = orderNumber;
                    }
                    return orderNumber;
                }
            }
            
            return null;
        }

        extractServiceName(rateElement, isRate1, isRate2, isRateBrowser) {
            try {
                if (isRateBrowser) {
                    // For Rate Browser: extract from .rate-name-E9GTfro
                    const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
                    const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                    if (serviceNameEl) {
                        return serviceNameEl.textContent.trim();
                    }
                } else if (isRate1) {
                    // For Rate1: extract from .dropdown-toggler-content-XHHDfD3
                    const serviceContainer = document.querySelector('div[aria-label="Service"]');
                    if (serviceContainer) {
                        const button = serviceContainer.querySelector('button.dropdown-toggler.dropdown-menu-toggler-Kfi3ANB');
                        if (button) {
                            const serviceEl = button.querySelector('.dropdown-toggler-content-XHHDfD3');
                            if (serviceEl) {
                                return serviceEl.textContent.trim() || serviceEl.innerText.trim();
                            }
                        }
                    }
                } else if (isRate2) {
                    // For Rate2: extract from .single-value-zLWJOKx
                    const serviceEl = document.querySelector('.single-value-zLWJOKx');
                    if (serviceEl) {
                        return serviceEl.textContent.trim();
                    }
                }
            } catch (error) {
                // Silently fail - service name extraction is not critical
            }
            return null;
        }

        extractServiceCodeForRate1(rateElement) {
            // console.log('[RateDialogHandler] ========== Extracting serviceCode for Rate1 ==========');
            // console.log('[RateDialogHandler] Step 1: Finding div with aria-label="Service"');
            
            const serviceContainer = document.querySelector('div[aria-label="Service"]');
            // console.log('[RateDialogHandler] Service container found:', serviceContainer);
            
            if (!serviceContainer) {
                // console.warn('[RateDialogHandler] ❌ Service container not found');
                // console.warn('[RateDialogHandler] Searching for all divs with aria-label...');
                const allAriaLabels = document.querySelectorAll('[aria-label]');
                // console.log('[RateDialogHandler] Found', allAriaLabels.length, 'elements with aria-label');
                allAriaLabels.forEach((el, idx) => {
                    if (idx < 10) {
                        // console.log(`[RateDialogHandler]   ${idx + 1}. aria-label: "${el.getAttribute('aria-label')}", tag: ${el.tagName}`);
                    }
                });
                return null;
            }
            
            // console.log('[RateDialogHandler] Step 2: Finding button inside service container');
            const button = serviceContainer.querySelector('button.dropdown-toggler.dropdown-menu-toggler-Kfi3ANB');
            // console.log('[RateDialogHandler] Button found:', button);
            
            if (!button) {
                // console.warn('[RateDialogHandler] ❌ Button not found in service container');
                const allButtons = serviceContainer.querySelectorAll('button');
                // console.log('[RateDialogHandler] Found', allButtons.length, 'buttons in container');
                return null;
            }
            
            // console.log('[RateDialogHandler] Step 3: Finding .dropdown-toggler-content-XHHDfD3 inside button');
            const serviceEl = button.querySelector('.dropdown-toggler-content-XHHDfD3');
            // console.log('[RateDialogHandler] Service element found:', serviceEl);
            
            if (!serviceEl) {
                // console.warn('[RateDialogHandler] ❌ Service element not found in button');
                // console.warn('[RateDialogHandler] Button innerHTML:', button.innerHTML.substring(0, 200));
                return null;
            }
            
            // console.log('[RateDialogHandler] Step 4: Extracting text from service element');
            let serviceText = serviceEl.textContent.trim();
            // console.log('[RateDialogHandler] ✓ Raw service text extracted:', serviceText);
            // console.log('[RateDialogHandler] Service text length:', serviceText.length);
            // console.log('[RateDialogHandler] Service text includes "FedEx":', serviceText.includes('FedEx'));
            // console.log('[RateDialogHandler] Service element innerHTML:', serviceEl.innerHTML);
            // console.log('[RateDialogHandler] Service element innerText:', serviceEl.innerText);
            
            if (!serviceText || serviceText.length === 0) {
                // console.warn('[RateDialogHandler] ⚠️ Service text is empty, trying innerText');
                const innerText = serviceEl.innerText.trim();
                if (innerText) {
                    // console.log('[RateDialogHandler] Using innerText:', innerText);
                    serviceText = innerText;
                } else {
                    // console.warn('[RateDialogHandler] ❌ Both textContent and innerText are empty');
                    return null;
                }
            }
            
            // console.log('[RateDialogHandler] Step 5: Converting service text to serviceCode');
            let converted = serviceText.toLowerCase();
            // console.log('[RateDialogHandler] After toLowerCase:', converted);
            
            converted = converted.replace(/\s+/g, '_');
            // console.log('[RateDialogHandler] After replace spaces:', converted);
            
            converted = converted.replace(/®/g, '');
            converted = converted.replace(/™/g, '');
            converted = converted.replace(/[^\w_]/g, '');
            // console.log('[RateDialogHandler] After cleanup special chars:', converted);
            
            // console.log('[RateDialogHandler] ✓ Final converted serviceCode:', converted);
            return converted;
        }

        extractServiceCodeForRate2(rateElement) {
            // console.log('[RateDialogHandler] ========== Extracting serviceCode for Rate2 ==========');
            // console.log('[RateDialogHandler] Searching for .single-value-zLWJOKx');
            
            const serviceEl = document.querySelector('.single-value-zLWJOKx');
            // console.log('[RateDialogHandler] Service element found:', serviceEl);
            
            if (serviceEl) {
                const serviceText = serviceEl.textContent.trim();
                // console.log('[RateDialogHandler] ✓ Service text extracted:', serviceText);
                // console.log('[RateDialogHandler] Service text length:', serviceText.length);
                // console.log('[RateDialogHandler] Service text includes "FedEx":', serviceText.includes('FedEx'));
                
                let converted = serviceText.toLowerCase();
                // console.log('[RateDialogHandler] After toLowerCase:', converted);
                
                converted = converted.replace(/\s+/g, '_');
                // console.log('[RateDialogHandler] After replace spaces:', converted);
                
                converted = converted.replace(/®/g, '');
                converted = converted.replace(/™/g, '');
                converted = converted.replace(/[^\w_]/g, '');
                // console.log('[RateDialogHandler] After cleanup special chars:', converted);
                
                // console.log('[RateDialogHandler] ✓ Final converted serviceCode:', converted);
                return converted;
            }
            
            // Only log detailed warnings if we're in a dialog context
            const hasDialog = document.querySelector('.modal-header-E8CcJ7Y') || 
                             document.querySelector('[class*="modal"]') ||
                             document.querySelector('[class*="dialog"]');
            
            if (hasDialog) {
                // console.warn('[RateDialogHandler] ⚠️ Service element not found (in dialog context)');
                const allSingleValue = document.querySelectorAll('[class*="single-value"]');
                if (allSingleValue.length > 0) {
                    // console.log('[RateDialogHandler] Found', allSingleValue.length, 'elements with "single-value" in class');
                }
            }
            return null;
        }

        extractOrderNumberForRateBrowser(rateElement) {
            // Use most recent orderNumber (already extracted from previous dialogs)
            return mostRecentOrderNumber;
        }

        extractServiceCodeForRateBrowser(rateElement) {
            // console.log('[RateDialogHandler] ========== extractServiceCodeForRateBrowser START ==========');
            // console.log('[RateDialogHandler] Input rateElement:', rateElement);
            // console.log('[RateDialogHandler] Rate element classes:', rateElement.className);
            // console.log('[RateDialogHandler] Rate element text:', rateElement.textContent.trim());
            // console.log('[RateDialogHandler] Rate element HTML (first 300 chars):', rateElement.outerHTML.substring(0, 300));
            
            // Check if serviceLabelToCodeMap is available
            // console.log('[RateDialogHandler] Checking serviceLabelToCodeMap...');
            // console.log('[RateDialogHandler] serviceLabelToCodeMap is:', serviceLabelToCodeMap ? 'AVAILABLE' : 'NULL');
            if (serviceLabelToCodeMap) {
                // console.log('[RateDialogHandler] serviceLabelToCodeMap has', Object.keys(serviceLabelToCodeMap).length, 'entries');
                // console.log('[RateDialogHandler] First 5 service labels:', Object.keys(serviceLabelToCodeMap).slice(0, 5));
            } else {
                // console.error('[RateDialogHandler] ❌ serviceLabelToCodeMap is NULL - cannot extract serviceCode!');
                // console.error('[RateDialogHandler] This means fetchServicesAndBuildMapping() may not have completed yet');
                // console.log('[RateDialogHandler] ========== extractServiceCodeForRateBrowser END (FAILED) ==========');
                return null;
            }
            
            // Find the rate-information container - try multiple methods
            // console.log('[RateDialogHandler] Step 1: Finding rate-information container...');
            
            // Method 1: closest
            let rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx');
            // console.log('[RateDialogHandler] Method 1 (closest):', !!rateInfoContainer);
            
            // Method 2: Search in parent elements
            if (!rateInfoContainer) {
                // console.log('[RateDialogHandler] Method 2: Searching parent elements...');
                let parent = rateElement.parentElement;
                let depth = 0;
                while (parent && depth < 10) {
                    // console.log(`[RateDialogHandler]   Parent ${depth + 1}:`, parent.tagName, parent.className);
                    if (parent.classList && parent.classList.contains('rate-information-vbp6sBx')) {
                        rateInfoContainer = parent;
                        // console.log('[RateDialogHandler] ✓ Found container in parent', depth + 1);
                        break;
                    }
                    parent = parent.parentElement;
                    depth++;
                }
            }
            
            // Method 3: Search document for service name near this rate element
            if (!rateInfoContainer) {
                // console.log('[RateDialogHandler] Method 3: Searching document for service name element...');
                // Find all service name elements
                const allServiceNames = document.querySelectorAll('.rate-name-E9GTfro');
                // console.log('[RateDialogHandler] Found', allServiceNames.length, 'service name elements in document');
                
                // Find the one closest to our rate element
                let closestServiceName = null;
                let minDistance = Infinity;
                
                allServiceNames.forEach((serviceNameEl, idx) => {
                    // Check if this service name is in the same row/section as our rate element
                    const serviceContainer = serviceNameEl.closest('.rate-information-vbp6sBx') || 
                                            serviceNameEl.closest('[class*="rate"]') ||
                                            serviceNameEl.parentElement;
                    
                    // Check if rate element is in the same container or nearby
                    const rateContainer = rateElement.closest('[class*="rate"]') || rateElement.parentElement;
                    
                    if (serviceContainer && rateContainer && 
                        (serviceContainer.contains(rateElement) || rateContainer.contains(serviceNameEl) ||
                         serviceContainer === rateContainer)) {
                        // console.log(`[RateDialogHandler]   Service name ${idx + 1} might be related:`, serviceNameEl.textContent.trim());
                        if (!closestServiceName) {
                            closestServiceName = serviceNameEl;
                            rateInfoContainer = serviceContainer;
                        }
                    }
                });
                
                if (closestServiceName) {
                    // console.log('[RateDialogHandler] ✓ Found related service name element');
                }
            }
            
            // console.log('[RateDialogHandler] Final rateInfoContainer found:', !!rateInfoContainer);
            
            // Get service label - try multiple methods
            // console.log('[RateDialogHandler] Step 2: Finding service name element (.rate-name-E9GTfro)...');
            let serviceNameEl = null;
            
            if (rateInfoContainer) {
                serviceNameEl = rateInfoContainer.querySelector('.rate-name-E9GTfro');
                // console.log('[RateDialogHandler] Method 1 (querySelector in container):', !!serviceNameEl);
            }
            
            // Method 2: Search document and find the one in the same row
            if (!serviceNameEl) {
                // console.log('[RateDialogHandler] Method 2: Searching document for service name...');
                const allServiceNames = document.querySelectorAll('.rate-name-E9GTfro');
                // console.log('[RateDialogHandler] Found', allServiceNames.length, 'service name elements in document');
                
                // Find rate element's row/section
                const rateRow = rateElement.closest('[class*="rate-list-item"], [class*="rate-row"], button, [class*="item"]') || 
                               rateElement.parentElement;
                // console.log('[RateDialogHandler] Rate element row:', rateRow.tagName, rateRow.className);
                
                // Find service name in the same row
                allServiceNames.forEach((el, idx) => {
                    const serviceRow = el.closest('[class*="rate-list-item"], [class*="rate-row"], button, [class*="item"]') || 
                                     el.parentElement;
                    if (serviceRow === rateRow || rateRow.contains(el) || serviceRow.contains(rateElement)) {
                        // console.log(`[RateDialogHandler]   Service name ${idx + 1} in same row:`, el.textContent.trim());
                        if (!serviceNameEl) {
                            serviceNameEl = el;
                        }
                    }
                });
                
                // console.log('[RateDialogHandler] Method 2 result:', !!serviceNameEl);
            }
            
            // Method 3: Search siblings and nearby elements
            if (!serviceNameEl) {
                // console.log('[RateDialogHandler] Method 3: Searching siblings and nearby elements...');
                let current = rateElement.parentElement;
                let depth = 0;
                while (current && depth < 5) {
                    const found = current.querySelector('.rate-name-E9GTfro');
                    if (found) {
                        serviceNameEl = found;
                        // console.log('[RateDialogHandler] ✓ Found service name in parent/sibling at depth', depth);
                        break;
                    }
                    current = current.parentElement;
                    depth++;
                }
            }
            
            // Method 4: Find all service names and match by position/index
            if (!serviceNameEl) {
                // console.log('[RateDialogHandler] Method 4: Finding service name by position/index...');
                // Find all rate values and all service names
                const allRateValues = document.querySelectorAll('.rate-value-xslVnIC');
                const allServiceNames = document.querySelectorAll('.rate-name-E9GTfro');
                // console.log('[RateDialogHandler] Total rate values found:', allRateValues.length);
                // console.log('[RateDialogHandler] Total service names found:', allServiceNames.length);
                
                // Find index of current rate element
                let rateIndex = -1;
                for (let i = 0; i < allRateValues.length; i++) {
                    if (allRateValues[i] === rateElement) {
                        rateIndex = i;
                        break;
                    }
                }
                // console.log('[RateDialogHandler] Current rate element index:', rateIndex);
                
                // Get service name at same index
                if (rateIndex >= 0 && rateIndex < allServiceNames.length) {
                    serviceNameEl = allServiceNames[rateIndex];
                    // console.log('[RateDialogHandler] ✓ Found service name at same index:', rateIndex);
                }
            }
            
            // console.log('[RateDialogHandler] Final serviceNameEl found:', !!serviceNameEl);
            
            if (!serviceNameEl) {
                // console.error('[RateDialogHandler] ❌ Service name element not found after all methods');
                // console.error('[RateDialogHandler] Rate element parent:', rateElement.parentElement);
                // console.error('[RateDialogHandler] Rate element parent classes:', rateElement.parentElement?.className);
                // console.error('[RateDialogHandler] Rate element parent HTML:', rateElement.parentElement?.outerHTML?.substring(0, 500));
                
                // Show all service names found in document for debugging
                const allServiceNames = document.querySelectorAll('.rate-name-E9GTfro');
                // console.error('[RateDialogHandler] All service names in document:', allServiceNames.length);
                allServiceNames.forEach((el, idx) => {
                    // console.error(`[RateDialogHandler]   Service name ${idx + 1}:`, el.textContent.trim(), 'classes:', el.className);
                });
                
                return null;
            }
            
            // console.log('[RateDialogHandler] ✓ Service name element found:', serviceNameEl);
            // console.log('[RateDialogHandler] Service name element classes:', serviceNameEl.className);
            // console.log('[RateDialogHandler] Service name element text (raw):', serviceNameEl.textContent);
            // console.log('[RateDialogHandler] Service name element innerHTML:', serviceNameEl.innerHTML);

            const serviceLabel = serviceNameEl.textContent.trim();
            // console.log('[RateDialogHandler] Step 3: Extracted serviceLabel:', serviceLabel);
            // console.log('[RateDialogHandler] serviceLabel length:', serviceLabel.length);
            // console.log('[RateDialogHandler] serviceLabel (with quotes):', `"${serviceLabel}"`);
            // console.log('[RateDialogHandler] serviceLabel (char codes):', Array.from(serviceLabel).map(c => c.charCodeAt(0)).join(','));

            // Filter: Only process services starting with "FedEx" (case-insensitive)
            // Exclude "FedEx by ShipStation"
            // console.log('[RateDialogHandler] Step 4: Checking if service is FedEx...');
            const serviceLabelLower = serviceLabel.toLowerCase();
            // console.log('[RateDialogHandler] serviceLabelLower:', serviceLabelLower);
            const isFedExService = serviceLabelLower.startsWith('fedex');
            const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
            // console.log('[RateDialogHandler] isFedExService:', isFedExService);
            // console.log('[RateDialogHandler] isFedExByShipStation:', isFedExByShipStation);
            
            if (!isFedExService) {
                // console.log('[RateDialogHandler] ⏭️ Skipping non-FedEx service:', serviceLabel);
                // console.log('[RateDialogHandler] ============================================');
                return null;
            }

            if (isFedExByShipStation) {
                // console.log('[RateDialogHandler] ⏭️ Skipping FedEx by ShipStation service:', serviceLabel);
                // console.log('[RateDialogHandler] ============================================');
                return null;
            }
            // console.log('[RateDialogHandler] ✓ Service is FedEx (not by ShipStation)');

            // Map serviceLabel to serviceCode using the mapping
            // console.log('[RateDialogHandler] ========== Mapping serviceLabel to serviceCode ==========');
            // console.log('[RateDialogHandler] Looking up serviceLabel:', serviceLabel);
            // console.log('[RateDialogHandler] serviceLabelToCodeMap available:', !!serviceLabelToCodeMap);
            
            let serviceCode = null;
            if (serviceLabelToCodeMap) {
                // console.log('[RateDialogHandler] Mapping has', Object.keys(serviceLabelToCodeMap).length, 'entries');
                // console.log('[RateDialogHandler] Available serviceLabels in mapping:', Object.keys(serviceLabelToCodeMap).filter(k => !k.includes('_')).join(', '));
                
                // Try exact match first
                serviceCode = serviceLabelToCodeMap[serviceLabel];
                // console.log('[RateDialogHandler] Exact match result:', serviceCode ? `"${serviceCode}"` : 'NOT FOUND');
                
                // Try normalized match
                if (!serviceCode) {
                    const normalizedLabel = serviceLabel.toLowerCase().replace(/\s+/g, '_');
                    // console.log('[RateDialogHandler] Trying normalized match:', normalizedLabel);
                    serviceCode = serviceLabelToCodeMap[normalizedLabel];
                    // console.log('[RateDialogHandler] Normalized match result:', serviceCode ? `"${serviceCode}"` : 'NOT FOUND');
                }
                
                // Try partial match
                if (!serviceCode) {
                    // console.log('[RateDialogHandler] Trying partial match...');
                    for (const [label, code] of Object.entries(serviceLabelToCodeMap)) {
                        if (label.toLowerCase().includes(serviceLabel.toLowerCase()) || 
                            serviceLabel.toLowerCase().includes(label.toLowerCase())) {
                            serviceCode = code;
                            // console.log('[RateDialogHandler] Partial match found:', `"${label}" -> "${code}"`);
                            break;
                        }
                    }
                    if (!serviceCode) {
                        // console.log('[RateDialogHandler] Partial match result: NOT FOUND');
                    }
                }
            } else {
                // console.warn('[RateDialogHandler] ⚠️ serviceLabelToCodeMap is null - services API may not have been called yet');
            }

            if (!serviceCode && serviceLabelToCodeMap) {
                // console.warn('[RateDialogHandler] ⚠️ Could not map serviceLabel to serviceCode:', serviceLabel);
                // console.warn('[RateDialogHandler] Available mappings:', Object.keys(serviceLabelToCodeMap));
                // console.warn('[RateDialogHandler] Full mapping object:', JSON.stringify(serviceLabelToCodeMap, null, 2));
                // console.warn('[RateDialogHandler] Trying to find similar serviceLabels...');
                const similarLabels = Object.keys(serviceLabelToCodeMap).filter(k => 
                    k.toLowerCase().includes(serviceLabel.toLowerCase().substring(0, 5)) ||
                    serviceLabel.toLowerCase().includes(k.toLowerCase().substring(0, 5))
                );
                if (similarLabels.length > 0) {
                    // console.warn('[RateDialogHandler] Similar labels found:', similarLabels);
                } else {
                    // console.warn('[RateDialogHandler] No similar labels found');
                }
            } else if (serviceCode) {
                // console.log('[RateDialogHandler] ✓ Successfully mapped:', `"${serviceLabel}" -> "${serviceCode}"`);
            } else if (!serviceLabelToCodeMap) {
                // console.error('[RateDialogHandler] ❌ serviceLabelToCodeMap is NULL - services API may not have been called or failed');
                // console.error('[RateDialogHandler] This means the mapping was never built!');
            }
            // console.log('[RateDialogHandler] Final serviceCode result:', serviceCode);
            // console.log('[RateDialogHandler] ====================================================');

            return serviceCode;
        }

        async extractSenderZipForRateBrowser(rateElement) {
            // console.log('[RateDialogHandler] ========== extractSenderZipForRateBrowser START ==========');
            // console.log('[RateDialogHandler] Input rateElement:', rateElement);
            
            // First, try to get sender zip from input element: <input class="flex-input-xbjuM5Y"> in <div class="flex-input-wrapper-ua7EHDH">
            // Wait for element to appear (it might be loaded dynamically)
            // console.log('[RateDialogHandler] Step 1: Looking for input element with class "flex-input-xbjuM5Y"...');
            // console.log('[RateDialogHandler] Searching for .flex-input-wrapper-ua7EHDH (with retry logic)...');
            
            let inputWrapper = null;
            const maxRetries = 10;
            const retryDelay = 200;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                inputWrapper = document.querySelector('.flex-input-wrapper-ua7EHDH');
                if (inputWrapper) {
                    // console.log(`[RateDialogHandler] ✓ Found input wrapper on attempt ${attempt}`);
                    break;
                }
                if (attempt < maxRetries) {
                    // console.log(`[RateDialogHandler] Attempt ${attempt}: inputWrapper not found, waiting ${retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
            
            // console.log('[RateDialogHandler] inputWrapper found:', !!inputWrapper);
            if (inputWrapper) {
                // console.log('[RateDialogHandler] ✓ Found input wrapper');
                // console.log('[RateDialogHandler] inputWrapper HTML (first 200 chars):', inputWrapper.outerHTML.substring(0, 200));
                const inputEl = inputWrapper.querySelector('.flex-input-xbjuM5Y');
                // console.log('[RateDialogHandler] inputEl found:', !!inputEl);
                if (inputEl) {
                    // console.log('[RateDialogHandler] ✓ Found input element');
                    // console.log('[RateDialogHandler] inputEl type:', inputEl.tagName);
                    // console.log('[RateDialogHandler] inputEl value:', inputEl.value);
                    // console.log('[RateDialogHandler] inputEl textContent:', inputEl.textContent);
                    let senderZip = inputEl.value ? inputEl.value.trim() : inputEl.textContent.trim();
                    // console.log('[RateDialogHandler] Raw extracted value:', senderZip);
                    
                    if (senderZip) {
                        // Convert "Test Locale" to "80224"
                        if (senderZip === 'Test Locale') {
                            // console.log('[RateDialogHandler] Converting "Test Locale" to "80224"');
                            senderZip = '80224';
                        } else {
                            // Extract zip code if it's part of a longer string
                            const zipMatch = senderZip.match(/\b\d{5}(-\d{4})?\b/);
                            if (zipMatch) {
                                senderZip = zipMatch[0];
                                // console.log('[RateDialogHandler] Extracted zip code from input:', senderZip);
                            }
                        }
                        
                        if (senderZip && /^\d{5}(-\d{4})?$/.test(senderZip)) {
                            // console.log('[RateDialogHandler] ✓ SUCCESS: Final sender zip from input:', senderZip);
                            // console.log('[RateDialogHandler] ========== extractSenderZipForRateBrowser END ==========');
                            return senderZip;
                        } else {
                            // console.warn('[RateDialogHandler] ⚠️ Extracted value does not match zip format:', senderZip);
                        }
                    } else {
                        // console.warn('[RateDialogHandler] ⚠️ Input element value is empty');
                    }
                } else {
                    // console.warn('[RateDialogHandler] ❌ Input element (.flex-input-xbjuM5Y) not found in wrapper');
                    // console.warn('[RateDialogHandler] Available elements in wrapper:', inputWrapper.querySelectorAll('*').length);
                    // Show all input elements in wrapper for debugging
                    const allInputs = inputWrapper.querySelectorAll('input');
                    // console.warn('[RateDialogHandler] All input elements in wrapper:', allInputs.length);
                    allInputs.forEach((input, idx) => {
                        // console.warn(`[RateDialogHandler]   Input ${idx + 1}:`, input.className, 'value:', input.value);
                    });
                }
            } else {
                // console.warn('[RateDialogHandler] ❌ Input wrapper (.flex-input-wrapper-ua7EHDH) not found after all retries');
                // console.warn('[RateDialogHandler] Searching document for all elements with "flex-input" in class...');
                const allFlexInputs = document.querySelectorAll('[class*="flex-input"]');
                // console.warn('[RateDialogHandler] Found', allFlexInputs.length, 'elements with "flex-input" in class');
                allFlexInputs.forEach((el, idx) => {
                    if (idx < 5) {
                        // console.warn(`[RateDialogHandler]   Element ${idx + 1}:`, el.className, 'tag:', el.tagName, 'value:', el.value || el.textContent);
                    }
                });
                
                // Try alternative: search for input elements in the Rate Browser dialog that might contain zip
                // console.log('[RateDialogHandler] Trying alternative: searching for input elements in Rate Browser dialog...');
                const rateBrowserDialog = document.querySelector('.modal-header-E8CcJ7Y')?.closest('[class*="modal"], [class*="dialog"]');
                if (rateBrowserDialog) {
                    const inputsInDialog = rateBrowserDialog.querySelectorAll('input[type="text"], input:not([type]), input[type="number"]');
                    // console.log('[RateDialogHandler] Found', inputsInDialog.length, 'input elements in Rate Browser dialog');
                    for (const input of inputsInDialog) {
                        const value = input.value || input.getAttribute('value') || '';
                        if (value && /^\d{5}/.test(value.trim())) {
                            // console.log('[RateDialogHandler]   Found potential zip input:', value, 'classes:', input.className);
                            // Try to extract zip from this input
                            const zipMatch = value.match(/\b\d{5}(-\d{4})?\b/);
                            if (zipMatch) {
                                const extractedZip = zipMatch[0];
                                // console.log('[RateDialogHandler] ✓ Extracted zip from alternative input:', extractedZip);
                                // console.log('[RateDialogHandler] ========== extractSenderZipForRateBrowser END ==========');
                                return extractedZip;
                            }
                        }
                    }
                }
            }
            
            // Fallback: Try to get sender zip from class="title-xfcwNVW" (old method)
            // console.log('[RateDialogHandler] Step 2: Fallback - looking for .title-xfcwNVW (with retry logic)...');
            let senderZipEl = null;
            
            // Try with retry logic
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                senderZipEl = document.querySelector('.title-xfcwNVW');
                if (senderZipEl) {
                    // console.log(`[RateDialogHandler] ✓ Found .title-xfcwNVW on attempt ${attempt}`);
                    break;
                }
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
            
            if (senderZipEl) {
                let senderZip = senderZipEl.textContent.trim();
                // console.log('[RateDialogHandler] Found .title-xfcwNVW, raw text:', senderZip);
                
                // Convert "Test Locale" to "80224"
                if (senderZip === 'Test Locale') {
                    // console.log('[RateDialogHandler] Converting "Test Locale" to "80224"');
                    senderZip = '80224';
                } else {
                    // Extract zip code if it's part of a longer string
                    const zipMatch = senderZip.match(/\b\d{5}(-\d{4})?\b/);
                    if (zipMatch) {
                        senderZip = zipMatch[0];
                        // console.log('[RateDialogHandler] Extracted zip code from text:', senderZip);
                    }
                }
                
                if (senderZip && /^\d{5}(-\d{4})?$/.test(senderZip)) {
                    // console.log('[RateDialogHandler] ✓ Final sender zip from fallback:', senderZip);
                    // console.log('[RateDialogHandler] ============================================');
                    return senderZip;
                }
            } else {
                // console.warn('[RateDialogHandler] Fallback element (.title-xfcwNVW) not found');
            }

            // console.error('[RateDialogHandler] ❌ FAILED: Could not extract sender zip from any source');
            // console.error('[RateDialogHandler] This will prevent quote API from working');
            // console.error('[RateDialogHandler] Document body HTML (first 500 chars):', document.body ? document.body.innerHTML.substring(0, 500) : 'N/A');
            // console.log('[RateDialogHandler] ========== extractSenderZipForRateBrowser END ==========');
            return null;
        }

        extractSenderZip(rateElement) {
            // console.log('[RateDialogHandler] Extracting senderZip...');
            // console.log('[RateDialogHandler] Searching entire document for .title-xfcwNVW');
            const zipEl = document.querySelector('.title-xfcwNVW');
            // console.log('[RateDialogHandler] Zip element found:', zipEl);
            if (zipEl) {
                const zipText = zipEl.textContent.trim();
                // console.log('[RateDialogHandler] Zip text:', zipText);
                if (zipText === 'Test Locale') {
                    // console.log('[RateDialogHandler] Converting "Test Locale" to "80224"');
                    return '80224';
                }
                return zipText;
            }
            // console.warn('[RateDialogHandler] Zip element not found in document');
            // console.warn('[RateDialogHandler] Available elements with "title" in class:');
            const allTitles = document.querySelectorAll('[class*="title"]');
            // console.log('[RateDialogHandler] Found', allTitles.length, 'elements with "title" in class');
            if (allTitles.length > 0) {
                // console.log('[RateDialogHandler] First few title elements:', Array.from(allTitles.slice(0, 5)).map(el => ({
                //     class: el.className,
                //     text: el.textContent.trim().substring(0, 50)
                // })));
            }
            return null;
        }

        async callQuoteAPI(requestBody) {
            try {
                // console.log('[RateDialogHandler] ========== Calling Quote API ==========');
                // console.log('[RateDialogHandler] Request body (full):', JSON.stringify(requestBody, null, 2));
                // console.log('[RateDialogHandler] Request body serviceCode:', requestBody.serviceCode, '(type:', typeof requestBody.serviceCode, ')');
                // console.log('[RateDialogHandler] Request body sender:', requestBody.sender);
                // console.log('[RateDialogHandler] Request body sender.zip:', requestBody.sender?.zip, '(type:', typeof requestBody.sender?.zip, ')');
                
                // Final check - if values are null/undefined, log error
                if (!requestBody.serviceCode || requestBody.serviceCode === 'null' || requestBody.serviceCode === 'undefined') {
                    // console.error('[RateDialogHandler] ❌ ERROR: serviceCode is missing or invalid in requestBody!');
                    // console.error('[RateDialogHandler] requestBody.serviceCode:', requestBody.serviceCode);
                }
                if (!requestBody.sender?.zip || requestBody.sender.zip === 'null' || requestBody.sender.zip === 'undefined') {
                    // console.error('[RateDialogHandler] ❌ ERROR: sender.zip is missing or invalid in requestBody!');
                    // console.error('[RateDialogHandler] requestBody.sender.zip:', requestBody.sender?.zip);
                }
                
                // console.log('[RateDialogHandler] Sending message to background script...');

                return new Promise((resolve, reject) => {
                    let responded = false;
                    const timeout = setTimeout(() => {
                        if (!responded) {
                            responded = true;
                            // console.error('[RateDialogHandler] ❌ Timeout waiting for response from background script');
                            reject(new Error('Timeout waiting for response from background script'));
                        }
                    }, 30000);

                    try {
                        if (!chrome.runtime || !chrome.runtime.id) {
                            clearTimeout(timeout);
                            responded = true;
                            // Silently handle extension context invalidation - this is expected during reloads
                            reject(new Error('Extension context invalidated'));
                            return;
                        }

                        chrome.runtime.sendMessage({
                            action: 'callQuoteAPI',
                            requestBody: requestBody
                        }, (response) => {
                            if (responded) {
                                return;
                            }

                            if (chrome.runtime.lastError) {
                                responded = true;
                                clearTimeout(timeout);
                                const errorMsg = chrome.runtime.lastError.message;
                                if (errorMsg.includes('Extension context invalidated') || 
                                    errorMsg.includes('message channel closed')) {
                                    // Silently handle extension context invalidation - this is expected during reloads
                                } else {
                                    // console.error('[RateDialogHandler] ❌ Chrome runtime error:', errorMsg);
                                }
                                reject(new Error(errorMsg));
                                return;
                            }

                            responded = true;
                            clearTimeout(timeout);

                            if (!response) {
                                // console.error('[RateDialogHandler] ❌ No response received from background script');
                                reject(new Error('No response received from background script'));
                                return;
                            }

                            // console.log('[RateDialogHandler] Message response received from background script');
                            // console.log('[RateDialogHandler] ========== Quote API Response ==========');
                            // console.log('[RateDialogHandler] Full response object:', response);
                        
                            if (response && response.success) {
                                // console.log('[RateDialogHandler] ✓ Quote API call successful');
                                // console.log('[RateDialogHandler] Response status: SUCCESS');
                                // console.log('[RateDialogHandler] Response data:', JSON.stringify(response.data, null, 2));
                                
                                if (response.data) {
                                    if (response.data.totalAmount) {
                                        // console.log('[RateDialogHandler] ✓ Single service response - totalAmount:', response.data.totalAmount);
                                    } else if (response.data.quotes && Array.isArray(response.data.quotes)) {
                                        // console.log('[RateDialogHandler] ✓ Multi-service response - quotes count:', response.data.quotes.length);
                                        response.data.quotes.forEach((quote, idx) => {
                                            // console.log(`[RateDialogHandler]   Quote ${idx + 1}: serviceCode="${quote.serviceCode}", totalAmount="${quote.totalAmount}"`);
                                        });
                                    } else {
                                        // console.warn('[RateDialogHandler] ⚠️ Unexpected response structure');
                                        // console.warn('[RateDialogHandler] Response keys:', Object.keys(response.data));
                                    }
                                }
                                
                                // console.log('[RateDialogHandler] ========== Quote API call completed ==========');
                                resolve(response.data);
                            } else {
                                // console.error('[RateDialogHandler] ❌ Quote API call failed');
                                // console.error('[RateDialogHandler] Response status: FAILED');
                                // console.error('[RateDialogHandler] Error:', response?.error || 'Unknown error');
                                // console.error('[RateDialogHandler] Full response:', JSON.stringify(response, null, 2));
                                // console.log('[RateDialogHandler] ========== Quote API call completed (with error) ==========');
                                reject(new Error(response?.error || 'Unknown error'));
                            }
                        });
                    } catch (error) {
                        if (!responded) {
                            responded = true;
                            clearTimeout(timeout);
                            const errorMsg = error.message || 'Unknown error';
                            if (errorMsg.includes('Extension context invalidated') || 
                                errorMsg.includes('message channel closed')) {
                                // Silently handle extension context invalidation - this is expected during reloads
                            } else {
                                // console.error('[RateDialogHandler] ❌ Error sending message:', error);
                            }
                            reject(error);
                        }
                    }
                });
            } catch (error) {
                // console.error('[RateDialogHandler] ❌ Quote API call failed with exception:');
                // console.error('[RateDialogHandler] Error type:', error.constructor.name);
                // console.error('[RateDialogHandler] Error message:', error.message);
                // console.error('[RateDialogHandler] Error stack:', error.stack);
                return null;
            }
        }

        async updateRateWithQuoteAPI(rateElement) {
            // console.log('[RateDialogHandler] ========== updateRateWithQuoteAPI called ==========');
            
            // Only process if we're on a ShipStation domain
            if (!isShipStationDomain()) {
                // console.log('[RateDialogHandler] ❌ Not a ShipStation domain, skipping');
                return Promise.resolve();
            }
            
            // EARLY CHECK: For Rate Browser rates, verify serviceLabel is FedEx before proceeding
            // This prevents quote API calls for non-FedEx services
            if (rateElement.classList && rateElement.classList.contains('rate-value-xslVnIC')) {
                const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
                const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                
                if (serviceNameEl) {
                    const serviceLabel = serviceNameEl.textContent.trim();
                    const serviceLabelLower = serviceLabel.toLowerCase();
                    const isFedExService = serviceLabelLower.startsWith('fedex');
                    const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
                    
                    // If NOT FedEx or IS "FedEx by ShipStation", skip immediately - don't call quote API
                    if (!isFedExService || isFedExByShipStation) {
                        // console.log('[RateDialogHandler] ⏭️ EARLY CHECK: Non-FedEx service detected, skipping quote API call:', serviceLabel);
                        // console.log('[RateDialogHandler] Quote API will NOT be called for this service');
                        // Remove any existing marks
                        this.removeRateMark(rateElement);
                        // Clear cache if exists
                        if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                            this.originalRateValues.delete(rateElement);
                        }
                        // Update tracked serviceLabel
                        this.rateServiceLabels.set(rateElement, serviceLabel);
                        return Promise.resolve();
                    }
                    // console.log('[RateDialogHandler] ✓ EARLY CHECK: Confirmed FedEx service, proceeding with quote API:', serviceLabel);
                } else {
                    // If we can't find serviceLabel, don't proceed - safer to skip
                    // console.warn('[RateDialogHandler] ⚠️ EARLY CHECK: Could not find serviceLabel, skipping to avoid incorrect API calls');
                    this.removeRateMark(rateElement);
                    return Promise.resolve();
                }
            }
            
            // Check if rate element is inside a dialog/modal container
            // Also check document for dialog presence
            const checkDialog = () => {
                // Check if rate element is inside a modal/dialog
                let parent = rateElement.parentElement;
                let depth = 0;
                while (parent && depth < 10) {
                    const classList = parent.classList;
                    if (classList) {
                        const classStr = Array.from(classList).join(' ');
                        if (classStr.includes('modal') || classStr.includes('dialog') || 
                            classStr.includes('Modal') || classStr.includes('Dialog')) {
                            return true;
                        }
                    }
                    parent = parent.parentElement;
                    depth++;
                }
                
                // Also check document for dialog elements
                return document.querySelector('.modal-header-E8CcJ7Y') || 
                       document.querySelector('[class*="modal"]') ||
                       document.querySelector('[class*="dialog"]') ||
                       document.querySelector('[class*="Modal"]') ||
                       document.querySelector('[class*="Dialog"]');
            };
            
            // Wait a bit and retry dialog check up to 3 times
            let hasDialog = false;
            for (let i = 0; i < 3; i++) {
                await new Promise(resolve => setTimeout(resolve, 300));
                hasDialog = checkDialog();
                // console.log(`[RateDialogHandler] Dialog check attempt ${i + 1} - hasDialog:`, !!hasDialog);
                if (hasDialog) {
                    break;
                }
            }
            
            if (!hasDialog) {
                // console.log('[RateDialogHandler] ⚠️ No dialog detected, but proceeding anyway - will try to extract data');
                // Continue anyway - if data extraction fails, we'll handle it then
                // This allows the feature to work even if dialog detection is imperfect
            } else {
                // console.log('[RateDialogHandler] ✓ Dialog found, proceeding with rate update');
            }

            // console.log('[RateDialogHandler] ========== Starting rate update process ==========');
            // console.log('[RateDialogHandler] Rate element:', rateElement);
            // console.log('[RateDialogHandler] Rate element classes:', rateElement.className);
            // console.log('[RateDialogHandler] Rate element text:', rateElement.textContent.trim());

            const isRate1 = rateElement.classList.contains('with-rate-lasqlhb');
            const isRate2 = rateElement.classList.contains('rate-amount-R6LSuka');
            const isRateBrowser = rateElement.classList.contains('rate-value-xslVnIC');
            
            // Helper function to handle error marks based on rate type
            const handleErrorMark = (rateEl, isSuccess) => {
                if (isRateBrowser) {
                    this.rateBrowserStatusMap.set(rateEl, isSuccess);
                    this.showRateBrowserDialogMark();
                } else if (isRate1) {
                    // For Rate1 (shipment dialog), show mark on rate element AND update dialog title mark
                    this.shipmentDialogStatusMap.set(rateEl, isSuccess);
                    this.showRateMark(rateEl, isSuccess); // Show mark on the rate element itself
                    this.showShipmentDialogMark(); // Update dialog title mark
                } else {
                    this.showRateMark(rateEl, isSuccess);
                }
            };

            // console.log('[RateDialogHandler] Rate type - isRate1:', isRate1, 'isRate2:', isRate2, 'isRateBrowser:', isRateBrowser);

            let orderNumber, serviceCode, senderZip;

            if (isRate1) {
                // console.log('[RateDialogHandler] Processing Rate Type 1 (.with-rate-lasqlhb)');
                orderNumber = this.extractOrderNumberForRate1(rateElement);
                // console.log('[RateDialogHandler] Extracted orderNumber (Rate1):', orderNumber);
                serviceCode = this.extractServiceCodeForRate1(rateElement);
                // console.log('[RateDialogHandler] Extracted serviceCode (Rate1):', serviceCode);
                senderZip = this.extractSenderZip(rateElement);
                // console.log('[RateDialogHandler] Extracted senderZip (Rate1):', senderZip);
            } else if (isRate2) {
                // console.log('[RateDialogHandler] Processing Rate Type 2 (.rate-amount-R6LSuka)');
                orderNumber = this.extractOrderNumberForRate2(rateElement);
                // console.log('[RateDialogHandler] Extracted orderNumber (Rate2):', orderNumber);
                serviceCode = this.extractServiceCodeForRate2(rateElement);
                // console.log('[RateDialogHandler] Extracted serviceCode (Rate2):', serviceCode);
                senderZip = this.extractSenderZip(rateElement);
                // console.log('[RateDialogHandler] Extracted senderZip (Rate2):', senderZip);
            } else if (isRateBrowser) {
                // console.log('[RateDialogHandler] ========== Processing Rate Browser Rate ==========');
                // console.log('[RateDialogHandler] Rate element:', rateElement);
                // console.log('[RateDialogHandler] Rate element HTML:', rateElement.outerHTML.substring(0, 200));
                
                // console.log('[RateDialogHandler] Step 1: Extracting orderNumber...');
                orderNumber = this.extractOrderNumberForRateBrowser(rateElement);
                // console.log('[RateDialogHandler] ✓ Extracted orderNumber (RateBrowser):', orderNumber);
                
                // console.log('[RateDialogHandler] Step 2: Extracting serviceCode...');
                // console.log('[RateDialogHandler] serviceLabelToCodeMap available:', !!serviceLabelToCodeMap);
                if (serviceLabelToCodeMap) {
                    // console.log('[RateDialogHandler] serviceLabelToCodeMap has', Object.keys(serviceLabelToCodeMap).length, 'entries');
                }
                serviceCode = this.extractServiceCodeForRateBrowser(rateElement);
                // console.log('[RateDialogHandler] ✓ Extracted serviceCode (RateBrowser):', serviceCode);
                if (!serviceCode) {
                    // console.error('[RateDialogHandler] ❌ serviceCode extraction FAILED - will cause quote API to fail');
                }
                
                // console.log('[RateDialogHandler] Step 3: Extracting senderZip...');
                senderZip = await this.extractSenderZipForRateBrowser(rateElement);
                // console.log('[RateDialogHandler] ✓ Extracted senderZip (RateBrowser):', senderZip);
                if (!senderZip) {
                    // console.error('[RateDialogHandler] ❌ senderZip extraction FAILED - will cause quote API to fail');
                }
                
                // console.log('[RateDialogHandler] ========== Extraction Summary ==========');
                // console.log('[RateDialogHandler] orderNumber:', orderNumber || 'NULL');
                // console.log('[RateDialogHandler] serviceCode:', serviceCode || 'NULL');
                // console.log('[RateDialogHandler] senderZip:', senderZip || 'NULL');
                // console.log('[RateDialogHandler] =========================================');
            } else {
                // Skip elements that don't match our rate element types (e.g., "without-rate" elements)
                // console.log('[RateDialogHandler] ❌ Rate element does not match Rate1, Rate2, or RateBrowser types, skipping');
                return Promise.resolve();
            }

            // console.log('[RateDialogHandler] ========== Final Extracted Values ==========');
            // console.log('[RateDialogHandler] ✓ orderNumber (extracted):', orderNumber, typeof orderNumber === 'string' ? `(length: ${orderNumber.length})` : '');
            // console.log('[RateDialogHandler] ✓ serviceCode:', serviceCode, serviceCode ? `(length: ${serviceCode.length})` : 'NOT FOUND');
            // console.log('[RateDialogHandler] ✓ senderZip:', senderZip, senderZip ? `(length: ${senderZip.length})` : 'NOT FOUND');
            
            // FALLBACK: Only use fallback if orderNumber is truly null/undefined/empty
            // CRITICAL: If orderNumber was extracted correctly, we MUST use it, not the fallback!
            const extractedOrderNumber = orderNumber; // Store the extracted value
            const isValidOrderNumber = orderNumber && 
                                     orderNumber !== null && 
                                     orderNumber !== undefined && 
                                     String(orderNumber).trim() !== '' &&
                                     String(orderNumber).trim() !== 'null' &&
                                     String(orderNumber).trim() !== 'undefined';
            
            if (!isValidOrderNumber) {
                // console.log('[RateDialogHandler] ⚠️ Extracted orderNumber is invalid/null/empty, trying fallback from globalQuoteRequests...');
                // console.log('[RateDialogHandler] Extracted orderNumber value:', extractedOrderNumber, '(type:', typeof extractedOrderNumber, ')');
                
                if (globalQuoteRequests && Object.keys(globalQuoteRequests).length > 0) {
                    const availableOrderNumbers = Object.keys(globalQuoteRequests);
                    const fallbackOrderNumber = availableOrderNumbers[0]; // Use first available orderNumber
                    // console.log('[RateDialogHandler] ✓ Using FALLBACK orderNumber from globalQuoteRequests:', fallbackOrderNumber);
                    // console.log('[RateDialogHandler] Available order numbers:', availableOrderNumbers);
                    // console.log('[RateDialogHandler] ⚠️ WARNING: Using fallback orderNumber instead of extracted one!');
                    orderNumber = fallbackOrderNumber;
                    // Also update mostRecentOrderNumber for future use
                    mostRecentOrderNumber = orderNumber;
                } else {
                    // console.warn('[RateDialogHandler] ⚠️ No orderNumber extracted and no quote requests available for fallback');
                }
            } else {
                // console.log('[RateDialogHandler] ✓ Using EXTRACTED orderNumber (not using fallback):', orderNumber);
                // Make sure it's a clean string
                orderNumber = String(orderNumber).trim();
            }
            
            // console.log('[RateDialogHandler] ✓ Final orderNumber to use:', orderNumber, typeof orderNumber === 'string' ? `(length: ${orderNumber.length})` : '');
            // console.log('[RateDialogHandler] ============================================');

            // For Rate Browser: if serviceCode is null (non-FedEx or FedEx by ShipStation), skip processing
            if (isRateBrowser && !serviceCode) {
                // console.log('[RateDialogHandler] ⏭️ Rate Browser rate skipped (non-FedEx or FedEx by ShipStation)');
                
                // Try to get current serviceLabel to check if it changed
                const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
                const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                if (serviceNameEl) {
                    const currentServiceLabel = serviceNameEl.textContent.trim();
                    const previousServiceLabel = this.rateServiceLabels.get(rateElement);
                    
                    // Check if serviceLabel has changed from FedEx to non-FedEx
                    if (previousServiceLabel && previousServiceLabel.toLowerCase().startsWith('fedex') && 
                        !previousServiceLabel.toLowerCase().includes('by shipstation') &&
                        !currentServiceLabel.toLowerCase().startsWith('fedex')) {
                        // console.log('[RateDialogHandler] ⚠️ ServiceLabel changed from FedEx to non-FedEx!');
                        // console.log('[RateDialogHandler] Previous:', previousServiceLabel, 'Current:', currentServiceLabel);
                        // Clear all cached data for this element
                        if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                            // console.log('[RateDialogHandler] Clearing cached FedEx value due to service change');
                            this.originalRateValues.delete(rateElement);
                        }
                    }
                    
                    // Update tracked serviceLabel
                    this.rateServiceLabels.set(rateElement, currentServiceLabel);
                }
                
                // Remove any existing marks (success or error) for excluded services
                this.removeRateMark(rateElement);
                // DO NOTHING ELSE - don't restore, don't cache, don't process
                // Just leave the rate value as-is from the DOM (ShipStation will update it correctly)
                // console.log('[RateDialogHandler] Leaving non-FedEx rate value untouched');
                return Promise.resolve();
            }

            if (!orderNumber) {
                // console.error('[RateDialogHandler] ❌ CRITICAL: orderNumber is still null after fallback attempt!');
                // console.error('[RateDialogHandler] This should not happen - orderNumber must have a value');
                // console.error('[RateDialogHandler] globalQuoteRequests:', globalQuoteRequests);
                // console.error('[RateDialogHandler] globalQuoteRequests keys:', globalQuoteRequests ? Object.keys(globalQuoteRequests) : 'N/A');
                
                // Only log error if we're actually in a dialog context (should have orderNumber)
                if (hasDialog) {
                    // console.warn('[RateDialogHandler] ⚠️ Could not extract orderNumber and no fallback available (dialog context detected)');
                    // Restore original rate value before showing error mark
                    this.restoreRateValue(rateElement);
                    handleErrorMark(rateElement, false);
                    this.sendEmailNotification(null, serviceCode, 'Failed to extract orderNumber and no fallback available', rateElement);
                } else {
                    // Restore rate value even if no dialog (might have been hidden)
                    this.restoreRateValue(rateElement);
                }
                // Don't show error mark if we're not in a dialog - elements might not exist yet
                return Promise.resolve();
            }

            // console.log('[RateDialogHandler] Checking globalQuoteRequests...');
            // console.log('[RateDialogHandler] Available orderNumbers in globalQuoteRequests:', Object.keys(globalQuoteRequests));
            // console.log('[RateDialogHandler] globalQuoteRequests object:', globalQuoteRequests);
            // console.log('[RateDialogHandler] Looking for quote request with orderNumber:', orderNumber);

            const quoteRequest = globalQuoteRequests[orderNumber];
            if (!quoteRequest) {
                // console.error(`[RateDialogHandler] ❌ No quote request found for order ${orderNumber}`);
                // console.error(`[RateDialogHandler] Available orders:`, Object.keys(globalQuoteRequests));
                // Restore original rate value before showing error mark
                this.restoreRateValue(rateElement);
                handleErrorMark(rateElement, false);
                this.sendEmailNotification(orderNumber, serviceCode, 'No quote request found in cache', rateElement);
                return Promise.resolve();
            }

            // console.log('[RateDialogHandler] ✓ Found quote request for order:', orderNumber);
            // console.log('[RateDialogHandler] Original quote request:', JSON.stringify(quoteRequest, null, 2));

            const requestBody = JSON.parse(JSON.stringify(quoteRequest));
            
            // console.log('[RateDialogHandler] ========== Building Request Body ==========');
            // console.log('[RateDialogHandler] Before updating requestBody:');
            // console.log('[RateDialogHandler]   - serviceCode:', requestBody.serviceCode);
            // console.log('[RateDialogHandler]   - sender.zip:', requestBody.sender?.zip);
            // console.log('[RateDialogHandler] Extracted values (raw):');
            // console.log('[RateDialogHandler]   - extracted serviceCode:', serviceCode, '(type:', typeof serviceCode, ')');
            // console.log('[RateDialogHandler]   - extracted senderZip:', senderZip, '(type:', typeof senderZip, ')');
            // console.log('[RateDialogHandler]   - serviceCode truthy?', !!serviceCode);
            // console.log('[RateDialogHandler]   - senderZip truthy?', !!senderZip);

            // CRITICAL: serviceCode and sender.zip must be set for quote API to work
            // Always assign the extracted values - don't rely on truthiness check
            if (serviceCode !== null && serviceCode !== undefined && serviceCode !== '') {
                requestBody.serviceCode = String(serviceCode).trim();
                // console.log('[RateDialogHandler] ✓ Updated serviceCode to:', requestBody.serviceCode);
                // console.log('[RateDialogHandler] ✓ requestBody.serviceCode after assignment:', requestBody.serviceCode);
            } else {
                // console.error('[RateDialogHandler] ❌ CRITICAL: No serviceCode extracted!');
                // console.error('[RateDialogHandler] serviceCode value:', serviceCode);
                // console.error('[RateDialogHandler] serviceCode type:', typeof serviceCode);
                // console.error('[RateDialogHandler] This will cause quote API to fail');
                // console.error('[RateDialogHandler] Original serviceCode in request:', requestBody.serviceCode);
                // Don't proceed if serviceCode is missing - it's required
                this.restoreRateValue(rateElement);
                handleErrorMark(rateElement, false);
                this.sendEmailNotification(orderNumber, null, 'Failed to extract serviceCode from Rate Browser', rateElement);
                return Promise.resolve();
            }

            // Ensure sender object exists
            if (!requestBody.sender) {
                requestBody.sender = {};
            }
            
            if (senderZip !== null && senderZip !== undefined && senderZip !== '') {
                requestBody.sender.zip = String(senderZip).trim();
                // console.log('[RateDialogHandler] ✓ Updated sender.zip to:', requestBody.sender.zip);
                // console.log('[RateDialogHandler] ✓ requestBody.sender.zip after assignment:', requestBody.sender.zip);
            } else {
                // console.error('[RateDialogHandler] ❌ CRITICAL: No senderZip extracted!');
                // console.error('[RateDialogHandler] senderZip value:', senderZip);
                // console.error('[RateDialogHandler] senderZip type:', typeof senderZip);
                // console.error('[RateDialogHandler] This will cause quote API to fail');
                // console.error('[RateDialogHandler] Original sender.zip in request:', requestBody.sender?.zip);
                // Don't proceed if senderZip is missing - it's required
                this.restoreRateValue(rateElement);
                handleErrorMark(rateElement, false);
                this.sendEmailNotification(orderNumber, serviceCode, 'Failed to extract sender zip from Rate Browser', rateElement);
                return Promise.resolve();
            }

            // Verify the values are actually in requestBody before sending
            // console.log('[RateDialogHandler] ========== Request Body Verification ==========');
            // console.log('[RateDialogHandler] requestBody.serviceCode:', requestBody.serviceCode, '(type:', typeof requestBody.serviceCode, ')');
            // console.log('[RateDialogHandler] requestBody.sender:', requestBody.sender);
            // console.log('[RateDialogHandler] requestBody.sender.zip:', requestBody.sender?.zip, '(type:', typeof requestBody.sender?.zip, ')');
            
            if (!requestBody.serviceCode || requestBody.serviceCode === 'null' || requestBody.serviceCode === 'undefined') {
                // console.error('[RateDialogHandler] ❌ VERIFICATION FAILED: serviceCode is invalid in requestBody!');
                // console.error('[RateDialogHandler] requestBody.serviceCode:', requestBody.serviceCode);
            }
            
            if (!requestBody.sender?.zip || requestBody.sender.zip === 'null' || requestBody.sender.zip === 'undefined') {
                // console.error('[RateDialogHandler] ❌ VERIFICATION FAILED: sender.zip is invalid in requestBody!');
                // console.error('[RateDialogHandler] requestBody.sender.zip:', requestBody.sender?.zip);
            }

            // console.log('[RateDialogHandler] Final requestBody to send to API:');
            // console.log(JSON.stringify(requestBody, null, 2));
            // console.log('[RateDialogHandler] ============================================');

            // console.log(`[RateDialogHandler] Calling quote API for order ${orderNumber}...`);
            let quoteResponse;
            try {
                quoteResponse = await this.callQuoteAPI(requestBody);
            } catch (error) {
                const errorMsg = error.message || 'Unknown error';
                if (errorMsg.includes('Extension context invalidated') || 
                    errorMsg.includes('message channel closed')) {
                    // Silently handle extension context invalidation - this is expected during reloads
                    this.restoreRateValue(rateElement);
                    return Promise.resolve();
                }
                // console.error(`[RateDialogHandler] ❌ Quote API call failed for order ${orderNumber}:`, errorMsg);
                // Restore original rate value before showing error mark
                this.restoreRateValue(rateElement);
                handleErrorMark(rateElement, false);
                this.sendEmailNotification(orderNumber, serviceCode, errorMsg, rateElement);
                return Promise.resolve();
            }

            // console.log('[RateDialogHandler] Quote API response received:');
            // console.log('[RateDialogHandler] Response type:', typeof quoteResponse);
            // console.log('[RateDialogHandler] Response:', quoteResponse);
            if (quoteResponse) {
                // console.log('[RateDialogHandler] Response keys:', Object.keys(quoteResponse));
            }

            if (!quoteResponse) {
                // console.error(`[RateDialogHandler] ❌ No quote response for order ${orderNumber}`);
                // Restore original rate value before showing error mark
                this.restoreRateValue(rateElement);
                handleErrorMark(rateElement, false);
                this.sendEmailNotification(orderNumber, serviceCode, 'No quote response received', rateElement);
                return Promise.resolve();
            }

            let totalAmount = null;

            if (quoteResponse.totalAmount) {
                // console.log('[RateDialogHandler] Found totalAmount in response:', quoteResponse.totalAmount);
                totalAmount = parseFloat(quoteResponse.totalAmount);
                // console.log('[RateDialogHandler] Parsed totalAmount:', totalAmount);
            } else if (quoteResponse.quotes && Array.isArray(quoteResponse.quotes)) {
                // console.log('[RateDialogHandler] Found quotes array with', quoteResponse.quotes.length, 'quotes');
                if (serviceCode) {
                    // console.log('[RateDialogHandler] Looking for quote with serviceCode:', serviceCode);
                    const matchingQuote = quoteResponse.quotes.find(q => q.serviceCode === serviceCode);
                    // console.log('[RateDialogHandler] Matching quote:', matchingQuote);
                    if (matchingQuote && matchingQuote.totalAmount) {
                        totalAmount = parseFloat(matchingQuote.totalAmount);
                        // console.log('[RateDialogHandler] Using matching quote totalAmount:', totalAmount);
                    } else if (quoteResponse.quotes.length > 0 && quoteResponse.quotes[0].totalAmount) {
                        totalAmount = parseFloat(quoteResponse.quotes[0].totalAmount);
                        // console.log('[RateDialogHandler] Using first quote totalAmount:', totalAmount);
                    }
                } else if (quoteResponse.quotes.length > 0 && quoteResponse.quotes[0].totalAmount) {
                    totalAmount = parseFloat(quoteResponse.quotes[0].totalAmount);
                    // console.log('[RateDialogHandler] Using first quote totalAmount (no serviceCode):', totalAmount);
                }
            } else {
                // console.warn('[RateDialogHandler] ⚠️ Response structure not recognized. Available keys:', Object.keys(quoteResponse));
            }

            // console.log('[RateDialogHandler] Final totalAmount:', totalAmount);
            // console.log('[RateDialogHandler] totalAmount isNaN:', isNaN(totalAmount));

            if (totalAmount === null || isNaN(totalAmount)) {
                // console.error(`[RateDialogHandler] ❌ Invalid totalAmount for order ${orderNumber}`);
                // console.error('[RateDialogHandler] Response structure:', JSON.stringify(quoteResponse, null, 2));
                // Restore original rate value before showing error mark
                this.restoreRateValue(rateElement);
                handleErrorMark(rateElement, false);
                this.sendEmailNotification(orderNumber, serviceCode, 'Invalid totalAmount in response', rateElement);
                return Promise.resolve();
            }

            // console.log('[RateDialogHandler] ✓ Successfully extracted totalAmount:', totalAmount);
            
            // FINAL CHECK: Verify serviceLabel is still FedEx before updating DOM
            // This prevents updating non-FedEx services with FedEx values
            if (isRateBrowser) {
                const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
                const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                if (serviceNameEl) {
                    const currentServiceLabel = serviceNameEl.textContent.trim();
                    const serviceLabelLower = currentServiceLabel.toLowerCase();
                    const isFedExService = serviceLabelLower.startsWith('fedex');
                    const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
                    
                    // BLOCK: If NOT FedEx, don't update DOM
                    if (!isFedExService || isFedExByShipStation) {
                        // console.log('[RateDialogHandler] 🚫 BLOCKED: Service changed to non-FedEx before update, blocking DOM update:', currentServiceLabel);
                        // Clear cache
                        if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                            this.originalRateValues.delete(rateElement);
                        }
                        // Remove marks
                        this.removeRateMark(rateElement);
                        // Restore opacity but don't update value
                        rateElement.style.opacity = '1';
                        // Update tracked serviceLabel
                        this.rateServiceLabels.set(rateElement, currentServiceLabel);
                        return Promise.resolve();
                    }
                    // console.log('[RateDialogHandler] ✓ Final check: Confirmed FedEx service, proceeding with DOM update');
                }
            }
            
            // console.log('[RateDialogHandler] Updating rate value...');
            this.updateRateValue(rateElement, totalAmount);
            // Show rate value immediately after update
            rateElement.style.opacity = '1';
            
            // For Rate Browser rates, track status and update dialog title mark instead of showing individual marks
            if (isRateBrowser) {
                this.rateBrowserStatusMap.set(rateElement, true); // Mark as success
                this.showRateBrowserDialogMark(); // Update dialog title mark
            } else if (isRate1) {
                // For Rate1 (shipment dialog), show mark on rate element AND update dialog title mark
                this.shipmentDialogStatusMap.set(rateElement, true); // Mark as success
                this.showRateMark(rateElement, true); // Show mark on the rate element itself
                this.showShipmentDialogMark(); // Update dialog title mark
            } else {
                // For Rate2, show individual marks as before
                this.showRateMark(rateElement, true);
            }
            
            // Log successful rate update for user visibility
            const serviceName = this.extractServiceName(rateElement, isRate1, isRate2, isRateBrowser);
            const formattedAmount = this.formatCurrency(totalAmount);
            if (serviceName) {
                console.log(`The expected rates for ${serviceName} service is ${formattedAmount}`);
            } else {
                console.log(`The expected rates for service is ${formattedAmount}`);
            }
            
            // console.log('[RateDialogHandler] ========== Rate update process completed ==========');
        }

        hideRateValue(rateElement) {
            // Hide the rate value immediately by making it transparent
            // Store original opacity to restore later if needed
            if (!this.rateElementStyles) {
                this.rateElementStyles = new Map();
            }
            
            const originalOpacity = window.getComputedStyle(rateElement).opacity;
            this.rateElementStyles.set(rateElement, { opacity: originalOpacity });
            
            // Make rate value invisible immediately
            rateElement.style.opacity = '0';
            rateElement.style.transition = 'opacity 0.1s';
        }

        restoreRateValue(rateElement) {
            // Restore original opacity if update failed
            if (this.rateElementStyles && this.rateElementStyles.has(rateElement)) {
                const styles = this.rateElementStyles.get(rateElement);
                rateElement.style.opacity = styles.opacity || '1';
            } else {
                rateElement.style.opacity = '1';
            }
            
            // CRITICAL: Check current serviceLabel before restoring cached value
            // If serviceLabel has changed from FedEx to non-FedEx, DO NOT restore cached FedEx value
            let currentServiceLabel = null;
            const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
            const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
            if (serviceNameEl) {
                currentServiceLabel = serviceNameEl.textContent.trim();
            }
            
            // If we can't find serviceLabel, try to get it from our tracking
            if (!currentServiceLabel) {
                currentServiceLabel = this.rateServiceLabels.get(rateElement);
            }
            
            // Check if current service is non-FedEx
            if (currentServiceLabel) {
                const currentServiceLabelLower = currentServiceLabel.toLowerCase();
                const isCurrentFedEx = currentServiceLabelLower.startsWith('fedex');
                const isCurrentFedExByShipStation = currentServiceLabelLower.includes('by shipstation');
                
                // If current service is non-FedEx, clear cache and don't restore
                if (!isCurrentFedEx || isCurrentFedExByShipStation) {
                    // console.log('[RateDialogHandler] restoreRateValue: Current service is non-FedEx, clearing cache and NOT restoring');
                    if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                        this.originalRateValues.delete(rateElement);
                    }
                    // Don't restore - let ShipStation's DOM value be the source of truth
                    return;
                }
            }
            
            // Only restore cached value if this element was actually processed (is in originalRateValues)
            // AND current service is still FedEx
            // This ensures we only restore for FedEx services that were updated, not for non-FedEx services
            if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                const cachedOriginal = this.originalRateValues.get(rateElement);
                const currentText = rateElement.textContent.trim();
                const currentValue = this.extractDollarAmount(currentText);
                
                // If current value doesn't match cached original, restore the cached original
                // This only applies to FedEx services that were updated
                if (currentValue !== null && cachedOriginal !== null && Math.abs(currentValue - cachedOriginal) > 0.01) {
                    // console.log('[RateDialogHandler] Restoring cached original value for FedEx service:', cachedOriginal, 'from current:', currentValue);
                    const formattedAmount = this.formatCurrency(cachedOriginal);
                    // Replace the dollar amount in the text
                    const textNodes = this.getAllTextNodes(rateElement);
                    for (const textNode of textNodes) {
                        const nodeText = textNode.nodeValue || '';
                        if (nodeText.includes('$')) {
                            const newText = nodeText.replace(/\$[\d,]+\.?\d*/g, formattedAmount);
                            textNode.nodeValue = newText;
                            break;
                        }
                    }
                }
            }
        }

        sendEmailNotification(orderNumber, serviceCode, errorMessage, rateElement) {
            // Don't send email for excluded services (non-FedEx or FedEx by ShipStation)
            // Check if this is a Rate Browser rate with null serviceCode
            if (rateElement && rateElement.classList && rateElement.classList.contains('rate-value-xslVnIC')) {
                if (!serviceCode) {
                    // console.log('[RateDialogHandler] ⏭️ Email notification skipped for excluded service (serviceCode is null)');
                    return;
                }
            }
            
            // Prevent duplicate emails for the same error (use a simple cache)
            const emailCacheKey = `${orderNumber}-${errorMessage}`;
            if (!this.emailNotificationCache) {
                this.emailNotificationCache = new Set();
            }
            const cache = this.emailNotificationCache;
            
            // Check if we already sent an email for this error (within last 5 minutes)
            if (cache.has(emailCacheKey)) {
                return;
            }
            
            // Add to cache
            cache.add(emailCacheKey);
            
            // Clear cache entry after 5 minutes to allow retry
            setTimeout(() => {
                cache.delete(emailCacheKey);
            }, 5 * 60 * 1000);
            
            // Extract rate value - prefer stored original value, fallback to element text
            let rateValue = 'N/A';
            if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                const originalAmount = this.originalRateValues.get(rateElement);
                rateValue = this.formatCurrency(originalAmount);
            } else {
                // Fallback: try to extract from element text
                const rateText = rateElement.textContent || '';
                const rateMatch = rateText.match(/\$[\d,]+\.?\d*/);
                rateValue = rateMatch ? rateMatch[0] : 'N/A';
            }
            
            // Get current page URL
            const pageUrl = window.location.href;
            
            // Client email addresses for notifications
            const clientEmailAddresses = [
                'mattblainehill@gmail.com',
                'spencer@freightwire.com'
            ];
            
            // Prepare email data (same data for all recipients)
            const baseEmailData = {
                orderNumber: orderNumber || 'N/A',
                errorMessage: errorMessage || 'Quote API failed',
                serviceCode: serviceCode || 'N/A',
                rateValue: rateValue,
                pageUrl: pageUrl,
                timestamp: new Date().toISOString()
            };
            
            // Send email notification to all client email addresses
            // Send via background script (non-blocking, fire-and-forget)
            // Don't await or block - email is not critical for the rate update flow
            // console.log('[RateDialogHandler] ========== Sending Email Notifications ==========');
            // console.log('[RateDialogHandler] Sending to', clientEmailAddresses.length, 'recipients:', clientEmailAddresses);
            // console.log('[RateDialogHandler] Email data:', baseEmailData);
            
            try {
                if (chrome.runtime && chrome.runtime.id) {
                    // Send email to each recipient
                    clientEmailAddresses.forEach((emailAddress, index) => {
                        const emailData = {
                            ...baseEmailData,
                            toEmail: emailAddress
                        };
                        
                        // console.log(`[RateDialogHandler] Sending email ${index + 1}/${clientEmailAddresses.length} to:`, emailAddress);
                        chrome.runtime.sendMessage({
                            action: 'sendEmailNotification',
                            emailData: emailData
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                // console.error(`[RateDialogHandler] ✗ Failed to send email to ${emailAddress}:`, chrome.runtime.lastError.message);
                                return;
                            }
                            // console.log(`[RateDialogHandler] ✓ Email notification sent to ${emailAddress}`);
                            if (response) {
                                // console.log(`[RateDialogHandler] Background response for ${emailAddress}:`, response);
                            }
                        });
                    });
                } else {
                    // console.error('[RateDialogHandler] ✗ Chrome runtime not available, cannot send email');
                }
            } catch (error) {
                // console.error('[RateDialogHandler] ✗ Exception while sending email notifications:', error);
            }
            // console.log('[RateDialogHandler] ============================================');
        }

        hideRateValue(rateElement) {
            // Hide the rate value immediately by making it transparent
            // Store original opacity to restore later if needed
            if (!this.rateElementStyles) {
                this.rateElementStyles = new Map();
            }
            
            const originalOpacity = window.getComputedStyle(rateElement).opacity;
            this.rateElementStyles.set(rateElement, { opacity: originalOpacity });
            
            // Make rate value invisible immediately
            rateElement.style.opacity = '0';
            rateElement.style.transition = 'opacity 0.1s';
        }

        restoreRateValue(rateElement) {
            // Restore original opacity if update failed
            if (this.rateElementStyles && this.rateElementStyles.has(rateElement)) {
                const styles = this.rateElementStyles.get(rateElement);
                rateElement.style.opacity = styles.opacity || '1';
            } else {
                rateElement.style.opacity = '1';
            }
            
            // CRITICAL: Check current serviceLabel before restoring cached value
            // If serviceLabel has changed from FedEx to non-FedEx, DO NOT restore cached FedEx value
            let currentServiceLabel = null;
            const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
            const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
            if (serviceNameEl) {
                currentServiceLabel = serviceNameEl.textContent.trim();
            }
            
            // If we can't find serviceLabel, try to get it from our tracking
            if (!currentServiceLabel) {
                currentServiceLabel = this.rateServiceLabels.get(rateElement);
            }
            
            // Check if current service is non-FedEx
            if (currentServiceLabel) {
                const currentServiceLabelLower = currentServiceLabel.toLowerCase();
                const isCurrentFedEx = currentServiceLabelLower.startsWith('fedex');
                const isCurrentFedExByShipStation = currentServiceLabelLower.includes('by shipstation');
                
                // If current service is non-FedEx, clear cache and don't restore
                if (!isCurrentFedEx || isCurrentFedExByShipStation) {
                    // console.log('[RateDialogHandler] restoreRateValue: Current service is non-FedEx, clearing cache and NOT restoring');
                    if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                        this.originalRateValues.delete(rateElement);
                    }
                    // Don't restore - let ShipStation's DOM value be the source of truth
                    return;
                }
            }
            
            // Only restore cached value if this element was actually processed (is in originalRateValues)
            // AND current service is still FedEx
            // This ensures we only restore for FedEx services that were updated, not for non-FedEx services
            if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                const cachedOriginal = this.originalRateValues.get(rateElement);
                const currentText = rateElement.textContent.trim();
                const currentValue = this.extractDollarAmount(currentText);
                
                // If current value doesn't match cached original, restore the cached original
                // This only applies to FedEx services that were updated
                if (currentValue !== null && cachedOriginal !== null && Math.abs(currentValue - cachedOriginal) > 0.01) {
                    // console.log('[RateDialogHandler] Restoring cached original value for FedEx service:', cachedOriginal, 'from current:', currentValue);
                    const formattedAmount = this.formatCurrency(cachedOriginal);
                    // Replace the dollar amount in the text
                    const textNodes = this.getAllTextNodes(rateElement);
                    for (const textNode of textNodes) {
                        const nodeText = textNode.nodeValue || '';
                        if (nodeText.includes('$')) {
                            const newText = nodeText.replace(/\$[\d,]+\.?\d*/g, formattedAmount);
                            textNode.nodeValue = newText;
                            break;
                        }
                    }
                }
            }
        }

        removeRateMark(rateElement) {
            const markClass = 'fedex-rate-mark';
            // Remove all existing marks (both success and error)
            const existingMarks = rateElement.querySelectorAll(`.${markClass}`);
            existingMarks.forEach(mark => mark.remove());
            // console.log('[RateDialogHandler] Removed', existingMarks.length, 'existing mark(s) from rate element');
        }

        showRateMark(rateElement, isSuccess) {
            const markClass = 'fedex-rate-mark';
            
            // console.log('[RateDialogHandler] ========== showRateMark called ==========');
            // console.log('[RateDialogHandler] Rate element:', rateElement);
            // console.log('[RateDialogHandler] isSuccess:', isSuccess);
            
            // Remove all existing marks first to ensure only one mark exists
            const existingMarks = rateElement.querySelectorAll(`.${markClass}`);
            existingMarks.forEach(mark => mark.remove());
            // console.log('[RateDialogHandler] Removed', existingMarks.length, 'existing mark(s)');
            
            // Create new mark element
            const markElement = document.createElement('span');
            markElement.className = markClass;
            // Make mark more visible - larger size and better positioning
            markElement.style.cssText = 'display: inline-block; margin-right: 8px; font-size: 1.2em; font-weight: bold; vertical-align: middle; line-height: 1;';
            
            if (isSuccess) {
                markElement.textContent = '✓';
                markElement.style.color = '#10b981';
                // console.log('[RateDialogHandler] ✓ Creating green checkmark');
            } else {
                markElement.textContent = '✗';
                markElement.style.color = '#ef4444';
                // console.log('[RateDialogHandler] ✗ Creating red cross');
            }
            
            // Find the text node containing the dollar amount and insert mark before it
            const textNodes = this.getAllTextNodes(rateElement);
            let inserted = false;
            
            // console.log('[RateDialogHandler] Searching', textNodes.length, 'text nodes for dollar amount...');
            for (const textNode of textNodes) {
                if (textNode.nodeValue && textNode.nodeValue.includes('$')) {
                    const parent = textNode.parentNode;
                    if (parent) {
                        // Insert the mark right before the text node containing the dollar amount
                        parent.insertBefore(markElement, textNode);
                        inserted = true;
                        // console.log('[RateDialogHandler] ✓ Inserted mark before dollar amount text node');
                        break;
                    }
                }
            }
            
            // Fallback: if we couldn't find the dollar amount, prepend to rateElement
            if (!inserted) {
                // console.log('[RateDialogHandler] Could not find dollar amount, using fallback insertion');
                if (rateElement.firstChild) {
                    rateElement.insertBefore(markElement, rateElement.firstChild);
                    // console.log('[RateDialogHandler] ✓ Inserted mark as first child');
                } else {
                    rateElement.appendChild(markElement);
                    // console.log('[RateDialogHandler] ✓ Appended mark to element');
                }
            }
            
            // console.log('[RateDialogHandler] ========== showRateMark completed ==========');
        }

        updateRateValue(rateElement, newAmount) {
            // CRITICAL: Final check before updating DOM - verify serviceLabel is FedEx
            // This is the last line of defense to prevent updating non-FedEx services
            if (rateElement.classList && rateElement.classList.contains('rate-value-xslVnIC')) {
                const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
                const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                if (serviceNameEl) {
                    const serviceLabel = serviceNameEl.textContent.trim();
                    const serviceLabelLower = serviceLabel.toLowerCase();
                    const isFedExService = serviceLabelLower.startsWith('fedex');
                    const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
                    
                    // BLOCK: If NOT FedEx, don't update DOM
                    if (!isFedExService || isFedExByShipStation) {
                        // console.log('[RateDialogHandler] 🚫 BLOCKED: updateRateValue - Non-FedEx service detected, blocking DOM update:', serviceLabel);
                        // Clear cache
                        if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                            this.originalRateValues.delete(rateElement);
                        }
                        // Don't update DOM - let ShipStation's value remain
                        return;
                    }
                }
            }
            
            const formattedAmount = this.formatCurrency(newAmount);
            const textNodes = this.getAllTextNodes(rateElement);
            let updated = false;
            
            for (const textNode of textNodes) {
                const nodeText = textNode.nodeValue || '';
                if (nodeText.includes('$')) {
                    const dollarPattern = /\$[\d,]+\.?\d*/;
                    if (dollarPattern.test(nodeText)) {
                        const updatedNodeText = nodeText.replace(dollarPattern, formattedAmount);
                        if (updatedNodeText !== nodeText) {
                            textNode.nodeValue = updatedNodeText;
                            updated = true;
                            break;
                        }
                    }
                }
            }
            
            if (!updated) {
                const fullText = rateElement.textContent || '';
                const dollarPattern = /\$[\d,]+\.?\d*/;
                if (dollarPattern.test(fullText)) {
                    const updatedText = fullText.replace(dollarPattern, formattedAmount);
                    const firstTextNode = textNodes[0];
                    if (firstTextNode) {
                        firstTextNode.nodeValue = updatedText;
                    }
                }
            }
            
            // console.log('[RateDialogHandler] Rate updated to:', formattedAmount);
        }

        setupRateObserver(rateElement) {
            if (this.rateObservers.has(rateElement)) {
                return;
            }

            const observer = new MutationObserver((mutations) => {
                // Only process if we're on a ShipStation domain
                if (!isShipStationDomain()) {
                    return;
                }
                
                let shouldUpdate = false;
                
                for (const mutation of mutations) {
                    if (mutation.type === 'childList' || mutation.type === 'characterData') {
                        shouldUpdate = true;
                        break;
                    }
                }

                if (shouldUpdate) {
                    setTimeout(() => {
                        if (!isShipStationDomain()) {
                            return;
                        }
                        if (!this.processedRates.has(rateElement)) {
                            return;
                        }
                        
                        // CRITICAL: Check if serviceLabel is still FedEx before updating
                        // This prevents updates when serviceLabel changes to non-FedEx
                        if (rateElement.classList && rateElement.classList.contains('rate-value-xslVnIC')) {
                            const rateInfoContainer = rateElement.closest('.rate-information-vbp6sBx') || rateElement.parentElement;
                            const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                            
                            if (serviceNameEl) {
                                const serviceLabel = serviceNameEl.textContent.trim();
                                const serviceLabelLower = serviceLabel.toLowerCase();
                                const isFedExService = serviceLabelLower.startsWith('fedex');
                                const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
                                
                                // BLOCK: If NOT FedEx, don't update
                                if (!isFedExService || isFedExByShipStation) {
                                    // console.log('[RateDialogHandler] 🚫 BLOCKED: Observer detected non-FedEx service, blocking update:', serviceLabel);
                                    // Clear cache and remove marks
                                    if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                                        this.originalRateValues.delete(rateElement);
                                    }
                                    this.removeRateMark(rateElement);
                                    this.rateServiceLabels.set(rateElement, serviceLabel);
                                    return; // Don't call updateRateWithQuoteAPI
                                }
                            }
                        }
                        
                        this.updateRateWithQuoteAPI(rateElement).catch(() => {});
                    }, 100);
                }
            });

            observer.observe(rateElement, {
                childList: true,
                subtree: true,
                characterData: true
            });

            this.rateObservers.set(rateElement, observer);
        }

        extractDollarAmount(text) {
            const match = text.match(/\$([\d,]+\.?\d*)/);
            // console.log('[RateDialogHandler] extractDollarAmount - Text:', text, 'Match:', match);
            if (!match) {
                return null;
            }

            const numberString = match[1].replace(/,/g, '');
            const amount = parseFloat(numberString);
            // console.log('[RateDialogHandler] Parsed amount:', amount);

            if (isNaN(amount) || amount < 0) {
                // console.log('[RateDialogHandler] Invalid amount:', amount);
                return null;
            }

            return amount;
        }

        formatCurrency(amount) {
            return '$' + amount.toFixed(2);
        }

        addRateWarningMessage() {
            // Only add warning on ShipStation domains
            if (!isShipStationDomain()) {
                return;
            }
            
            const processedFooters = new WeakSet();
            const warningClass = 'fedex-rate-warning';
            
            const addMessageToFooter = (footer) => {
                // Double-check domain in callback
                if (!isShipStationDomain()) {
                    return;
                }
                
                if (processedFooters.has(footer)) {
                    return;
                }
                
                // Check if warning message already exists in this footer
                if (footer.querySelector(`.${warningClass}`)) {
                    processedFooters.add(footer);
                    return;
                }
                
                try {
                    // Create warning message
                    const warningMessage = document.createElement('div');
                    warningMessage.className = warningClass;
                    warningMessage.textContent = 'The rates shown may not represent updated rates.';
                    warningMessage.style.cssText = 'display: block; margin-top: 0; margin-left: 0; margin-right: auto; margin-bottom: 10px; padding: 0; font-size: 13px; font-weight: 500; color: #dc2626; line-height: 1.5; width: fit-content; text-align: left; align-self: flex-start;';
                    
                    // Add warning message to footer (before the buttons)
                    footer.insertBefore(warningMessage, footer.firstChild);
                    
                    processedFooters.add(footer);
                    // console.log('[RateDialogHandler] Added rate warning message to export modal footer');
                } catch (error) {
                    // console.error('[RateDialogHandler] Error adding warning message to footer:', error);
                    return;
                }
            };
            
            const checkFooter = () => {
                const footer = document.querySelector('.export-records-modal-footer-QL79vX8');
                if (footer) {
                    addMessageToFooter(footer);
                }
            };
            
            checkFooter();
            
            const footerObserver = new MutationObserver(() => {
                // Only process if we're on a ShipStation domain
                if (!isShipStationDomain()) {
                    return;
                }
                checkFooter();
            });
            
            // Only observe if we're on a ShipStation domain
            if (isShipStationDomain() && document.body) {
                footerObserver.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            }
            
            // Store footerObserver for cleanup (was incorrectly named buttonObserver before)
            this.buttonObserver = footerObserver;
        }

        // Fetch services API and build serviceLabel -> serviceCode mapping
        async fetchServicesAndBuildMapping() {
            if (!isShipStationDomain()) {
                return;
            }

            try {
                // console.log('[RateDialogHandler] ========== Fetching Services API ==========');
                // console.log('[RateDialogHandler] Building serviceLabel -> serviceCode mapping for Rate Browser...');
                
                return new Promise((resolve, reject) => {
                    let responded = false;
                    const timeout = setTimeout(() => {
                        if (!responded) {
                            responded = true;
                            // console.error('[RateDialogHandler] ❌ Timeout waiting for services API response');
                            reject(new Error('Timeout waiting for services API response'));
                        }
                    }, 30000);

                    try {
                        if (!chrome.runtime || !chrome.runtime.id) {
                            clearTimeout(timeout);
                            reject(new Error('Extension context invalidated'));
                            return;
                        }

                        // console.log('[RateDialogHandler] Sending getServices message to background script...');
                        chrome.runtime.sendMessage({
                            action: 'getServices'
                        }, (response) => {
                            if (responded) return;
                            responded = true;
                            clearTimeout(timeout);

                            if (chrome.runtime.lastError) {
                                // console.error('[RateDialogHandler] ❌ Error calling services API:', chrome.runtime.lastError.message);
                                reject(new Error(chrome.runtime.lastError.message));
                                return;
                            }

                            // console.log('[RateDialogHandler] Services API response received:', response);

                            if (!response || !response.success) {
                                // console.error('[RateDialogHandler] ❌ Services API failed:', response?.error || 'Unknown error');
                                reject(new Error(response?.error || 'Services API failed'));
                                return;
                            }

                            // console.log('[RateDialogHandler] ✓ Services API call successful');
                            // console.log('[RateDialogHandler] Response data:', response.data);

                            // Build serviceLabel -> serviceCode mapping
                            // Only include FedEx services (excluding "FedEx by ShipStation")
                            const mapping = {};
                            let totalServices = 0;
                            let fedExServices = 0;
                            let excludedServices = 0;

                            if (response.data && response.data.services && Array.isArray(response.data.services)) {
                                totalServices = response.data.services.length;
                                // console.log('[RateDialogHandler] Total services in response:', totalServices);
                                // console.log('[RateDialogHandler] ========== Processing Services ==========');

                                response.data.services.forEach((service, index) => {
                                    if (service.serviceLabel && service.serviceCode) {
                                        const serviceLabelLower = service.serviceLabel.toLowerCase();
                                        const isFedExService = serviceLabelLower.startsWith('fedex');
                                        const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
                                        
                                        // console.log(`[RateDialogHandler] Service ${index + 1}:`);
                                        // console.log(`[RateDialogHandler]   - serviceLabel: "${service.serviceLabel}"`);
                                        // console.log(`[RateDialogHandler]   - serviceCode: "${service.serviceCode}"`);
                                        // console.log(`[RateDialogHandler]   - isFedExService: ${isFedExService}`);
                                        // console.log(`[RateDialogHandler]   - isFedExByShipStation: ${isFedExByShipStation}`);
                                        
                                        // Only map FedEx services (excluding "FedEx by ShipStation")
                                        if (isFedExService && !isFedExByShipStation) {
                                            fedExServices++;
                                            // Map serviceLabel to serviceCode
                                            mapping[service.serviceLabel] = service.serviceCode;
                                            // Also map common variations (e.g., "FedEx Ground" -> "fedex_ground")
                                            const normalizedLabel = service.serviceLabel.toLowerCase().replace(/\s+/g, '_');
                                            mapping[normalizedLabel] = service.serviceCode;
                                            // console.log(`[RateDialogHandler]   ✓ ADDED to mapping: "${service.serviceLabel}" -> "${service.serviceCode}"`);
                                            // console.log(`[RateDialogHandler]   ✓ Also mapped normalized: "${normalizedLabel}" -> "${service.serviceCode}"`);
                                        } else {
                                            excludedServices++;
                                            if (isFedExByShipStation) {
                                                // console.log(`[RateDialogHandler]   ⏭️ EXCLUDED (FedEx by ShipStation): "${service.serviceLabel}"`);
                                            } else {
                                                // console.log(`[RateDialogHandler]   ⏭️ EXCLUDED (not FedEx): "${service.serviceLabel}"`);
                                            }
                                        }
                                    } else {
                                        // console.log(`[RateDialogHandler] Service ${index + 1}: ⚠️ Missing serviceLabel or serviceCode`);
                                    }
                                });
                            } else {
                                // console.warn('[RateDialogHandler] ⚠️ No services array in response data');
                                // console.warn('[RateDialogHandler] Response structure:', response.data);
                            }

                            serviceLabelToCodeMap = mapping;
                            // console.log('[RateDialogHandler] ========== Mapping Summary ==========');
                            // console.log('[RateDialogHandler] Total services processed:', totalServices);
                            // console.log('[RateDialogHandler] FedEx services added:', fedExServices);
                            // console.log('[RateDialogHandler] Services excluded:', excludedServices);
                            // console.log('[RateDialogHandler] Final mapping entries:', Object.keys(mapping).length);
                            // console.log('[RateDialogHandler] ========== Complete Mapping ==========');
                            // console.log('[RateDialogHandler] serviceLabelToCodeMap:', JSON.stringify(mapping, null, 2));
                            // console.log('[RateDialogHandler] ======================================');
                            // console.log('[RateDialogHandler] ✓ Service label to code mapping built successfully!');
                            resolve(mapping);
                        });
                    } catch (error) {
                        if (!responded) {
                            responded = true;
                            clearTimeout(timeout);
                            // console.error('[RateDialogHandler] ❌ Exception calling services API:', error);
                            reject(error);
                        }
                    }
                });
            } catch (error) {
                // console.error('[RateDialogHandler] ❌ Error in fetchServicesAndBuildMapping:', error);
            }
        }

        // Ensure quote requests are available for Rate Browser
        async ensureQuoteRequestsForRateBrowser() {
            // console.log('[RateDialogHandler] ========== ensureQuoteRequestsForRateBrowser called ==========');
            // console.log('[RateDialogHandler] This will fetch order data from ShipStation API if needed');
            
            // Check if service mapping is ready (needed for serviceCode extraction)
            if (!serviceLabelToCodeMap) {
                // console.log('[RateDialogHandler] ⚠️ serviceLabelToCodeMap not ready yet, waiting...');
                // Wait up to 5 seconds for service mapping to be built
                const maxWait = 5000;
                const checkInterval = 200;
                const startTime = Date.now();
                while (!serviceLabelToCodeMap && (Date.now() - startTime) < maxWait) {
                    await new Promise(resolve => setTimeout(resolve, checkInterval));
                }
                if (serviceLabelToCodeMap) {
                    // console.log('[RateDialogHandler] ✓ serviceLabelToCodeMap is now ready');
                } else {
                    // console.warn('[RateDialogHandler] ⚠️ serviceLabelToCodeMap still not ready after waiting, proceeding anyway');
                }
            } else {
                // console.log('[RateDialogHandler] ✓ serviceLabelToCodeMap is ready');
            }
            
            // Check if we already have quote requests
            const hasQuoteRequests = globalQuoteRequests && Object.keys(globalQuoteRequests).length > 0;
            // console.log('[RateDialogHandler] Current quote requests available:', hasQuoteRequests);
            // console.log('[RateDialogHandler] Quote requests count:', hasQuoteRequests ? Object.keys(globalQuoteRequests).length : 0);
            
            if (hasQuoteRequests) {
                // console.log('[RateDialogHandler] ✓ Quote requests already available, no fetch needed');
                // console.log('[RateDialogHandler] Available order numbers:', Object.keys(globalQuoteRequests));
                return;
            }
            
            // Try to extract order number from the page
            let orderNumber = mostRecentOrderNumber;
            if (!orderNumber) {
                // Try to extract from Rate1 or Rate2 selectors
                const orderNumberEl1 = document.querySelector('.order-number-part-sgF7off');
                if (orderNumberEl1) {
                    orderNumber = orderNumberEl1.textContent.trim();
                    mostRecentOrderNumber = orderNumber;
                } else {
                    const container = document.querySelector('.order-info-order-number-vbTaRbB');
                    if (container) {
                        const orderNumberEl2 = container.querySelector('.h4-yAR2Zwb');
                        if (orderNumberEl2) {
                            const text = orderNumberEl2.textContent.trim();
                            const match = text.match(/\d+/);
                            orderNumber = match ? match[0] : null;
                            if (orderNumber) {
                                mostRecentOrderNumber = orderNumber;
                            }
                        }
                    }
                }
            }
            
            // console.log('[RateDialogHandler] Current order number:', orderNumber);
            
            // If we have an order number, check if we have quote request for it
            if (orderNumber && globalQuoteRequests && globalQuoteRequests[orderNumber]) {
                // console.log('[RateDialogHandler] ✓ Quote request found for current order:', orderNumber);
                return;
            }
            
            // No quote requests available - trigger fetch
            // console.log('[RateDialogHandler] ⚠️ No quote requests available, triggering ShipStation API fetch...');
            // console.log('[RateDialogHandler] ========== Calling ShipStation OrderGrid API ==========');
            // console.log('[RateDialogHandler] This will fetch order data to build quote requests...');
            
            try {
                // Call autoFetchOrderGrid if it's available in scope
                // Since autoFetchOrderGrid is defined outside the class, we need to access it
                // We'll use a promise-based approach
                await this.fetchOrderGridData();
                // console.log('[RateDialogHandler] ✓ ShipStation API fetch completed successfully');
                // console.log('[RateDialogHandler] Quote requests now available:', globalQuoteRequests && Object.keys(globalQuoteRequests).length > 0);
                if (globalQuoteRequests && Object.keys(globalQuoteRequests).length > 0) {
                    // console.log('[RateDialogHandler] Available order numbers:', Object.keys(globalQuoteRequests));
                }
            } catch (error) {
                // console.error('[RateDialogHandler] ✗ Error fetching quote requests from ShipStation API:', error);
                // console.error('[RateDialogHandler] Error details:', error.message, error.stack);
            }
            
            // console.log('[RateDialogHandler] ============================================');
        }

        // Helper method to fetch order grid data
        async fetchOrderGridData() {
            const maxWaitTime = 10000; // 10 seconds max wait
            const checkInterval = 200; // Check every 200ms
            const startTime = Date.now();
            
            // console.log('[RateDialogHandler] Triggering OrderGrid fetch...');
            
            // First, try to call autoFetchOrderGrid directly if available via window
            if (typeof window.autoFetchOrderGrid === 'function') {
                try {
                    // console.log('[RateDialogHandler] Calling window.autoFetchOrderGrid()...');
                    await window.autoFetchOrderGrid();
                    // Check if quote requests are now available
                    if (globalQuoteRequests && Object.keys(globalQuoteRequests).length > 0) {
                        // console.log('[RateDialogHandler] ✓ Quote requests fetched successfully via autoFetchOrderGrid');
                        if (this.quoteRequestsCache) {
                            this.quoteRequestsCache = globalQuoteRequests;
                        }
                        return;
                    }
                } catch (error) {
                    // console.error('[RateDialogHandler] Error calling autoFetchOrderGrid:', error);
                }
            }
            
            // Fallback: Try getOrderGridData if available
            if (typeof window.getOrderGridData === 'function') {
                try {
                    // console.log('[RateDialogHandler] Calling getOrderGridData() as fallback...');
                    const quoteRequests = await window.getOrderGridData();
                    if (quoteRequests && Object.keys(quoteRequests).length > 0) {
                        // console.log('[RateDialogHandler] ✓ Quote requests fetched successfully via getOrderGridData');
                        globalQuoteRequests = quoteRequests;
                        if (this.quoteRequestsCache) {
                            this.quoteRequestsCache = quoteRequests;
                        }
                        return;
                    }
                } catch (error) {
                    // console.error('[RateDialogHandler] Error calling getOrderGridData:', error);
                }
            }
            
            // Final fallback: Poll for quote requests to become available
            // This handles the case where autoFetchOrderGrid is running in the background
            // console.log('[RateDialogHandler] Waiting for quote requests to become available...');
            return new Promise((resolve) => {
                const checkIntervalId = setInterval(() => {
                    const hasQuoteRequests = globalQuoteRequests && Object.keys(globalQuoteRequests).length > 0;
                    const elapsed = Date.now() - startTime;
                    
                    if (hasQuoteRequests) {
                        clearInterval(checkIntervalId);
                        // console.log('[RateDialogHandler] ✓ Quote requests became available');
                        resolve();
                    } else if (elapsed >= maxWaitTime) {
                        clearInterval(checkIntervalId);
                        // console.warn('[RateDialogHandler] ⚠️ Timeout waiting for quote requests (proceeding anyway)');
                        resolve(); // Resolve anyway to not block rate processing
                    }
                }, checkInterval);
            });
        }

        // Check for Rate Browser rates and update them
        async checkRateBrowserRates() {
            if (!isShipStationDomain()) {
                return;
            }

            // console.log('[RateDialogHandler] ========== checkRateBrowserRates START ==========');
            
            // CRITICAL: Ensure quote requests are available before processing rates
            // This will fetch from ShipStation API if needed
            // console.log('[RateDialogHandler] Step 1: Ensuring quote requests are available...');
            await this.ensureQuoteRequestsForRateBrowser();
            
            // Verify we have quote requests before proceeding
            const hasQuoteRequests = globalQuoteRequests && Object.keys(globalQuoteRequests).length > 0;
            // console.log('[RateDialogHandler] Step 2: Quote requests available?', hasQuoteRequests);
            if (hasQuoteRequests) {
                // console.log('[RateDialogHandler] Available order numbers:', Object.keys(globalQuoteRequests));
            } else {
                // console.warn('[RateDialogHandler] ⚠️ No quote requests available yet, but proceeding anyway...');
                // console.warn('[RateDialogHandler] Rates may not update correctly without quote requests');
            }

            // Find rate value elements directly first (more reliable)
            const rateValueElements = document.querySelectorAll('.rate-value-xslVnIC');
            
            if (rateValueElements.length === 0) {
                // Clear status map if no rates found (dialog might be closed)
                this.rateBrowserStatusMap.clear();
                // Only log occasionally to avoid spam
                return;
            }

            // console.log('[RateDialogHandler] ========== checkRateBrowserRates called ==========');
            // console.log('[RateDialogHandler] ✓ Found', rateValueElements.length, 'rate value elements (.rate-value-xslVnIC)');
            
            // Clear old statuses for rates that no longer exist or are not FedEx
            const currentRateElements = new Set(rateValueElements);
            for (const [rateEl, status] of this.rateBrowserStatusMap.entries()) {
                if (!currentRateElements.has(rateEl)) {
                    // Rate element no longer exists, remove from map
                    this.rateBrowserStatusMap.delete(rateEl);
                } else {
                    // Check if this rate is still FedEx
                    const rateInfoContainer = rateEl.closest('.rate-information-vbp6sBx') || rateEl.parentElement;
                    const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                    if (serviceNameEl) {
                        const serviceLabel = serviceNameEl.textContent.trim().toLowerCase();
                        const isFedExService = serviceLabel.startsWith('fedex');
                        const isFedExByShipStation = serviceLabel.includes('by shipstation');
                        if (!isFedExService || isFedExByShipStation) {
                            // This rate is no longer FedEx, remove from map
                            this.rateBrowserStatusMap.delete(rateEl);
                        }
                    }
                }
            }
            
            // Initialize dialog mark (will be updated as rates are processed)
            this.showRateBrowserDialogMark();

            // Find rate list container
            let rateListContainer = document.querySelector('.rate-list-content-tVqLqSX');
            if (!rateListContainer && rateValueElements.length > 0) {
                // Try to find container from rate value element
                rateListContainer = rateValueElements[0].closest('[class*="rate-list"], [class*="content"]');
            }

            if (rateListContainer) {
                // console.log('[RateDialogHandler] ✓ Rate Browser container found');
            }

            // Find all rate information containers
            const rateInfoContainers = rateListContainer ? 
                rateListContainer.querySelectorAll('.rate-information-vbp6sBx') : 
                [];

            // console.log('[RateDialogHandler] Found', rateInfoContainers.length, 'rate information containers (.rate-information-vbp6sBx)');

            // Process each rate value element
            rateValueElements.forEach((rateValueEl, index) => {
                // CRITICAL: Check serviceLabel FIRST - if non-FedEx, skip completely
                const rateInfoContainer = rateValueEl.closest('.rate-information-vbp6sBx') || rateValueEl.parentElement;
                const serviceNameEl = rateInfoContainer?.querySelector('.rate-name-E9GTfro');
                
                if (serviceNameEl) {
                    const currentServiceLabel = serviceNameEl.textContent.trim();
                    const serviceLabelLower = currentServiceLabel.toLowerCase();
                    const isFedExService = serviceLabelLower.startsWith('fedex');
                    const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
                    
                    // BLOCK: If NOT FedEx or IS "FedEx by ShipStation", skip completely - NO rate updates
                    if (!isFedExService || isFedExByShipStation) {
                        // console.log('[RateDialogHandler] 🚫 BLOCKED: Non-FedEx service detected in checkRateBrowserRates:', currentServiceLabel);
                        // console.log('[RateDialogHandler] Rate update functionality BLOCKED for this service');
                        
                        // Clear any cached data
                        const previousServiceLabel = this.rateServiceLabels.get(rateValueEl);
                        if (previousServiceLabel && previousServiceLabel.toLowerCase().startsWith('fedex') && 
                            !previousServiceLabel.toLowerCase().includes('by shipstation')) {
                            // console.log('[RateDialogHandler] ⚠️ ServiceLabel changed from FedEx to non-FedEx!');
                            if (this.originalRateValues && this.originalRateValues.has(rateValueEl)) {
                                // console.log('[RateDialogHandler] Clearing cached FedEx value due to service change');
                                this.originalRateValues.delete(rateValueEl);
                            }
                        }
                        
                        // Update tracked serviceLabel
                        this.rateServiceLabels.set(rateValueEl, currentServiceLabel);
                        // Remove any marks
                        this.removeRateMark(rateValueEl);
                        // SKIP - don't process, don't call applyRateBrowserMarkup
                        return;
                    }
                    
                    // console.log('[RateDialogHandler] ✓ Confirmed FedEx service, allowing rate update:', currentServiceLabel);
                } else {
                    // If we can't find serviceLabel, skip to be safe
                    // console.warn('[RateDialogHandler] ⚠️ Could not find serviceLabel, skipping to avoid incorrect updates');
                    return;
                }
                
                // Check if already processed
                if (this.processedRates.has(rateValueEl)) {
                    return;
                }

                // Find the parent rate-information container
                let rateInfoContainerForProcessing = rateValueEl.closest('.rate-information-vbp6sBx');
                if (!rateInfoContainerForProcessing && rateInfoContainers.length > index) {
                    rateInfoContainerForProcessing = rateInfoContainers[index];
                }
                if (!rateInfoContainerForProcessing) {
                    // Use parent element as fallback
                    rateInfoContainerForProcessing = rateValueEl.parentElement;
                }

                // console.log(`[RateDialogHandler] ✓ Processing Rate Browser rate ${index + 1}`);
                // console.log(`[RateDialogHandler] Rate value element:`, rateValueEl);
                // console.log(`[RateDialogHandler] Rate value text:`, rateValueEl.textContent.trim());
                // console.log(`[RateDialogHandler] Rate info container:`, rateInfoContainerForProcessing);
                // console.log(`[RateDialogHandler] Rate info container classes:`, rateInfoContainerForProcessing?.className);
                
                // Also try to find service name element directly to verify it exists
                const testServiceName = rateValueEl.closest('button, [class*="rate-list-item"]')?.querySelector('.rate-name-E9GTfro');
                // console.log(`[RateDialogHandler] Test: Can we find service name from rate element?`, !!testServiceName);
                if (testServiceName) {
                    // console.log(`[RateDialogHandler] Test service name text:`, testServiceName.textContent.trim());
                }
                
                this.applyRateBrowserMarkup(rateValueEl, rateInfoContainerForProcessing);
            });
        }

        // Apply rate update logic for Rate Browser rates
        async applyRateBrowserMarkup(rateElement, rateInfoContainer) {
            if (!isShipStationDomain()) {
                return;
            }

            // console.log('[RateDialogHandler] ========== applyRateBrowserMarkup called ==========');
            // console.log('[RateDialogHandler] Rate element:', rateElement);
            // console.log('[RateDialogHandler] Rate element text:', rateElement.textContent.trim());

            // FIRST: Check if this is a FedEx service BEFORE processing
            // Extract serviceLabel early to determine if we should process this rate
            let serviceLabel = null;
            let serviceNameEl = null;
            
            // Try to find service name element
            if (rateInfoContainer) {
                serviceNameEl = rateInfoContainer.querySelector('.rate-name-E9GTfro');
            }
            
            // Try multiple methods to find service name
            if (!serviceNameEl) {
                // Method 1: Search in parent elements
                let parent = rateElement.parentElement;
                let depth = 0;
                while (parent && depth < 5) {
                    serviceNameEl = parent.querySelector('.rate-name-E9GTfro');
                    if (serviceNameEl) break;
                    parent = parent.parentElement;
                    depth++;
                }
            }
            
            // Method 2: Find by index position
            if (!serviceNameEl) {
                const allRateValues = document.querySelectorAll('.rate-value-xslVnIC');
                const allServiceNames = document.querySelectorAll('.rate-name-E9GTfro');
                let rateIndex = -1;
                for (let i = 0; i < allRateValues.length; i++) {
                    if (allRateValues[i] === rateElement) {
                        rateIndex = i;
                        break;
                    }
                }
                if (rateIndex >= 0 && rateIndex < allServiceNames.length) {
                    serviceNameEl = allServiceNames[rateIndex];
                }
            }
            
            if (serviceNameEl) {
                serviceLabel = serviceNameEl.textContent.trim();
                // console.log('[RateDialogHandler] Extracted serviceLabel (early check):', serviceLabel);
                
                // Check if it's FedEx (excluding "FedEx by ShipStation")
                const serviceLabelLower = serviceLabel.toLowerCase();
                const isFedExService = serviceLabelLower.startsWith('fedex');
                const isFedExByShipStation = serviceLabelLower.includes('by shipstation');
                
                // console.log('[RateDialogHandler] isFedExService:', isFedExService);
                // console.log('[RateDialogHandler] isFedExByShipStation:', isFedExByShipStation);
                
                // If NOT FedEx or IS "FedEx by ShipStation", skip processing completely
                if (!isFedExService || isFedExByShipStation) {
                    // console.log('[RateDialogHandler] ⏭️ Skipping non-FedEx or FedEx by ShipStation service:', serviceLabel);
                    // console.log('[RateDialogHandler] Rate update feature stopped for this service - leaving value untouched');
                    
                    // Check if serviceLabel has changed (was FedEx, now non-FedEx)
                    const previousServiceLabel = this.rateServiceLabels.get(rateElement);
                    if (previousServiceLabel && previousServiceLabel.toLowerCase().startsWith('fedex') && 
                        !previousServiceLabel.toLowerCase().includes('by shipstation')) {
                        // console.log('[RateDialogHandler] ⚠️ ServiceLabel changed from FedEx to non-FedEx!');
                        // console.log('[RateDialogHandler] Previous:', previousServiceLabel, 'Current:', serviceLabel);
                        // Clear all cached data for this element
                        if (this.originalRateValues && this.originalRateValues.has(rateElement)) {
                            // console.log('[RateDialogHandler] Clearing cached FedEx value due to service change');
                            this.originalRateValues.delete(rateElement);
                        }
                        // Don't restore - let ShipStation's DOM value be the source of truth
                    }
                    
                    // Update tracked serviceLabel
                    this.rateServiceLabels.set(rateElement, serviceLabel);
                    
                    // Remove any existing marks (in case they were added previously)
                    this.removeRateMark(rateElement);
                    // DO NOTHING ELSE - don't cache, don't restore, don't process
                    // Just leave the rate value as-is from the DOM (ShipStation will update it correctly)
                    return; // Exit early - don't hide, don't process, don't show marks, don't cache
                }
                
                // console.log('[RateDialogHandler] ✓ Service is FedEx (not by ShipStation), proceeding with rate update');
            } else {
                // If we can't find serviceLabel, we can't determine if it's FedEx or not
                // To be safe, skip processing entirely - don't process unknown services
                // console.warn('[RateDialogHandler] ⚠️ Could not find service name element, skipping processing to avoid incorrect updates');
                // console.warn('[RateDialogHandler] This prevents non-FedEx services from being incorrectly processed');
                // Remove any existing marks just in case
                this.removeRateMark(rateElement);
                // Don't process - return early
                return;
            }

            // Only proceed if we confirmed it's a FedEx service
            const originalText = rateElement.textContent.trim();
            const dollarAmount = this.extractDollarAmount(originalText);

            if (dollarAmount === null) {
                // console.warn('[RateDialogHandler] Could not extract dollar amount from Rate Browser rate, skipping');
                return;
            }

            this.originalRateValues.set(rateElement, dollarAmount);
            // Track the serviceLabel for this rate element
            if (serviceLabel) {
                this.rateServiceLabels.set(rateElement, serviceLabel);
            }
            
            // Hide original rate value immediately
            this.hideRateValue(rateElement);
            
            // Mark as processed to avoid duplicate processing
            this.processedRates.add(rateElement);
            
            // Update rate with quote API (using unified logic)
            this.updateRateWithQuoteAPI(rateElement).then(() => {
                this.setupRateObserver(rateElement);
            }).catch(error => {
                // console.error('[RateDialogHandler] Error in updateRateWithQuoteAPI:', error);
                // Only show error mark if this is a FedEx service (not excluded)
                // If serviceCode is null, it means it was excluded, so don't show mark
                // Check by trying to extract serviceCode again
                const extractedServiceCode = this.extractServiceCodeForRateBrowser(rateElement);
                if (extractedServiceCode) {
                    // This is a FedEx service, track error and update dialog title mark
                    this.rateBrowserStatusMap.set(rateElement, false);
                    this.showRateBrowserDialogMark();
                } else {
                    // This is an excluded service, remove any marks
                    this.removeRateMark(rateElement);
                }
                this.restoreRateValue(rateElement);
            });
        }


        destroy() {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
            
            if (this.buttonObserver) {
                this.buttonObserver.disconnect();
                this.buttonObserver = null;
            }

            if (this.rateBrowserCheckInterval) {
                clearInterval(this.rateBrowserCheckInterval);
                this.rateBrowserCheckInterval = null;
            }
            
            for (const [element, observer] of this.rateObservers.entries()) {
                observer.disconnect();
            }
            this.rateObservers.clear();
            this.originalRateValues.clear();
        }
    }

    try {
        if (!window.location.href.includes('shipstation.com')) {
            return;
        }

        if (typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined') {
            // console.error('Chrome runtime not available');
            return;
        }

        let rateDialogHandler = null;

        function initializeRateDialogHandler() {
            // console.log('[RateDialogHandler] initializeRateDialogHandler - readyState:', document.readyState);
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    // console.log('[RateDialogHandler] DOMContentLoaded fired, creating handler');
                    rateDialogHandler = new RateDialogHandler();
                });
            } else {
                // console.log('[RateDialogHandler] Document already ready, creating handler immediately');
                rateDialogHandler = new RateDialogHandler();
            }
        }

        initializeRateDialogHandler();

        class Toast {
            constructor() {
                this.container = null;
                this.init();
            }

            init() {
                try {
                    if (!document.getElementById('fedex-toast-container')) {
                        this.container = document.createElement('div');
                        this.container.id = 'fedex-toast-container';
                        this.container.className = 'fedex-toast-container';
                        document.body.appendChild(this.container);
                    } else {
                        this.container = document.getElementById('fedex-toast-container');
                    }
                } catch (error) {
                    // console.error('Error initializing Toast:', error);
                }
            }

            show(type, title, message, duration = 5000) {
                if (!this.container) {
                    this.init();
                }
                if (!this.container) return;

                const icons = {
                    success: '✓',
                    error: '✗',
                    info: 'ℹ'
                };

                const toast = document.createElement('div');
                toast.className = `fedex-toast fedex-toast-${type}`;
                
                toast.innerHTML = `
                    <span class="fedex-toast-icon">${icons[type] || icons.info}</span>
                    <div class="fedex-toast-content">
                        <div class="fedex-toast-title">${title}</div>
                        <div class="fedex-toast-message">${message}</div>
                    </div>
                `;

                this.container.appendChild(toast);

                setTimeout(() => {
                    toast.classList.add('fedex-toast-show');
                }, 10);

                setTimeout(() => {
                    this.remove(toast);
                }, duration);

                return toast;
            }

            remove(toast) {
                if (toast && toast.parentElement) {
                    toast.classList.remove('fedex-toast-show');
                    toast.classList.add('fedex-toast-hide');
                    setTimeout(() => {
                        if (toast.parentElement) {
                            toast.remove();
                        }
                    }, 400);
                }
            }
        }

        let toast = null;
        try {
            toast = new Toast();
        } catch (error) {
            // console.error('Failed to create Toast instance:', error);
            toast = null;
        }

        let previousLoginStatus = null;
        let loginCheckInterval = null;

        async function checkLoginStatus(showToastOnChange = true) {
            const checks = {
                hasAuthCookie: false,
                hasBearerToken: false,
                hasUserElements: false,
                hasApiAccess: false
            };

            try {
                const cookies = document.cookie.split(';').map(c => c.trim());
                const authCookieNames = [
                    '.AspNet.ApplicationCookie',
                    'ASP.NET_SessionId',
                    'ss_session',
                    'shipstation_session',
                    '__RequestVerificationToken'
                ];
                
                checks.hasAuthCookie = authCookieNames.some(name => 
                    cookies.some(cookie => cookie.startsWith(name + '='))
                );

                if (cachedBearerToken) {
                    checks.hasBearerToken = true;
                } else {
                    const token = getBearerToken();
                    if (token) {
                        checks.hasBearerToken = true;
                    }
                }

                const userIndicators = [
                    '[data-testid*="user"]',
                    '[class*="user-menu"]',
                    '[class*="profile"]',
                    '[class*="account"]',
                    'nav[class*="user"]',
                    '[aria-label*="user" i]',
                    '[aria-label*="account" i]'
                ];

                for (const selector of userIndicators) {
                    if (document.querySelector(selector)) {
                        checks.hasUserElements = true;
                        break;
                    }
                }

                if (checks.hasAuthCookie || checks.hasBearerToken) {
                    checks.hasApiAccess = true;
                }

                const isLoggedIn = checks.hasAuthCookie || checks.hasBearerToken || checks.hasUserElements;

                if (showToastOnChange && previousLoginStatus !== null && previousLoginStatus !== isLoggedIn) {
                    if (toast) {
                        if (isLoggedIn) {
                            toast.show(
                                'success',
                                'Login Status Changed',
                                'You are now logged in to ShipStation.',
                                4000
                            );
                        } else {
                            toast.show(
                                'error',
                                'Login Status Changed',
                                'You have been logged out. Please log in again.',
                                5000
                            );
                        }
                    }
                } else if (previousLoginStatus === null) {
                    if (toast) {
                        if (isLoggedIn) {
                            toast.show(
                                'success',
                                'Logged In',
                                'You are successfully authenticated to ShipStation.',
                                4000
                            );
                        } else {
                            toast.show(
                                'error',
                                'Not Logged In',
                                'Please log in to ShipStation to use this extension.',
                                5000
                            );
                        }
                    }
                }

                previousLoginStatus = isLoggedIn;

                // console.log('[Login Check] Status:', isLoggedIn ? 'Logged In' : 'Not Logged In');
                // console.log('[Login Check] Details:', checks);

                return { isLoggedIn, checks };
            } catch (error) {
                // console.error('[Login Check] Error:', error);
                if (toast && showToastOnChange) {
                    toast.show(
                        'error',
                        'Login Check Failed',
                        'Unable to determine login status.',
                        4000
                    );
                }
                return { isLoggedIn: false, checks, error: error.message };
            }
        }

        function initializeLoginCheck() {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    setTimeout(() => {
                        checkLoginStatus(true);
                        startLoginStatusMonitoring();
                    }, 1000);
                });
            } else {
                setTimeout(() => {
                    checkLoginStatus(true);
                    startLoginStatusMonitoring();
                }, 1000);
            }
        }

        function startLoginStatusMonitoring() {
            if (loginCheckInterval) {
                clearInterval(loginCheckInterval);
            }

            loginCheckInterval = setInterval(() => {
                checkLoginStatus(true);
            }, 5000);
        }

        function stopLoginStatusMonitoring() {
            if (loginCheckInterval) {
                clearInterval(loginCheckInterval);
                loginCheckInterval = null;
            }
        }

        initializeLoginCheck();

        let cachedBearerToken = null;

        function interceptFetchForToken() {
            const originalFetch = window.fetch;
            window.fetch = function(...args) {
                const [url, options = {}] = args;
                
                if (typeof url === 'string' && url.includes('shipstation.com/api')) {
                    const authHeader = options.headers?.Authorization || options.headers?.['authorization'];
                    if (authHeader && authHeader.startsWith('Bearer ')) {
                        cachedBearerToken = authHeader.replace('Bearer ', '');
                        // console.log('[ShipStation API] Captured Bearer token from fetch');
                    }
                }
                
                const result = originalFetch.apply(this, args);
                
                result.then(response => {
                    if (response.url && response.url.includes('shipstation.com/api')) {
                        const authHeader = response.headers.get('Authorization');
                        if (!authHeader) {
                            const requestHeaders = options.headers || {};
                            const reqAuth = requestHeaders.Authorization || requestHeaders.authorization;
                            if (reqAuth && reqAuth.startsWith('Bearer ')) {
                                cachedBearerToken = reqAuth.replace('Bearer ', '');
                                // console.log('[ShipStation API] Captured Bearer token from fetch response');
                            }
                        }
                    }
                }).catch(() => {});
                
                return result;
            };

            if (window.XMLHttpRequest) {
                const originalOpen = XMLHttpRequest.prototype.open;
                const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
                
                XMLHttpRequest.prototype.open = function(method, url, ...args) {
                    this._url = url;
                    return originalOpen.apply(this, [method, url, ...args]);
                };
                
                XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
                    if (header.toLowerCase() === 'authorization' && value && value.startsWith('Bearer ')) {
                        if (this._url && this._url.includes('shipstation.com/api')) {
                            cachedBearerToken = value.replace('Bearer ', '');
                            // console.log('[ShipStation API] Captured Bearer token from XMLHttpRequest');
                        }
                    }
                    return originalSetRequestHeader.apply(this, [header, value]);
                };
            }
        }

        function extractTokenFromNetworkRequests() {
            if (cachedBearerToken) {
                return cachedBearerToken;
            }

            try {
                if (window.performance && window.performance.getEntriesByType) {
                    const entries = performance.getEntriesByType('resource');
                    for (const entry of entries) {
                        if (entry.name && entry.name.includes('shipstation.com/api')) {
                            if (entry.responseHeaders) {
                                for (const header of entry.responseHeaders) {
                                    if (header.name && header.name.toLowerCase() === 'authorization' && header.value) {
                                        const token = header.value.replace('Bearer ', '');
                                        if (token) {
                                            cachedBearerToken = token;
                                            // console.log('[ShipStation API] Extracted token from network entry');
                                            return token;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
            }

            try {
                if (window.chrome && window.chrome.webRequest) {
                    // console.log('[ShipStation API] webRequest API available');
                }
            } catch (e) {
            }

            return null;
        }

        function getBearerToken() {
            if (cachedBearerToken) {
                return cachedBearerToken;
            }

            extractTokenFromNetworkRequests();

            if (cachedBearerToken) {
                return cachedBearerToken;
            }

            const tokenFromStorage = localStorage.getItem('auth_token') || 
                                   sessionStorage.getItem('auth_token') ||
                                   localStorage.getItem('bearer_token') ||
                                   sessionStorage.getItem('bearer_token');
            
            if (tokenFromStorage) {
                cachedBearerToken = tokenFromStorage;
                return tokenFromStorage;
            }

            return null;
        }

        interceptFetchForToken();

        async function callShipStationOrderGrid(payload) {
            try {
                // console.log('[ShipStation API] ========== callShipStationOrderGrid START ==========');
                // console.log('[ShipStation API] Payload received:', JSON.stringify(payload, null, 2));
                
                // Try to get bearer token, wait a bit if not found
                let bearerToken = getBearerToken();
                if (!bearerToken) {
                    // Wait up to 2 seconds for token to be captured
                    const maxWaitTime = 2000;
                    const checkInterval = 200;
                    const startTime = Date.now();
                    while (!bearerToken && (Date.now() - startTime) < maxWaitTime) {
                        extractTokenFromNetworkRequests();
                        bearerToken = getBearerToken();
                        if (bearerToken) {
                            break;
                        }
                        await new Promise(resolve => setTimeout(resolve, checkInterval));
                    }
                }
                // console.log('[ShipStation API] Bearer token status:', bearerToken ? `Found (length: ${bearerToken.length})` : 'NOT FOUND');
                
                const headers = {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Accept': 'application/json, text/plain, */*'
                };

                if (bearerToken) {
                    headers['Authorization'] = `Bearer ${bearerToken}`;
                    // console.log('[ShipStation API] Authorization header added');
                }
                // Removed warning - cookies will be used automatically if no token

                const apiUrl = 'https://ship14.shipstation.com/api/ordergrid/shipmentmode/simple';
                // console.log('[ShipStation API] Making fetch request to:', apiUrl);
                // console.log('[ShipStation API] Request headers:', headers);
                // console.log('[ShipStation API] Request body:', JSON.stringify(payload, null, 2));

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: headers,
                    credentials: 'include',
                    body: JSON.stringify(payload)
                });

                // console.log('[ShipStation API] Response received - Status:', response.status, response.statusText);
                // console.log('[ShipStation API] Response ok:', response.ok);
                // console.log('[ShipStation API] Response headers:', Object.fromEntries(response.headers.entries()));

                if (!response.ok) {
                    if (response.status === 401) {
                        // console.error('[ShipStation API] 401 Unauthorized - Token may be expired. Please refresh the page to get a new token.');
                    }
                    const errorText = await response.text();
                    // console.error('[ShipStation API] Error response body:', errorText);
                    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
                }

                const data = await response.json();
                // console.log('[ShipStation API] Response data received - Type:', typeof data);
                // console.log('[ShipStation API] Response data keys:', data ? Object.keys(data) : 'null/undefined');
                // console.log('[ShipStation API] Response data sample:', data ? JSON.stringify(data).substring(0, 500) : 'null/undefined');
                // console.log('[ShipStation API] ========== callShipStationOrderGrid SUCCESS ==========');
                return { success: true, data: data };
            } catch (error) {
                // console.error('[ShipStation API] ========== callShipStationOrderGrid ERROR ==========');
                // console.error('[ShipStation API] Error type:', error.constructor.name);
                // console.error('[ShipStation API] Error message:', error.message);
                // console.error('[ShipStation API] Error stack:', error.stack);
                return { success: false, error: error.message };
            }
        }

        window.setShipStationToken = function(token) {
            cachedBearerToken = token;
            // console.log('[ShipStation API] Token set manually');
        };

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

        function parseOrderGridToQuoteRequests(orderGridData) {
            try {
                if (!orderGridData) {
                    // console.warn('[Quote Parser] No order grid data provided');
                    return [];
                }

                // console.log('[Quote Parser] Full response structure keys:', Object.keys(orderGridData));
                // console.log('[Quote Parser] Full response structure (first 2000 chars):', JSON.stringify(orderGridData, null, 2).substring(0, 2000));

                const salesOrders = orderGridData.salesOrders || [];
                const rootFulfillmentPlans = orderGridData.fulfillmentPlans || [];
                
                if (rootFulfillmentPlans.length > 0) {
                    // console.log(`[Quote Parser] Found ${rootFulfillmentPlans.length} fulfillmentPlans at root level`);
                }
                
                if (!Array.isArray(salesOrders) || salesOrders.length === 0) {
                    // console.warn('[Quote Parser] No salesOrders found in response');
                    return [];
                }

                // console.log(`[Quote Parser] Found ${salesOrders.length} orders to process`);

                const quoteRequests = {};

                salesOrders.forEach((order, orderIndex) => {
                    try {
                        if (!order || typeof order !== 'object') {
                            // console.warn(`[Quote Parser] Order ${orderIndex}: Invalid order object, skipping`);
                            return;
                        }

                        // console.log(`[Quote Parser] Processing order ${orderIndex}:`, JSON.stringify(order, null, 2));
                        // console.log(`[Quote Parser] Order keys:`, Object.keys(order));

                        const orderNumber = order.orderNumber;
                        if (!orderNumber) {
                            // console.warn(`[Quote Parser] Order ${orderIndex}: No orderNumber found. Available keys:`, Object.keys(order));
                            return;
                        }

                        // console.log(`[Quote Parser] Order ${orderIndex}: orderNumber = "${orderNumber}" (type: ${typeof orderNumber})`);

                        const shipTos = order.shipTos || [];
                        let shipTo = {};
                        if (shipTos.length > 0) {
                            shipTo = shipTos[0];
                            // console.log(`[Quote Parser] Order ${orderNumber}: shipTo =`, JSON.stringify(shipTo, null, 2));
                        } else {
                            // console.warn(`[Quote Parser] Order ${orderNumber}: No shipTos found, using defaults`);
                        }

                        let fulfillmentPlan = null;
                        let labelConfig = {};
                        let packages = [];

                        const orderFulfillmentPlans = order.fulfillmentPlans || [];
                        if (orderFulfillmentPlans.length > 0) {
                            fulfillmentPlan = orderFulfillmentPlans[0];
                            // console.log(`[Quote Parser] Order ${orderNumber}: Found fulfillmentPlan in order object`);
                        } else {
                            const fulfillmentPlanIds = order.fulfillmentPlanIds || [];
                            if (fulfillmentPlanIds.length > 0 && rootFulfillmentPlans.length > 0) {
                                const planId = String(fulfillmentPlanIds[0]);
                                // console.log(`[Quote Parser] Order ${orderNumber}: Looking up fulfillmentPlan by ID: ${planId}`);
                                
                                fulfillmentPlan = rootFulfillmentPlans.find(fp => {
                                    const fpId = String(fp.fulfillmentPlanId || fp.id || '');
                                    return fpId === planId;
                                });
                                
                                if (fulfillmentPlan) {
                                    // console.log(`[Quote Parser] Order ${orderNumber}: Found fulfillmentPlan in root array`);
                                } else {
                                    // console.warn(`[Quote Parser] Order ${orderNumber}: Could not find fulfillmentPlan with ID ${planId} in root array`);
                                }
                            } else {
                                // console.warn(`[Quote Parser] Order ${orderNumber}: No fulfillmentPlanIds found`);
                            }
                        }

                        if (fulfillmentPlan) {
                            // console.log(`[Quote Parser] Order ${orderNumber}: fulfillmentPlan =`, JSON.stringify(fulfillmentPlan, null, 2));
                            labelConfig = fulfillmentPlan.labelConfiguration || {};
                            packages = labelConfig.packages || [];
                            // console.log(`[Quote Parser] Order ${orderNumber}: Found ${packages.length} package(s) in fulfillmentPlan`);
                        } else {
                            // console.warn(`[Quote Parser] Order ${orderNumber}: No fulfillmentPlan found, using defaults for package data`);
                        }

                        let weightUnit = 'lb';
                        let dimUnit = 'in';
                        let currency = 'USD';
                        let customsCurrency = 'USD';
                        let pieces = [];

                        if (packages.length > 0) {
                            const firstPackage = packages[0];
                            const weight = firstPackage.weight || {};
                            const dimensions = firstPackage.dimensions || {};
                            const insuredValue = firstPackage.insuredValue || {};
                            const customs = labelConfig.customs || {};
                            const postagePaid = customs.postagePaid || {};

                            // console.log(`[Quote Parser] Order ${orderNumber}: weight =`, weight);
                            // console.log(`[Quote Parser] Order ${orderNumber}: dimensions =`, dimensions);
                            // console.log(`[Quote Parser] Order ${orderNumber}: insuredValue =`, insuredValue);
                            // console.log(`[Quote Parser] Order ${orderNumber}: customs =`, customs);

                            weightUnit = convertToISOUnit(String(weight.unit || 'lb'));
                            dimUnit = convertToISOUnit(String(dimensions.unit || 'in'));
                            currency = String(insuredValue.code || 'USD');
                            customsCurrency = String(postagePaid.code || currency || 'USD');

                            pieces = packages.map((pkg, pkgIndex) => {
                                const pkgWeight = pkg.weight || {};
                                const pkgDimensions = pkg.dimensions || {};
                                const pkgInsuredValue = pkg.insuredValue || {};

                                const weightValue = pkgWeight.value;
                                const lengthValue = pkgDimensions.length;
                                const widthValue = pkgDimensions.width;
                                const heightValue = pkgDimensions.height;
                                const insuranceValue = pkgInsuredValue.value;

                                return {
                                    weight: weightValue != null ? String(weightValue) : '0',
                                    length: lengthValue != null ? String(lengthValue) : '0',
                                    width: widthValue != null ? String(widthValue) : '0',
                                    height: heightValue != null ? String(heightValue) : '0',
                                    insuranceAmount: insuranceValue != null ? String(insuranceValue) : '0.00',
                                    declaredValue: null
                                };
                            });
                        } else {
                            // console.warn(`[Quote Parser] Order ${orderNumber}: No packages found, creating default piece`);
                            pieces = [{
                                weight: '0',
                                length: '0',
                                width: '0',
                                height: '0',
                                insuranceAmount: '0.00',
                                declaredValue: null
                            }];
                        }

                        const quoteRequest = {
                            carrierCode: 'fedex',
                            serviceCode: null,
                            packageTypeCode: 'fedex_custom_package',
                            sender: {
                                country: 'US',
                                zip: null
                            },
                            receiver: {
                                city: shipTo.city ? String(shipTo.city) : null,
                                country: shipTo.countryCode ? String(shipTo.countryCode) : 'US',
                                zip: shipTo.postalCode ? String(shipTo.postalCode) : null,
                                email: 'nashid.toptal@gmail.com'
                            },
                            residential: true,
                            signatureOptionCode: 'DIRECT',
                            contentDescription: '',
                            weightUnit: weightUnit || 'lb',
                            dimUnit: dimUnit || 'in',
                            currency: currency,
                            customsCurrency: customsCurrency,
                            pieces: pieces,
                            billing: {
                                party: 'sender'
                            },
                            providerAccountId: null
                        };

                        quoteRequests[String(orderNumber)] = quoteRequest;
                        // console.log(`[Quote Parser] Successfully parsed order ${orderNumber} with ${pieces.length} piece(s)`);
                    } catch (orderError) {
                        // console.error(`[Quote Parser] Error parsing order ${orderIndex}:`, orderError);
                        // console.error(`[Quote Parser] Order data:`, order);
                    }
                });

                return quoteRequests;
            } catch (error) {
                // console.error('[Quote Parser] Error parsing order grid data:', error);
                // console.error('[Quote Parser] Response data:', orderGridData);
                return {};
            }
        }

        async function fetchOrderGrid(payload) {
            try {
                // console.log('[ShipStation API] Calling OrderGrid API with payload:', payload);
                
                const result = await callShipStationOrderGrid(payload);
                
                if (result && result.success) {
                    const quoteRequests = parseOrderGridToQuoteRequests(result.data);
                    
                    // console.log('[Quote Parser] Parsed quote requests:');
                    const orderNumbers = Object.keys(quoteRequests);
                    if (orderNumbers.length > 0) {
                        // console.log(`[Quote Parser] Generated ${orderNumbers.length} quote request(s):`);
                        // console.log(JSON.stringify(quoteRequests, null, 2));
                        orderNumbers.forEach((orderNum, index) => {
                            // console.log(`\n[Quote Parser] Request ${index + 1} - OrderNumber: ${orderNum}`);
                        });
                    } else {
                        // console.warn('[Quote Parser] No quote requests generated');
                    }
                    
                    return quoteRequests;
                } else {
                    const errorMsg = result?.error || 'Unknown error';
                    // console.error('[ShipStation API] Error:', errorMsg);
                    if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
                        // console.warn('[ShipStation API] Token may be expired. Try:');
                        // console.warn('1. Refresh the page to get a new token');
                        // console.warn('2. Or manually set token: setShipStationToken("your-token-here")');
                    }
                    return null;
                }
            } catch (error) {
                // console.error('[ShipStation API] Fatal error in fetchOrderGrid:', error);
                return null;
            }
        }

        async function getOrderGridData(filterStatus = "AwaitingShipment", pageNumber = 1, pageSize = 250, includeQueryCount = false) {
            try {
                // console.log('[ShipStation API] ========== getOrderGridData START ==========');
                // console.log('[ShipStation API] Parameters:', { filterStatus, pageNumber, pageSize, includeQueryCount });
                
                const payload = {
                    page: {
                        pageNumber: pageNumber,
                        pageSize: pageSize
                    },
                    filter: {
                        orderGridStatus: filterStatus
                    },
                    includeQueryCount: includeQueryCount,
                    orderBys: [
                        {
                            orderBy: "OrderDateTime",
                            orderByDirection: "Descending"
                        }
                    ]
                };

                // console.log('[ShipStation API] Payload constructed:', JSON.stringify(payload, null, 2));
                // console.log('[ShipStation API] Calling fetchOrderGrid...');
                
                const result = await fetchOrderGrid(payload);
                
                // console.log('[ShipStation API] fetchOrderGrid returned:', result ? 'NOT NULL' : 'NULL');
                // console.log('[ShipStation API] Result type:', typeof result);
                if (result) {
                    // console.log('[ShipStation API] Result keys:', Object.keys(result));
                    if (typeof result === 'object' && result !== null) {
                        // console.log('[ShipStation API] Result is object, checking for quote requests...');
                        const orderNumbers = Object.keys(result);
                        // console.log('[ShipStation API] Number of order numbers in result:', orderNumbers.length);
                        if (orderNumbers.length > 0) {
                            // console.log('[ShipStation API] Order numbers found:', orderNumbers);
                        }
                    }
                } else {
                    // console.warn('[ShipStation API] fetchOrderGrid returned NULL - no data');
                }
                
                // console.log('[ShipStation API] ========== getOrderGridData END ==========');
                return result;
            } catch (error) {
                // console.error('[ShipStation API] ========== getOrderGridData ERROR ==========');
                // console.error('[ShipStation API] Error in getOrderGridData:', error);
                // console.error('[ShipStation API] Error message:', error.message);
                // console.error('[ShipStation API] Error stack:', error.stack);
                return null;
            }
        }

        window.getOrderGridData = getOrderGridData;

        let pollingIntervalId = null;

        async function autoFetchOrderGrid() {
            // Only run on ShipStation domains
            if (!isShipStationDomain()) {
                // console.log('[ShipStation API] autoFetchOrderGrid skipped - not ShipStation domain');
                return;
            }
            
            try {
                // console.log('[ShipStation API] ========== autoFetchOrderGrid START ==========');
                // console.log('[ShipStation API] Fetching OrderGrid data...');
                
                extractTokenFromNetworkRequests();
                // console.log('[ShipStation API] Initial token extraction - cachedBearerToken:', cachedBearerToken ? `Found (length: ${cachedBearerToken.length})` : 'NOT FOUND');
                
                const maxWaitTime = 3000;
                const checkInterval = 200;
                const startTime = Date.now();
                
                while (!cachedBearerToken && (Date.now() - startTime) < maxWaitTime) {
                    extractTokenFromNetworkRequests();
                    if (cachedBearerToken) {
                        // console.log('[ShipStation API] Token found during wait loop');
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, checkInterval));
                }
                
                if (!cachedBearerToken) {
                    // console.log('[ShipStation API] No token captured after 3 seconds. Proceeding with API call using cookies only...');
                } else {
                    // console.log('[ShipStation API] Token found, proceeding with API call');
                }
                
                // console.log('[ShipStation API] Calling getOrderGridData()...');
                const quoteRequests = await getOrderGridData();
                
                // console.log('[ShipStation API] getOrderGridData returned:', quoteRequests ? 'NOT NULL' : 'NULL');
                if (quoteRequests) {
                    // console.log('[ShipStation API] quoteRequests type:', typeof quoteRequests);
                    // console.log('[ShipStation API] quoteRequests is array:', Array.isArray(quoteRequests));
                    // console.log('[ShipStation API] quoteRequests keys:', Object.keys(quoteRequests));
                    // console.log('[ShipStation API] quoteRequests length:', Object.keys(quoteRequests).length);
                }
                
                if (quoteRequests && Object.keys(quoteRequests).length > 0) {
                    const count = Object.keys(quoteRequests).length;
                    // console.log(`[ShipStation API] ✓ Fetch completed successfully. Generated ${count} quote request(s).`);
                    // console.log('[ShipStation API] Order numbers in quoteRequests:', Object.keys(quoteRequests));
                    // console.log('[ShipStation API] Setting globalQuoteRequests...');
                    globalQuoteRequests = quoteRequests;
                    // console.log('[ShipStation API] globalQuoteRequests set. Current keys:', Object.keys(globalQuoteRequests));
                    if (rateDialogHandler) {
                        rateDialogHandler.quoteRequestsCache = quoteRequests;
                        // console.log('[ShipStation API] rateDialogHandler.quoteRequestsCache also set');
                    } else {
                        // console.warn('[ShipStation API] rateDialogHandler is null - cannot set cache');
                    }
                } else {
                    // console.warn('[ShipStation API] ⚠️ Fetch returned no quote requests');
                    // console.warn('[ShipStation API] quoteRequests value:', quoteRequests);
                    // console.warn('[ShipStation API] globalQuoteRequests remains:', Object.keys(globalQuoteRequests));
                }
                // console.log('[ShipStation API] ========== autoFetchOrderGrid END ==========');
            } catch (error) {
                // console.error('[ShipStation API] ========== autoFetchOrderGrid ERROR ==========');
                // console.error('[ShipStation API] Fatal error in autoFetchOrderGrid:', error);
                // console.error('[ShipStation API] Error message:', error.message);
                // console.error('[ShipStation API] Error stack:', error.stack);
            }
        }

        // Expose autoFetchOrderGrid to window for access by RateDialogHandler
        window.autoFetchOrderGrid = autoFetchOrderGrid;

        function initializeAutoFetch() {
            // Only initialize on ShipStation domains
            if (!isShipStationDomain()) {
                // console.log('[ShipStation API] initializeAutoFetch skipped - not ShipStation domain');
                return;
            }
            
            // console.log('[ShipStation API] ========== initializeAutoFetch START ==========');
            const POLLING_INTERVAL = 60000;
            // console.log('[ShipStation API] Polling interval set to:', POLLING_INTERVAL, 'ms');

            function startPolling() {
                if (!isShipStationDomain()) {
                    // console.log('[ShipStation API] startPolling skipped - not ShipStation domain');
                    return;
                }
                // console.log('[ShipStation API] startPolling called - triggering autoFetchOrderGrid');
                autoFetchOrderGrid();
                
                if (pollingIntervalId) {
                    clearInterval(pollingIntervalId);
                }
                
                pollingIntervalId = setInterval(() => {
                    if (!isShipStationDomain()) {
                        if (pollingIntervalId) {
                            clearInterval(pollingIntervalId);
                            pollingIntervalId = null;
                        }
                        return;
                    }
                    autoFetchOrderGrid();
                }, POLLING_INTERVAL);
                
                // console.log(`[ShipStation API] Polling started. Will fetch every ${POLLING_INTERVAL / 1000} seconds.`);
            }

            // console.log('[ShipStation API] Document readyState:', document.readyState);
            if (document.readyState === 'loading') {
                // console.log('[ShipStation API] Document is loading - waiting for DOMContentLoaded');
                document.addEventListener('DOMContentLoaded', () => {
                    // console.log('[ShipStation API] DOMContentLoaded fired - starting polling in 2 seconds');
                    setTimeout(() => {
                        // console.log('[ShipStation API] 2 second delay complete - calling startPolling');
                        startPolling();
                    }, 2000);
                });
            } else {
                // console.log('[ShipStation API] Document already loaded - starting polling in 2 seconds');
                setTimeout(() => {
                    // console.log('[ShipStation API] 2 second delay complete - calling startPolling');
                    startPolling();
                }, 2000);
            }
            // console.log('[ShipStation API] ========== initializeAutoFetch END ==========');

            window.addEventListener('beforeunload', () => {
                if (pollingIntervalId) {
                    clearInterval(pollingIntervalId);
                    pollingIntervalId = null;
                }
            });
        }

        // Expose debugging functions to window for manual testing
        window.debugFedExExtension = {
            // Check current state
            checkState: function() {
                // console.log('========== FedEx Extension Debug State ==========');
                // console.log('globalQuoteRequests:', globalQuoteRequests);
                // console.log('globalQuoteRequests keys:', Object.keys(globalQuoteRequests));
                // console.log('globalQuoteRequests count:', Object.keys(globalQuoteRequests).length);
                // console.log('mostRecentOrderNumber:', mostRecentOrderNumber);
                // console.log('serviceLabelToCodeMap:', serviceLabelToCodeMap ? 'Loaded' : 'Not loaded');
                // console.log('isShipStationDomain():', isShipStationDomain());
                // console.log('cachedBearerToken:', cachedBearerToken ? `Found (length: ${cachedBearerToken.length})` : 'NOT FOUND');
                // console.log('pollingIntervalId:', pollingIntervalId);
                // console.log('================================================');
                return {
                    globalQuoteRequests: globalQuoteRequests,
                    count: Object.keys(globalQuoteRequests).length,
                    mostRecentOrderNumber: mostRecentOrderNumber,
                    hasServiceMap: !!serviceLabelToCodeMap,
                    hasToken: !!cachedBearerToken,
                    isPolling: !!pollingIntervalId
                };
            },
            // Manually trigger fetch
            triggerFetch: async function() {
                // console.log('========== Manually Triggering Fetch ==========');
                try {
                    await autoFetchOrderGrid();
                    // console.log('========== Manual Fetch Completed ==========');
                    this.checkState();
                } catch (error) {
                    // console.error('Manual fetch error:', error);
                }
            },
            // Get quote request for specific order
            getQuoteRequest: function(orderNumber) {
                // console.log(`Looking for quote request for order: ${orderNumber}`);
                const request = globalQuoteRequests[orderNumber];
                if (request) {
                    // console.log('Found quote request:', request);
                    return request;
                } else {
                    // console.warn('Quote request not found');
                    // console.log('Available orders:', Object.keys(globalQuoteRequests));
                    return null;
                }
            },
            // Test API call directly
            testAPICall: async function() {
                // console.log('========== Testing API Call Directly ==========');
                try {
                    const payload = {
                        page: { pageNumber: 1, pageSize: 250 },
                        filter: { orderGridStatus: "AwaitingShipment" },
                        includeQueryCount: false,
                        orderBys: [{ orderBy: "OrderDateTime", orderByDirection: "Descending" }]
                    };
                    // console.log('Test payload:', payload);
                    const result = await getOrderGridData();
                    // console.log('Test result:', result);
                    return result;
                } catch (error) {
                    // console.error('Test API call error:', error);
                    return null;
                }
            }
        };
        
        try {
            // console.log('[FedEx Extension] ========== Reached ShipStation API initialization section ==========');
            // console.log('[ShipStation API] ========== About to call initializeAutoFetch ==========');
            // console.log('[ShipStation API] Debug functions available: window.debugFedExExtension');
            // console.log('[ShipStation API]   - checkState() - Check current state');
            // console.log('[ShipStation API]   - triggerFetch() - Manually trigger fetch');
            // console.log('[ShipStation API]   - getQuoteRequest(orderNumber) - Get quote for order');
            // console.log('[ShipStation API]   - testAPICall() - Test API call directly');
            // console.log('[ShipStation API] Calling initializeAutoFetch() now...');
            initializeAutoFetch();
            // console.log('[ShipStation API] ✓ initializeAutoFetch call completed');
        } catch (error) {
            // console.error('[FedEx Extension] ❌ ERROR during ShipStation API initialization:', error);
            // console.error('[FedEx Extension] Error message:', error.message);
            // console.error('[FedEx Extension] Error stack:', error.stack);
        }

        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'ping') {
            sendResponse({ success: true, ready: true });
            return true;
        }

        if (request.action === 'callShipStationOrderGrid') {
            callShipStationOrderGrid(request.payload)
                .then(result => {
                    sendResponse(result);
                })
                .catch(error => {
                    sendResponse({ success: false, error: error.message });
                });
            return true;
        }

        if (request.action === 'fetchOrderGrid') {
            fetchOrderGrid(request.payload)
                .then(data => {
                    sendResponse({ success: true, data: data });
                })
                .catch(error => {
                    sendResponse({ success: false, error: error.message });
                });
            return true;
        }

        if (request.action === 'getOrderGridData') {
            getOrderGridData(
                request.filterStatus || "AwaitingShipment",
                request.pageNumber || 1,
                request.pageSize || 250,
                request.includeQueryCount || false
            )
                .then(data => {
                    sendResponse({ success: true, data: data });
                })
                .catch(error => {
                    sendResponse({ success: false, error: error.message });
                });
            return true;
        }
        
        if (request.action === 'logToConsole') {
            // console.log(request.message);
            if (request.data) {
                // console.log('Response Data:', JSON.stringify(request.data, null, 2));
                if (Array.isArray(request.data)) {
                    // console.log(`Total Shipments: ${request.data.length}`);
                } else if (request.data && typeof request.data === 'object') {
                    if (request.data.shipments && Array.isArray(request.data.shipments)) {
                        // console.log(`Total Shipments: ${request.data.shipments.length}`);
                    }
                }
            }
            sendResponse({ success: true });
        }

        if (request.action === 'emailStatus') {
            // console.log('[RateDialogHandler] ========== Email Status Update ==========');
            if (request.success) {
                // console.log('[RateDialogHandler] ✓ EMAIL SENT SUCCESSFULLY!');
                // console.log('[RateDialogHandler] Message:', request.message);
            } else {
                // console.error('[RateDialogHandler] ✗ EMAIL FAILED TO SEND!');
                // console.error('[RateDialogHandler] Error:', request.error);
                if (request.error && request.error.includes('EmailJS not configured')) {
                    // console.error('[RateDialogHandler] ⚠️ ACTION REQUIRED: Please configure EmailJS in background.js');
                    // console.error('[RateDialogHandler] See EMAILJS-SETUP.md for instructions');
                }
            }
            // console.log('[RateDialogHandler] ============================================');
            sendResponse({ success: true });
        }
        
        return true;
        });
    } catch (error) {
        // console.error('Fatal error in content script:', error);
    }

})();
