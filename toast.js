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