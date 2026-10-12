# ESO Closer — Group Meeting Landing Page

A landing page where e-commerce sellers book a seat in the ESO Closer group meeting and pay the registration fee with Razorpay, plus an admin page to run it: set the fee, connect Razorpay and email, and download paid registrations to Excel.

Built to match the look of [closer.esowolf.in](https://closer.esowolf.in/) (navy + orange, Geist / Inter / JetBrains Mono).

---

## Features

**Landing page** (`/`)

- Navbar: Home, About, Services and a **Book Now** button that scrolls to the form
- Booking form: Name, Phone number (+91, 10 digits), Mail ID, Seller type (Existing / New seller), **Pay Now**
- About, Services, How it works and a footer
- Works on phones; no sideways scrolling

**Payments**

- Pay Now opens Razorpay Checkout (UPI, cards, net banking)
- The **server** decides the amount, never the browser
- Every payment's signature is checked on the server before it counts as paid
- Paid registrations are saved once per payment ID; double clicks and retries never save twice
- **Razorpay webhook**: Razorpay tells the server directly when a payment succeeds, so a buyer who pays and closes the tab is still recorded

**Admin page** (`/admin`, login required)

Four settings cards in an accordion:

| Card | What it does |
|---|---|
| **Set the amount** | Registration fee in ₹. The landing page shows it and Razorpay charges it. |
| **Razorpay keys** | Key ID + Key Secret, checked with Razorpay before saving, with Test / Live mode shown. Also holds the **webhook** URL and secret, and when the last webhook arrived. |
| **Email (SMTP)** | Gmail / Outlook / Zoho / custom. Checked before saving, plus a "Send test" button. |
| **Change login** | New username and password, emailed to the mail ID you enter. |

**Paid registrations**

- Table with count and total collected
- Date filter: All time, Today, Yesterday, Last 7 / 30 days, This month, Last month or a custom From–To range (IST days, both ends included)
- **Download Excel**: a real `.xlsx` with only the filtered rows, ₹ formatting, filter buttons, a frozen header row and a SUM total

---

## Run it

Needs **Node.js 22.2 or newer** (Node 24 recommended).

```bash
git clone https://github.com/esoscalesoft2-source/closer-group-meeting.git
cd closer-group-meeting
npm install
cp .env.example .env
```

Open `.env` and set at least:

```ini
ADMIN_PASSWORD=choose-a-strong-password
APP_SECRET=any-long-random-string
```

Then start the server:

```bash
npm start
```

- Landing page: http://localhost:3002
- Admin page: http://localhost:3002/admin (username `admin`, password from `.env`)

### First-time setup in /admin

1. **Razorpay keys**: paste the Key ID and Key Secret from Razorpay Dashboard → Account & Settings → API Keys. Start with `rzp_test_` keys and switch to `rzp_live_` when you're ready for real payments.
2. **Webhook** (in the same card, once the site is on a public https address): press **Generate**, then in Razorpay Dashboard → Accounts & Settings → Webhooks → Add New Webhook, paste the **Webhook URL** and the same secret and tick **payment.captured** and **order.paid**. Save in both places. The card shows "Receiving" once Razorpay's first webhook arrives.
3. **Email (SMTP)**: for Gmail, use `smtp.gmail.com`, port `587`, your Gmail address and a Google **App Password** (Google Account → Security → 2-Step Verification → App passwords). A normal Gmail password will not work. Press **Send test** to confirm.
4. **Set the amount**: enter the registration fee and Save.
5. **Change login**: replace the starting password from `.env` with your own.

---

## Configuration (`.env`)

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | **Yes** | First admin password. Once changed on /admin, the saved one is used instead. |
| `ADMIN_USERNAME` | No | First admin username (default `admin`). |
| `APP_SECRET` | **Yes** | Key that encrypts the SMTP password and Razorpay secret saved on /admin. **Don't change it later**, or both have to be entered again. |
| `PORT` | No | Default `3002`. |
| `REGISTRATION_FEE` | No | Starting fee in ₹ until one is saved on /admin (default `999`). |
| `BUSINESS_NAME` | No | Shown on the Razorpay popup and in emails (default `ESO Closer`). |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | No | Fallback if no keys are saved on /admin. |
| `RAZORPAY_WEBHOOK_SECRET` | No | Fallback if no webhook secret is saved on /admin. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | No | Fallback if no email settings are saved on /admin. |
| `PUBLIC_URL` | No | Public address of the site, e.g. `https://meet.example.com`. Used for the webhook URL shown on /admin and the login link in emails. Defaults to the address the admin page was opened on. |
| `DATA_DIR` | No | Where data is stored (default `./data`). |

Settings saved on /admin always win over `.env`.

---

## Where data is kept

Everything is stored as files in `data/`, which is **git-ignored**:

| File | Contents |
|---|---|
| `registrations.json` | Paid registrations |
| `settings.json` | Registration fee |
| `admin.json` | Admin username + **scrypt-hashed** password |
| `razorpay.json` | Key ID + **encrypted** Key Secret |
| `smtp.json` | SMTP settings + **encrypted** password |
| `webhook.json` | **Encrypted** webhook secret + when the last webhook arrived |
| `secret.key` | Only created if `APP_SECRET` is not set |

**Back up `data/` and `.env` together.** The encrypted values can only be read with the same `APP_SECRET`.

Forgot the admin password? Delete `data/admin.json` and the login from `.env` works again.

---

## Security notes

- The server sets the amount; the browser can't change what is charged
- Every payment is confirmed by checking Razorpay's HMAC signature on the server, both from the browser and from the webhook (the webhook signature is checked over the raw request bytes)
- Webhooks are account-wide, so only orders this page created (marked in the order notes) are recorded. Other payments on the same Razorpay account are skipped.
- Admin sessions use an `HttpOnly`, `SameSite=Strict` cookie. Admin writes must be JSON.
- 5 wrong logins (or wrong "current password" attempts) lock that IP out for 10 minutes
- Changing the login signs out every other browser
- Secrets are never sent back to the browser. The admin page only shows "Saved ✓".
- Only the page files and `assets/` are served. `.env`, `data/` and the server code can't be opened from a browser.
- Excel cells are written as text, so a name typed as `=…` stays text and never runs as a formula

**Known limits**

- Admin sessions are kept in memory, so restarting the server signs everyone out
- One admin account
- Changing the login sends the new password by email, so use a mailbox only you can read
- Razorpay can't send webhooks to `localhost`. They start working once the site is on a public https address. Until then, a buyer who closes the tab right after paying may be missing from `registrations.json`, though the payment is still in the Razorpay dashboard.

---

## Project structure

```
├── index.html       Landing page
├── styles.css       Shared styles (landing + admin)
├── script.js        Booking form + Razorpay Checkout
├── admin.html       Admin page
├── admin.js         Admin page logic
├── server.js        HTTP server, API, Razorpay, email, admin
├── xlsx.js          Small built-in Excel (.xlsx) writer, no dependencies
├── assets/          Logo
├── .env.example     Settings template
└── data/            Runtime data (git-ignored, created automatically)
```

The only npm dependency is [`nodemailer`](https://nodemailer.com/).

---

## API

Public:

| Method | Path | |
|---|---|---|
| `GET` | `/api/config` | Current fee and whether payments are on |
| `POST` | `/api/create-order` | Checks the form and creates a Razorpay order |
| `POST` | `/api/verify-payment` | Checks the payment signature and saves the registration |
| `POST` | `/api/webhooks/razorpay` | Razorpay webhook (`payment.captured`, `order.paid`); signature-checked |

Admin (login required):

| Method | Path | |
|---|---|---|
| `POST` | `/api/admin/login`, `/api/admin/logout` | Sign in / out |
| `GET` `PUT` | `/api/admin/settings` | Fee |
| `GET` `PUT` `DELETE` | `/api/admin/razorpay` | Razorpay keys |
| `GET` `PUT` `DELETE` | `/api/admin/webhook` | Webhook secret, URL and last-received status |
| `GET` `PUT` `DELETE` | `/api/admin/smtp` | Email settings |
| `POST` | `/api/admin/smtp/test` | Send a test email |
| `POST` | `/api/admin/credentials` | Change login and email it |
| `GET` | `/api/admin/registrations?from=&to=` | Paid registrations (dates `YYYY-MM-DD`, IST) |
| `GET` | `/api/admin/registrations.xlsx?from=&to=` | Same, as an Excel file |
