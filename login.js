function startLoginMonitor({ toast }) {
    let previousLoginStatus = null;
    let loginCheckInterval = null;
    let cachedBearerToken = null;

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

    async function checkLoginStatus(showToastOnChange = true) {
        const checks = {
            hasAuthCookie: false,
            hasAuth0LoginCookie: false,
            hasAuth0AuthenticatedCookie: false,
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

            // Auth0 cookies used by ShipStation for auth state (more reliable than DOM heuristics)
            const getCookieValue = (name) => {
                const match = cookies.find(c => c.startsWith(name + '='));
                if (!match) return null;
                return match.substring(name.length + 1);
            };

            const auth0IsLogin = getCookieValue('auth0.is.login');
            const auth0IsAuthenticated = getCookieValue('auth0.is.authenticated');

            // These cookies typically store "true"/"false"
            checks.hasAuth0LoginCookie = (auth0IsLogin === 'true');
            checks.hasAuth0AuthenticatedCookie = (auth0IsAuthenticated === 'true');


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

            const isLoggedIn = checks.hasAuth0AuthenticatedCookie || checks.hasAuth0LoginCookie || checks.hasAuthCookie || checks.hasBearerToken || checks.hasUserElements;

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


            return { isLoggedIn, checks };
        } catch (error) {
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

    function interceptFetchForToken() {
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
            const [url, options = {}] = args;
            
            if (typeof url === 'string' && url.includes('shipstation.com/api')) {
                const authHeader = options.headers?.Authorization || options.headers?.['authorization'];
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    cachedBearerToken = authHeader.replace('Bearer ', '');
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
                    }
                }
                return originalSetRequestHeader.apply(this, [header, value]);
            };
        }
    }

    interceptFetchForToken();
    initializeLoginCheck();

    return {
        checkLoginStatus,
        stop: () => loginCheckInterval && clearInterval(loginCheckInterval)
    }
}