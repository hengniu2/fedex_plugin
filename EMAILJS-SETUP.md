# EmailJS Setup Guide

This guide will help you set up EmailJS so that email notifications are sent directly to your Gmail inbox when the Quote API fails.

## Quick Setup (5 minutes)

### Step 1: Create EmailJS Account
1. Go to https://www.emailjs.com/
2. Click "Sign Up" and create a free account (free tier allows 200 emails/month)

### Step 2: Add Email Service (Gmail)
1. After logging in, go to **Email Services** in the left sidebar
2. Click **Add New Service**
3. Select **Gmail** (or your preferred email service)
4. Follow the instructions to connect your Gmail account
5. **Copy the Service ID** (you'll need this later)

### Step 3: Create Email Template
1. Go to **Email Templates** in the left sidebar
2. Click **Create New Template**
3. Use this template structure:

**Template Name:** FedEx API Failure Notification

**Subject:** `{{subject}}`

**Content:**
```
{{message}}
```

4. **Copy the Template ID** (you'll need this later)

### Step 4: Get Public Key
1. Go to **Account** → **General** in the left sidebar
2. Find **Public Key** section
3. **Copy the Public Key** (you'll need this later)

### Step 5: Update background.js
1. Open `background.js` in your project
2. Find the `EMAILJS_CONFIG` section (around line 170)
3. Replace the placeholder values:

```javascript
const EMAILJS_CONFIG = {
    serviceId: 'YOUR_SERVICE_ID',        // Paste your Service ID here
    templateId: 'YOUR_TEMPLATE_ID',      // Paste your Template ID here
    publicKey: 'YOUR_PUBLIC_KEY'         // Paste your Public Key here
};
```

### Step 6: Test
1. Reload the extension in Chrome
2. Trigger a Quote API failure (or wait for one to occur)
3. Check your Gmail inbox - you should receive the email!

## Example Configuration

After setup, your `EMAILJS_CONFIG` should look like this:

```javascript
const EMAILJS_CONFIG = {
    serviceId: 'service_abc123',
    templateId: 'template_xyz789',
    publicKey: 'abcdefghijklmnopqrstuvwxyz'
};
```

## Troubleshooting

- **Emails not arriving?** Check that your Service ID, Template ID, and Public Key are correct
- **API errors?** Make sure your Gmail service is connected and active in EmailJS dashboard
- **Free tier limits?** EmailJS free tier allows 200 emails/month. Upgrade if needed.

## Need Help?

Visit EmailJS documentation: https://www.emailjs.com/docs/

