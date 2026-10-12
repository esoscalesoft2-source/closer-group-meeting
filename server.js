// Server for the ESO Closer group meeting landing page.
// Serves the static page, the Razorpay endpoints the Pay Now button uses, and
// the /admin page. Only dependency: nodemailer, for the login-changed email.
// Run: node server.js  →  http://localhost:3002
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { buildXlsx } = require('./xlsx')

const ROOT = __dirname
const ENV_FILE = path.join(ROOT, '.env')
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

const PORT = Number(process.env.PORT) || 3002
// Fallback only. Keys saved on /admin (data/razorpay.json) win over these.
const ENV_RZP = { keyId: process.env.RAZORPAY_KEY_ID || '', keySecret: process.env.RAZORPAY_KEY_SECRET || '' }
const ENV_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || ''
// Stamped on every order this page creates. Razorpay webhooks are account-wide, so this is
// how a webhook tells our orders apart from other payments on the same Razorpay account.
const ORDER_PURPOSE = 'Group meeting registration'
// Starting fee, used until an admin saves one on /admin.
const DEFAULT_FEE = Number(process.env.REGISTRATION_FEE) || 999
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'ESO Closer'
// First login only. Once changed on /admin, data/admin.json (hashed) wins.
// Closer, where a booking becomes a client in the group class that takes
// website bookings — and so gets its WhatsApp reminders with each class's
// Teams link. Both empty: bookings stay on this site only.
const CLOSER_API_URL = (process.env.CLOSER_API_URL || '').replace(/\/+$/, '')
const CLOSER_API_KEY = process.env.CLOSER_API_KEY || ''

const ENV_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

// Fallback only. Email settings saved on /admin (data/smtp.json) win over these.
const ENV_SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
}

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data')
const REG_FILE = path.join(DATA_DIR, 'registrations.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json')
const SMTP_FILE = path.join(DATA_DIR, 'smtp.json')
const RZP_FILE = path.join(DATA_DIR, 'razorpay.json')
const WEBHOOK_FILE = path.join(DATA_DIR, 'webhook.json')
const KEY_FILE = path.join(DATA_DIR, 'secret.key')

const MIN_FEE = 1
const MAX_FEE = 1_000_000

const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'script.js', 'admin.html', 'admin.js'])
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const SELLER_TYPES = { existing: 'Existing seller', new: 'New seller' }

/* ---------------- helpers ---------------- */

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) {
        reject(new Error('Body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

// The exact bytes sent. Webhook signatures are over these bytes, so they must not be
// parsed and re-serialised before checking.
function readRawBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Same rules as the form in script.js — the server re-checks, never trusts.
function validateBooking(b) {
  const name = String(b.name || '').trim()
  const phone = String(b.phone || '').replace(/\D/g, '')
  const email = String(b.email || '').trim()
  const sellerType = String(b.sellerType || '')

  const errors = {}
  if (name.length < 2 || name.length > 80) errors.name = 'Please enter your name.'
  if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a valid 10-digit mobile number.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) errors.email = 'Enter a valid mail ID.'
  if (!SELLER_TYPES[sellerType]) errors.sellerType = 'Please choose existing or new seller.'

  return { errors, booking: { name, phone: `+91${phone}`, email, sellerType } }
}

// Razorpay rejects notes containing emoji, so keep notes to plain text.
const plain = (s) => String(s).replace(/[^\p{L}\p{N}\p{P}\p{Zs}+]/gu, '').slice(0, 250)

// The keys in force: saved on /admin if any, else .env.
function rzpConfig() {
  const saved = readJson(RZP_FILE)
  if (saved?.keyId) {
    let keySecret = ''
    try {
      keySecret = decryptSecret(saved.secretEnc)
    } catch (e) {
      console.error('Saved Razorpay secret could not be decrypted (APP_SECRET or secret.key changed?):', e.message)
    }
    return { keyId: saved.keyId, keySecret, source: 'admin', updatedAt: saved.updatedAt }
  }
  return { ...ENV_RZP, source: ENV_RZP.keyId ? 'env' : 'none', updatedAt: null }
}

const paymentsEnabled = () => {
  const c = rzpConfig()
  return Boolean(c.keyId && c.keySecret)
}
const rzpMode = (keyId) => (String(keyId).startsWith('rzp_live_') ? 'LIVE' : 'TEST')

function razorpay(method, apiPath, payload, creds = rzpConfig()) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : ''
    const req = https.request(
      {
        host: 'api.razorpay.com',
        path: `/v1${apiPath}`,
        method,
        auth: `${creds.keyId}:${creds.keySecret}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15_000,
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let json = {}
          try {
            json = JSON.parse(raw)
          } catch {}
          resolve({ status: res.statusCode, json })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('Razorpay timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

function readRegistrations() {
  try {
    return JSON.parse(fs.readFileSync(REG_FILE, 'utf8'))
  } catch {
    return []
  }
}

// One row per payment id. The browser's confirmation and Razorpay's webhook can both
// report the same payment, in either order: the first creates the row, a later one
// only fills in fields that are still empty. Returns 'new' | 'updated' | 'duplicate'.
function saveRegistration(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const all = readRegistrations()
  const existing = all.find((r) => r.paymentId === entry.paymentId)
  let result = 'new'
  if (existing) {
    const missing = Object.keys(entry).filter((k) => (existing[k] === null || existing[k] === undefined) && entry[k] != null)
    if (!missing.length) return 'duplicate'
    missing.forEach((k) => (existing[k] = entry[k]))
    result = 'updated'
  } else {
    all.push(entry)
  }
  fs.writeFileSync(`${REG_FILE}.tmp`, JSON.stringify(all, null, 2))
  fs.renameSync(`${REG_FILE}.tmp`, REG_FILE)
  return result
}

// A free booking — the landing page's Book Now, no payment. One seat per phone
// number: booking again with the same number returns the seat already held
// rather than a second row. Returns { entry, existing }.
function saveFreeBooking(booking) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const all = readRegistrations()
  const held = all.find((r) => r.source === 'free' && r.phone === booking.phone)
  if (held) return { entry: held, existing: true }
  const entry = {
    id: `GM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    name: booking.name,
    phone: booking.phone,
    email: booking.email,
    sellerType: SELLER_TYPES[booking.sellerType],
    amountPaise: 0,
    bookedAt: new Date().toISOString(),
    source: 'free',
  }
  all.push(entry)
  fs.writeFileSync(`${REG_FILE}.tmp`, JSON.stringify(all, null, 2))
  fs.renameSync(`${REG_FILE}.tmp`, REG_FILE)
  return { entry, existing: false }
}

// Fill in fields on a saved registration, by its booking id.
function updateRegistration(id, patch) {
  const all = readRegistrations()
  const row = all.find((r) => r.id === id)
  if (!row) return
  Object.assign(row, patch)
  fs.writeFileSync(`${REG_FILE}.tmp`, JSON.stringify(all, null, 2))
  fs.renameSync(`${REG_FILE}.tmp`, REG_FILE)
}

/**
 * Hand a booking to Closer (its integrations API, with the workspace's API
 * key): the person becomes a client in the group class that takes website
 * bookings. The outcome is kept on the registration as `closer`, so one that
 * failed is sent again when the same number books again. Never throws.
 */
async function sendToCloser(entry) {
  if (!CLOSER_API_URL || !CLOSER_API_KEY) return
  let closer
  try {
    const res = await fetch(`${CLOSER_API_URL}/api/integrations/v1/group-class/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CLOSER_API_KEY}` },
      body: JSON.stringify({ name: entry.name, phone: entry.phone, email: entry.email, sellerType: entry.sellerType }),
      signal: AbortSignal.timeout(15_000),
    })
    const json = await res.json().catch(() => ({}))
    closer = res.ok
      ? { ok: true, clientId: json.data?.clientId ?? null, className: json.data?.className ?? null, at: new Date().toISOString() }
      : { ok: false, error: closerErrorMessage(res.status, json), at: new Date().toISOString() }
  } catch (e) {
    const error =
      e.name === 'TimeoutError'
        ? 'Closer did not answer within 15 seconds'
        : `Could not reach Closer (${e.cause?.code || e.message})`
    closer = { ok: false, error, at: new Date().toISOString() }
  }
  // This runs after the visitor has their answer, with nobody awaiting it: an error
  // escaping here would be an unhandled rejection, which stops the whole server.
  try {
    updateRegistration(entry.id, { closer })
  } catch (e) {
    console.error(`✖ Could not save the Closer result on ${entry.id}:`, e.message)
  }
  if (closer.ok) console.log(`→ Closer: ${entry.name} is in ${closer.className}`)
  else console.error(`✖ Closer did not take ${entry.id}: ${closer.error}`)
}

// Closer's own message where it sent one (its envelope: { error: { code, message } }),
// with the status in front so the admin column says what kind of failure it was.
function closerErrorMessage(status, json) {
  const message = json?.error?.message
  const kind =
    status === 400 || status === 422
      ? 'Closer refused the details'
      : status === 401 || status === 403
        ? 'Closer rejected the API key'
        : status === 409
          ? 'No group class in Closer takes website bookings'
          : `Closer answered ${status}`
  if (status === 409) return message || kind // Closer's 409 message already says what to switch on
  return message && status !== 401 && status !== 403 ? `${kind}: ${message}` : kind
}

/* ---------------- settings (the fee) ---------------- */

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

// The fee lives on the server only. The browser never tells us how much to charge.
function currentFee() {
  const fee = Number(readSettings().fee)
  return Number.isInteger(fee) && fee >= MIN_FEE && fee <= MAX_FEE ? fee : DEFAULT_FEE
}

function saveSettings(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const next = { ...readSettings(), ...patch }
  // Write then rename, so a crash mid-write never leaves a half-written file.
  fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(next, null, 2))
  fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE)
  return next
}

/* ---------------- admin sessions ---------------- */

const SESSION_COOKIE = 'gm_admin'
const SESSION_MS = 12 * 60 * 60 * 1000
const sessions = new Map() // token → expiresAt
const loginAttempts = new Map() // ip → { count, resetAt }

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest()
  const y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

function getCookie(req, name) {
  const match = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : ''
}

function isAdmin(req) {
  const token = getCookie(req, SESSION_COOKIE)
  const expiresAt = token && sessions.get(token)
  if (!expiresAt) return false
  if (expiresAt < Date.now()) {
    sessions.delete(token)
    return false
  }
  return true
}

function sessionCookie(req, token, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`
}

// Admin writes must be JSON. A cross-site form can't send that content type
// without a preflight, which this server never approves.
const isJson = (req) => (req.headers['content-type'] || '').startsWith('application/json')

/* ---------------- Razorpay keys (admin) ---------------- */

function rzpPublicView() {
  const c = rzpConfig()
  return {
    keyId: c.keyId,
    hasSecret: Boolean(c.keySecret),
    source: c.source,
    configured: Boolean(c.keyId && c.keySecret),
    mode: rzpMode(c.keyId),
    updatedAt: c.updatedAt,
  }
}

function handleAdminGetRazorpay(req, res) {
  sendJson(res, 200, rzpPublicView())
}

async function handleAdminSaveRazorpay(req, res) {
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const keyId = String(body.keyId || '').trim()
  const newSecret = String(body.keySecret || '').trim()
  const current = rzpConfig()
  // Blank secret = keep the saved one (it is never sent to the browser) — only for the same Key ID.
  const keySecret = newSecret || (current.keyId === keyId ? current.keySecret : '')

  const fields = {}
  if (!/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/.test(keyId)) fields.keyId = 'Key ID starts with rzp_test_ or rzp_live_.'
  if (!keySecret) fields.keySecret = 'Enter the Key Secret.'
  else if (!/^[A-Za-z0-9]{10,60}$/.test(keySecret)) fields.keySecret = "That doesn't look like a Razorpay Key Secret."
  if (Object.keys(fields).length) return sendJson(res, 422, { error: 'Please fix the highlighted fields.', fields })

  // Check the pair with Razorpay before saving — a wrong secret should fail here,
  // not later as a customer's failed checkout.
  try {
    const { status, json } = await razorpay('GET', '/orders?count=1', null, { keyId, keySecret })
    if (status === 401) {
      return sendJson(res, 422, { error: 'Razorpay rejected these keys. Check the Key ID and Key Secret (and that both are from the same mode).' })
    }
    if (status === 429) {
      return sendJson(res, 422, { error: 'Razorpay is limiting requests right now. Wait a minute and try again.' })
    }
    if (status >= 400) {
      return sendJson(res, 422, { error: json.error?.description || `Razorpay answered ${status}. Please try again.` })
    }
  } catch (e) {
    return sendJson(res, 502, { error: 'Could not reach Razorpay. Check the internet connection and try again.' })
  }

  writeJson(RZP_FILE, { keyId, secretEnc: encryptSecret(keySecret), updatedAt: new Date().toISOString() })
  console.log(`Razorpay keys saved (${rzpMode(keyId)} mode, ${keyId})`)
  sendJson(res, 200, rzpPublicView())
}

function handleAdminDeleteRazorpay(req, res) {
  try {
    fs.unlinkSync(RZP_FILE)
  } catch {}
  console.log('Razorpay keys removed')
  sendJson(res, 200, rzpPublicView())
}

/* ---------------- Razorpay webhook ---------------- */

// The address this site is reached at: PUBLIC_URL if set, else the request's own host.
function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '')
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  return `${proto}://${req.headers.host}`
}

const isLocalHost = (origin) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|[^/]*\.localhost)(:|\/|$)/i.test(origin)

// The webhook secret in force: saved on /admin (encrypted) if any, else .env.
function webhookConfig() {
  const saved = readJson(WEBHOOK_FILE) || {}
  let secret = ''
  let source = 'none'
  if (saved.secretEnc) {
    try {
      secret = decryptSecret(saved.secretEnc)
      source = 'admin'
    } catch (e) {
      console.error('Saved webhook secret could not be decrypted (APP_SECRET or secret.key changed?):', e.message)
    }
  } else if (ENV_WEBHOOK_SECRET) {
    secret = ENV_WEBHOOK_SECRET
    source = 'env'
  }
  return { secret, source, saved }
}

function webhookPublicView(req) {
  const { secret, source, saved } = webhookConfig()
  const url = `${publicOrigin(req)}/api/webhooks/razorpay`
  return {
    url,
    urlIsLocal: isLocalHost(url),
    hasSecret: Boolean(secret),
    source,
    updatedAt: saved.updatedAt || null,
    lastEventAt: saved.lastEventAt || null,
    lastEvent: saved.lastEvent || null,
    lastResult: saved.lastResult || null,
  }
}

function recordWebhookStatus(patch) {
  writeJson(WEBHOOK_FILE, { ...(readJson(WEBHOOK_FILE) || {}), ...patch })
}

function handleAdminGetWebhook(req, res) {
  sendJson(res, 200, webhookPublicView(req))
}

async function handleAdminSaveWebhook(req, res) {
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }
  const secret = String(body.secret || '').trim()
  if (secret.length < 12 || secret.length > 100 || /\s/.test(secret)) {
    return sendJson(res, 422, { error: 'Use 12–100 characters with no spaces.', fields: { secret: 'Use 12–100 characters with no spaces.' } })
  }
  recordWebhookStatus({ secretEnc: encryptSecret(secret), updatedAt: new Date().toISOString() })
  console.log('Razorpay webhook secret saved')
  sendJson(res, 200, webhookPublicView(req))
}

function handleAdminDeleteWebhook(req, res) {
  const saved = readJson(WEBHOOK_FILE) || {}
  delete saved.secretEnc
  delete saved.updatedAt
  writeJson(WEBHOOK_FILE, saved)
  console.log('Razorpay webhook secret removed')
  sendJson(res, 200, webhookPublicView(req))
}

// Razorpay calls this when a payment succeeds — even if the buyer closed the tab
// before the page could confirm it. Razorpay retries anything that isn't a 2xx, so
// every "nothing to do" case answers 200, and only a bad signature is refused.
async function handleRazorpayWebhook(req, res) {
  let raw
  try {
    raw = await readRawBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const { secret } = webhookConfig()
  if (!secret) {
    console.warn('Razorpay webhook received, but no webhook secret is set — ignored. Set it on /admin → Razorpay keys.')
    return sendJson(res, 503, { error: 'Webhook not set up.' })
  }

  const signature = String(req.headers['x-razorpay-signature'] || '')
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  const valid = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  if (!valid) {
    console.warn('Razorpay webhook with a bad signature — ignored. Does the secret on /admin match the one in Razorpay?')
    recordWebhookStatus({ lastEventAt: new Date().toISOString(), lastEvent: null, lastResult: 'bad-signature' })
    return sendJson(res, 400, { error: 'Invalid signature.' })
  }

  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON.' })
  }

  const event = String(body.event || '')
  const status = (lastResult) => recordWebhookStatus({ lastEventAt: new Date().toISOString(), lastEvent: event, lastResult })

  if (event !== 'payment.captured' && event !== 'order.paid') {
    status('ignored')
    return sendJson(res, 200, { ok: true, ignored: event })
  }

  const payment = body.payload?.payment?.entity || {}
  const orderId = String(payment.order_id || body.payload?.order?.entity?.id || '')
  const paymentId = String(payment.id || '')
  if (!paymentId || !orderId) {
    status('ignored')
    return sendJson(res, 200, { ok: true, ignored: 'no order' })
  }

  // Razorpay usually sends both order.paid and payment.captured for one payment: if this
  // payment is already fully recorded, there is nothing to look up.
  const known = readRegistrations().find((r) => r.paymentId === paymentId)
  if (known && known.name && known.phone && known.amountPaise != null) {
    status('duplicate')
    return sendJson(res, 200, { ok: true, result: 'duplicate' })
  }

  // Who paid: order.paid carries the order (and its notes); payment.captured doesn't,
  // so fall back to the order we remember, then to asking Razorpay for it.
  let notes = body.payload?.order?.entity?.notes || null
  const pending = pendingOrders.get(orderId)
  if (!notes && pending) {
    notes = { purpose: ORDER_PURPOSE, name: pending.name, phone: pending.phone, email: pending.email, seller_type: SELLER_TYPES[pending.sellerType] }
  }
  if (!notes) {
    try {
      const { status: s, json } = await razorpay('GET', `/orders/${encodeURIComponent(orderId)}`)
      if (s === 200) notes = json.notes || {}
    } catch (e) {
      console.error('Webhook: could not read the order from Razorpay:', e.message)
    }
  }
  if (!notes) {
    // Couldn't tell whose order it is right now — let Razorpay retry later.
    status('retry')
    return sendJson(res, 503, { error: 'Order details unavailable, retry later.' })
  }
  if (notes.purpose !== ORDER_PURPOSE) {
    status('not-ours')
    return sendJson(res, 200, { ok: true, ignored: 'not a group meeting order' })
  }

  const paidAt = payment.created_at ? new Date(payment.created_at * 1000).toISOString() : new Date().toISOString()
  const result = saveRegistration({
    paymentId,
    orderId,
    name: notes.name || null,
    phone: notes.phone || null,
    email: notes.email || payment.email || null,
    sellerType: notes.seller_type || null,
    amountPaise: Number.isInteger(payment.amount) ? payment.amount : null,
    paidAt,
    source: 'webhook',
  })
  if (pending && Number.isInteger(payment.amount) && payment.amount !== pending.amount) {
    console.error(`⚠ Webhook amount ${payment.amount} differs from the order amount ${pending.amount} for ${orderId}`)
  }
  pendingOrders.delete(orderId)
  status(result)
  if (result === 'new') console.log(`✔ Paid (webhook): ${notes.name} (${notes.phone}) — ${paymentId}`)
  sendJson(res, 200, { ok: true, result })
}

/* ---------------- admin credentials ---------------- */

function readAdminFile() {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'))
  } catch {
    return null
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

function passwordMatches(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

// The saved login if it has been changed on /admin, otherwise the one in .env.
function adminAccount() {
  const saved = readAdminFile()
  if (saved?.username && saved?.passwordHash) return saved
  return ENV_ADMIN_PASSWORD ? { username: ENV_ADMIN_USERNAME, envPassword: ENV_ADMIN_PASSWORD } : null
}

function checkLogin(username, password) {
  const account = adminAccount()
  if (!account) return false
  const userOk = safeEqual(username, account.username)
  const passOk = account.passwordHash ? passwordMatches(password, account.passwordHash) : safeEqual(password, account.envPassword)
  return userOk && passOk
}

function tooManyAttempts(ip) {
  const a = loginAttempts.get(ip)
  return Boolean(a && a.resetAt > Date.now() && a.count >= 5)
}

function recordFailedAttempt(ip) {
  const now = Date.now()
  const a = loginAttempts.get(ip)
  const fresh = !a || a.resetAt <= now
  loginAttempts.set(ip, { count: fresh ? 1 : a.count + 1, resetAt: fresh ? now + 10 * 60 * 1000 : a.resetAt })
}

async function handleAdminLogin(req, res) {
  if (!adminAccount()) return sendJson(res, 503, { error: 'Admin login is not set up. Add ADMIN_PASSWORD to .env.' })
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })

  const ip = req.socket.remoteAddress
  if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' })

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  if (!checkLogin(String(body.username || ''), String(body.password || ''))) {
    recordFailedAttempt(ip)
    return sendJson(res, 401, { error: 'Wrong username or password.' })
  }

  loginAttempts.delete(ip)
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, Date.now() + SESSION_MS)
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_MS / 1000))
  sendJson(res, 200, { ok: true })
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/* ---------------- email (SMTP) settings ---------------- */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2))
  fs.renameSync(`${file}.tmp`, file)
}

// Key for the saved SMTP password: APP_SECRET from .env, else a key file made once.
let cachedKey = null
function secretKey() {
  if (cachedKey) return cachedKey
  if (process.env.APP_SECRET) {
    cachedKey = crypto.createHash('sha256').update(process.env.APP_SECRET).digest()
  } else {
    if (!fs.existsSync(KEY_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
    }
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex')
  }
  return cachedKey
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

function decryptSecret(enc) {
  const [v, iv, tag, data] = String(enc).split('.')
  if (v !== 'v1') throw new Error('Unknown secret format')
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

// The settings in force: saved on /admin if any, else .env.
function smtpConfig() {
  const saved = readJson(SMTP_FILE)
  if (saved?.host) {
    let pass = ''
    try {
      pass = decryptSecret(saved.passEnc)
    } catch (e) {
      console.error('Saved SMTP password could not be decrypted (APP_SECRET or secret.key changed?):', e.message)
    }
    return { host: saved.host, port: saved.port, user: saved.user, pass, from: saved.from, source: 'admin', updatedAt: saved.updatedAt }
  }
  return { ...ENV_SMTP, source: ENV_SMTP.host ? 'env' : 'none', updatedAt: null }
}

const isComplete = (c) => Boolean(c.host && c.port && c.user && c.pass && c.from)
const mailConfigured = () => isComplete(smtpConfig())

function buildTransport(c) {
  const nodemailer = require('nodemailer')
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
}

// One transport per distinct setting, rebuilt the moment the settings change.
let transport = { key: '', value: null }
function mailer() {
  const c = smtpConfig()
  const key = JSON.stringify([c.host, c.port, c.user, c.pass])
  if (transport.key !== key) transport = { key, value: buildTransport(c) }
  return { transporter: transport.value, from: { name: BUSINESS_NAME, address: c.from } }
}

// Turn nodemailer's errors into something an admin can act on.
function smtpErrorMessage(e, c) {
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) {
    return /gmail/i.test(c.host)
      ? 'Login failed. Gmail needs an App Password here, not your normal Gmail password.'
      : 'Login failed: wrong username or password.'
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ENOTFOUND', 'ESOCKET', 'ECONNREFUSED', 'EDNS'].includes(e.code)) {
    return `Could not connect to ${c.host}:${c.port}. Check the host and port.`
  }
  return e.message || 'Unknown email error.'
}

function smtpPublicView() {
  const c = smtpConfig()
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    from: c.from,
    hasPassword: Boolean(c.pass),
    source: c.source,
    configured: isComplete(c),
    updatedAt: c.updatedAt,
  }
}

function handleAdminGetSmtp(req, res) {
  sendJson(res, 200, smtpPublicView())
}

async function handleAdminSaveSmtp(req, res) {
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const host = String(body.host || '').trim().toLowerCase()
  const port = Number(body.port)
  const user = String(body.user || '').trim()
  const newPass = String(body.pass || '').replace(/\s+/g, '') // Google shows app passwords with spaces
  const from = String(body.from || '').trim() || user

  const current = smtpConfig()
  // Blank password = keep the one already saved (it is never sent to the browser).
  const pass = newPass || (current.user === user ? current.pass : '')

  const fields = {}
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) fields.host = 'Enter a valid host, e.g. smtp.gmail.com'
  if (!Number.isInteger(port) || port < 1 || port > 65535) fields.port = 'Enter a valid port (587 or 465).'
  if (!user || user.length > 200) fields.user = 'Enter the username (usually your email address).'
  if (!pass) fields.pass = 'Enter the password / app password.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(from)) fields.from = 'Enter a valid "from" email address.'
  if (Object.keys(fields).length) return sendJson(res, 422, { error: 'Please fix the highlighted fields.', fields })

  // Check the settings work before saving them — a wrong password should show up now,
  // not later as a login-changed email that silently never arrives.
  const candidate = { host, port, user, pass, from }
  try {
    await buildTransport(candidate).verify()
  } catch (e) {
    return sendJson(res, 422, { error: smtpErrorMessage(e, candidate) })
  }

  writeJson(SMTP_FILE, { host, port, user, passEnc: encryptSecret(pass), from, updatedAt: new Date().toISOString() })
  console.log(`Email settings saved (${user} via ${host}:${port})`)
  sendJson(res, 200, smtpPublicView())
}

function handleAdminDeleteSmtp(req, res) {
  try {
    fs.unlinkSync(SMTP_FILE)
  } catch {}
  console.log('Email settings removed')
  sendJson(res, 200, smtpPublicView())
}

async function handleAdminTestSmtp(req, res) {
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }
  const to = String(body.to || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return sendJson(res, 422, { error: 'Enter a valid mail ID to send the test to.' })
  if (!mailConfigured()) return sendJson(res, 409, { error: 'Save the email settings first.' })

  const { transporter, from } = mailer()
  try {
    await transporter.sendMail({
      from,
      to,
      subject: `Test email from ${BUSINESS_NAME} admin`,
      text: `This is a test email from the ${BUSINESS_NAME} group meeting admin page. Email sending works.`,
      html: `<div style="font-family:Arial,sans-serif;padding:24px"><h2 style="color:#131b2e;margin:0 0 8px">Email is working ✓</h2><p style="color:#45464d">This is a test email from the ${escapeHtml(BUSINESS_NAME)} group meeting admin page.</p></div>`,
    })
    sendJson(res, 200, { ok: true, to })
  } catch (e) {
    sendJson(res, 502, { error: smtpErrorMessage(e, smtpConfig()) })
  }
}

async function sendCredentialsEmail(to, username, password, loginUrl) {
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  const text = [
    `Your ${BUSINESS_NAME} group meeting admin login was changed on ${when}.`,
    '',
    `Username: ${username}`,
    `Password: ${password}`,
    '',
    `Log in: ${loginUrl}`,
    '',
    "If you didn't make this change, log in and change the password right away.",
  ].join('\n')

  const row = (k, v) =>
    `<tr><td style="padding:8px 0;color:#76777d;font:600 12px monospace;text-transform:uppercase;letter-spacing:.08em">${k}</td>` +
    `<td style="padding:8px 0 8px 16px;font:600 16px Arial,sans-serif;color:#1b1b1d">${escapeHtml(v)}</td></tr>`

  const html = `
  <div style="background:#f6f3f5;padding:32px 16px;font-family:Arial,sans-serif">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border-top:4px solid #fd761a">
      <div style="background:#131b2e;color:#fff;padding:18px 24px;font:700 18px Arial,sans-serif">${escapeHtml(BUSINESS_NAME)} · Admin</div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px;font-size:20px;color:#1b1b1d">Your admin login was changed</h2>
        <p style="margin:0 0 16px;color:#45464d;font-size:14px">Changed on ${escapeHtml(when)}. Your new login details:</p>
        <table style="border-collapse:collapse;margin-bottom:20px">${row('Username', username)}${row('Password', password)}</table>
        <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#fd761a;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Log in to admin</a>
        <p style="margin:20px 0 0;color:#76777d;font-size:13px">If you didn't make this change, log in and change the password right away.</p>
      </div>
    </div>
  </div>`

  const { transporter, from } = mailer()
  await transporter.sendMail({
    from,
    to,
    subject: `Your ${BUSINESS_NAME} admin login was changed`,
    text,
    html,
  })
}

async function handleAdminChangeCredentials(req, res, currentToken) {
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })
  const ip = req.socket.remoteAddress
  if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' })

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const currentPassword = String(body.currentPassword || '')
  const newUsername = String(body.newUsername || '').trim()
  const newPassword = String(body.newPassword || '')
  const confirmPassword = String(body.confirmPassword || '')
  const email = String(body.email || '').trim()

  const account = adminAccount()
  if (!account || !checkLogin(account.username, currentPassword)) {
    recordFailedAttempt(ip)
    return sendJson(res, 422, { error: 'Current password is wrong.', fields: { currentPassword: 'Current password is wrong.' } })
  }

  const fields = {}
  if (!/^[A-Za-z0-9._@-]{3,40}$/.test(newUsername)) {
    fields.newUsername = '3–40 characters: letters, numbers and . _ @ - only.'
  }
  if (newPassword.length < 8 || newPassword.length > 128) fields.newPassword = 'Use at least 8 characters.'
  else if (newPassword !== confirmPassword) fields.confirmPassword = "Passwords don't match."
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) fields.email = 'Enter a valid mail ID.'
  if (Object.keys(fields).length) return sendJson(res, 422, { error: 'Please fix the highlighted fields.', fields })

  fs.mkdirSync(DATA_DIR, { recursive: true })
  const record = { username: newUsername, passwordHash: hashPassword(newPassword), notifyEmail: email, updatedAt: new Date().toISOString() }
  fs.writeFileSync(`${ADMIN_FILE}.tmp`, JSON.stringify(record, null, 2))
  fs.renameSync(`${ADMIN_FILE}.tmp`, ADMIN_FILE)

  // The old password is gone, so every other signed-in browser is signed out.
  for (const token of sessions.keys()) if (token !== currentToken) sessions.delete(token)
  loginAttempts.delete(ip)
  console.log(`Admin login changed (username: ${newUsername})`)

  let emailSent = false
  let emailError = null
  if (!mailConfigured()) {
    emailError = 'Email is not set up yet (Email settings on the admin page), so nothing was sent.'
  } else {
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
    const loginUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/admin` : `${proto}://${req.headers.host}/admin`
    try {
      await sendCredentialsEmail(email, newUsername, newPassword, loginUrl)
      emailSent = true
    } catch (e) {
      console.error('Login-changed email failed:', e.message)
      emailError = `The email could not be sent: ${e.message}`
    }
  }

  sendJson(res, 200, { ok: true, username: newUsername, email, emailSent, emailError })
}

function handleAdminLogout(req, res) {
  sessions.delete(getCookie(req, SESSION_COOKIE))
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0))
  sendJson(res, 200, { ok: true })
}

function handleAdminGetSettings(req, res) {
  const s = readSettings()
  sendJson(res, 200, {
    fee: currentFee(),
    updatedAt: s.updatedAt || null,
    paymentsEnabled: paymentsEnabled(),
    mode: rzpMode(rzpConfig().keyId),
    username: adminAccount()?.username ?? null,
    notifyEmail: readAdminFile()?.notifyEmail ?? '',
    loginChangedAt: readAdminFile()?.updatedAt ?? null,
    mailConfigured: mailConfigured(),
  })
}

async function handleAdminSaveSettings(req, res) {
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const fee = Number(body.fee)
  if (!Number.isInteger(fee) || fee < MIN_FEE || fee > MAX_FEE) {
    return sendJson(res, 422, { error: `Enter a whole amount between ₹${MIN_FEE} and ₹${MAX_FEE.toLocaleString('en-IN')}.` })
  }

  const saved = saveSettings({ fee, updatedAt: new Date().toISOString() })
  console.log(`Fee changed to ₹${fee}`)
  sendJson(res, 200, { fee: saved.fee, updatedAt: saved.updatedAt })
}

/* ---------------- date range (IST whole days) ---------------- */

const IST_OFFSET_MS = 330 * 60_000
const istToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)

// 'YYYY-MM-DD' → the UTC instant that IST day starts at; null if not a real date.
function istDayStart(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '')
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
  if (new Date(t).toISOString().slice(0, 10) !== day) return null // e.g. 2026-02-30
  return t - IST_OFFSET_MS
}

// Reads ?from=&to= (both optional, both inclusive). Returns { error } or { from, to, filter }.
function dateRangeFrom(req) {
  const params = new URL(req.url, 'http://x').searchParams
  const from = params.get('from') || ''
  const to = params.get('to') || ''
  const start = from ? istDayStart(from) : -Infinity
  const endDay = to ? istDayStart(to) : null
  if (start === null || (to && endDay === null)) return { error: 'Dates must be real dates (YYYY-MM-DD).' }
  const end = to ? endDay + 86_400_000 : Infinity // exclusive: start of the day after "to"
  if (start >= end) return { error: '"From" date must be on or before the "To" date.' }
  const filter = (r) => {
    // A free booking has its booking time; a paid one, its payment time.
    const t = Date.parse(r.bookedAt || r.paidAt)
    return t >= start && t < end
  }
  return { from, to, filter }
}

function handleAdminRegistrationsXlsx(req, res) {
  const range = dateRangeFrom(req)
  if (range.error) return sendJson(res, 422, { error: range.error })
  const list = readRegistrations().filter(range.filter) // oldest first, so S.No runs in payment order
  const columns = [
    { header: 'S.No', width: 7, type: 'number' },
    { header: 'Booked on (IST)', width: 22, type: 'date' },
    { header: 'Name', width: 24, type: 'text' },
    { header: 'Phone', width: 16, type: 'text' },
    { header: 'Mail ID', width: 30, type: 'text' },
    { header: 'Seller type', width: 16, type: 'text' },
    { header: 'Amount (₹)', width: 13, type: 'money', total: true },
    { header: 'Booking / Payment ID', width: 22, type: 'text' },
    { header: 'Order ID', width: 24, type: 'text' },
  ]
  const rows = list.map((r, i) => [
    i + 1,
    r.bookedAt || r.paidAt,
    r.name,
    r.phone,
    r.email,
    r.sellerType,
    r.amountPaise != null ? r.amountPaise / 100 : null,
    r.paymentId || r.id || null,
    r.orderId || null,
  ])

  const file = buildXlsx(columns, rows, {
    sheetName: 'Registrations',
    tzOffsetMinutes: 330, // IST
    totalLabel: `Total (${list.length})`,
  })

  const today = istToday()
  const label =
    range.from && range.to
      ? range.from === range.to
        ? range.from
        : `${range.from}_to_${range.to}`
      : range.from
        ? `from_${range.from}`
        : range.to
          ? `until_${range.to}`
          : `all_${today}`
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="group-meeting-registrations_${label}.xlsx"`,
    'Content-Length': file.length,
    'Cache-Control': 'no-store',
  })
  res.end(file)
}

function handleAdminRegistrations(req, res) {
  const range = dateRangeFrom(req)
  if (range.error) return sendJson(res, 422, { error: range.error })
  const all = readRegistrations()
  const shown = all.filter(range.filter).reverse() // newest first
  sendJson(res, 200, { registrations: shown, totalCount: all.length })
}

// Orders created here, waiting for payment: orderId → booking details.
// Lets /verify record exactly what was submitted, not what the browser resends.
const pendingOrders = new Map()

/* ---------------- API ---------------- */

// Free bookings per address, so a script cannot fill the list: 10 an hour.
const bookingAttempts = new Map() // ip → { count, resetAt }

function bookingLimited(ip) {
  const now = Date.now()
  const a = bookingAttempts.get(ip)
  const fresh = !a || a.resetAt <= now
  const next = { count: fresh ? 1 : a.count + 1, resetAt: fresh ? now + 60 * 60 * 1000 : a.resetAt }
  bookingAttempts.set(ip, next)
  return next.count > 10
}

// Book Now: the details only — there is no registration fee. The same rules
// as the form, checked again here.
async function handleBook(req, res) {
  if (!isJson(req)) return sendJson(res, 415, { error: 'Expected JSON.' })
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }
  // A field people never see: filled in, it is a bot. Answer as if booked.
  if (body.website) return sendJson(res, 200, { status: 'BOOKED', bookingId: null })

  const { errors, booking } = validateBooking(body)
  if (Object.keys(errors).length) return sendJson(res, 422, { error: 'Please fix the highlighted fields.', fields: errors })
  if (bookingLimited(req.socket.remoteAddress)) {
    return sendJson(res, 429, { error: 'Too many bookings from this connection. Please try again later.' })
  }

  const { entry, existing } = saveFreeBooking(booking)
  if (!existing) console.log(`✔ Booked: ${entry.name} (${entry.phone}) — ${entry.id}`)
  sendJson(res, 200, { status: 'BOOKED', bookingId: entry.id, alreadyBooked: existing })
  // After the answer, so the visitor never waits on Closer. A booking Closer
  // has not taken yet — new, or failed before — is sent.
  if (!entry.closer?.ok) sendToCloser(entry).catch((e) => console.error('✖ Closer hand-off crashed:', e.message))
}

async function handleConfig(req, res) {
  sendJson(res, 200, { fee: currentFee(), currency: 'INR', paymentsEnabled: paymentsEnabled() })
}

async function handleCreateOrder(req, res) {
  const creds = rzpConfig()
  if (!creds.keyId || !creds.keySecret) {
    return sendJson(res, 503, { error: 'Payments are not set up yet. Please try again later.' })
  }

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const { errors, booking } = validateBooking(body)
  if (Object.keys(errors).length) return sendJson(res, 422, { error: 'Please fix the highlighted fields.', fields: errors })

  const amount = currentFee() * 100 // paise
  try {
    const { status, json } = await razorpay('POST', '/orders', {
      amount,
      currency: 'INR',
      receipt: `gm_${Date.now()}`,
      notes: {
        purpose: ORDER_PURPOSE,
        name: plain(booking.name),
        phone: booking.phone,
        email: plain(booking.email),
        seller_type: SELLER_TYPES[booking.sellerType],
      },
    }, creds)

    if (status === 401) {
      console.error('Razorpay rejected the API keys (401). Check them on /admin → Payments.')
      return sendJson(res, 502, { error: 'Payment setup error. Please contact us.' })
    }
    if (status >= 400 || !json.id) {
      console.error('Razorpay order failed:', status, json.error || json)
      return sendJson(res, 502, { error: json.error?.description || 'Could not start the payment. Please try again.' })
    }

    // Remember which secret made this order, so a key change mid-payment can't break its check.
    pendingOrders.set(json.id, { ...booking, amount, keySecret: creds.keySecret, createdAt: Date.now() })
    sendJson(res, 200, {
      keyId: creds.keyId,
      orderId: json.id,
      amount,
      currency: 'INR',
      businessName: BUSINESS_NAME,
      description: 'Group meeting registration',
      prefill: { name: booking.name, email: booking.email, contact: booking.phone },
    })
  } catch (e) {
    console.error('Razorpay order error:', e.message)
    sendJson(res, 502, { error: 'Could not reach the payment gateway. Please try again.' })
  }
}

async function handleVerify(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { error: e.message })
  }

  const orderId = String(body.razorpay_order_id || '')
  const paymentId = String(body.razorpay_payment_id || '')
  const signature = String(body.razorpay_signature || '')
  if (!orderId || !paymentId || !signature) return sendJson(res, 400, { error: 'Missing payment details.' })

  const secret = pendingOrders.get(orderId)?.keySecret || rzpConfig().keySecret
  if (!secret) return sendJson(res, 200, { status: 'PENDING' })
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex')
  const valid =
    expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))

  if (!valid) {
    // Don't say which check failed — that's free information to a forger.
    return sendJson(res, 200, { status: 'PENDING' })
  }

  // Normally in memory; after a server restart, read it back from the order's notes.
  let booking = pendingOrders.get(orderId)
  if (!booking) {
    try {
      const { status, json } = await razorpay('GET', `/orders/${encodeURIComponent(orderId)}`)
      if (status === 200 && json.notes) {
        const sellerType = Object.keys(SELLER_TYPES).find((k) => SELLER_TYPES[k] === json.notes.seller_type)
        booking = { name: json.notes.name, phone: json.notes.phone, email: json.notes.email, sellerType, amount: json.amount }
      }
    } catch (e) {
      console.error('Could not read order back from Razorpay:', e.message)
    }
  }

  const entry = {
    paymentId,
    orderId,
    name: booking?.name ?? null,
    phone: booking?.phone ?? null,
    email: booking?.email ?? null,
    sellerType: booking ? SELLER_TYPES[booking.sellerType] : null,
    amountPaise: booking?.amount ?? null,
    paidAt: new Date().toISOString(),
    source: 'checkout',
  }
  saveRegistration(entry)
  pendingOrders.delete(orderId)
  console.log(`✔ Paid: ${entry.name} (${entry.phone}) — ${paymentId}`)

  sendJson(res, 200, { status: 'PAID', paymentId, orderId })
}

/* ---------------- server ---------------- */

http
  .createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0])

    try {
      if (urlPath === '/api/config' && req.method === 'GET') return await handleConfig(req, res)
      if (urlPath === '/api/book' && req.method === 'POST') return await handleBook(req, res)
      if (urlPath === '/api/create-order' && req.method === 'POST') return await handleCreateOrder(req, res)
      if (urlPath === '/api/verify-payment' && req.method === 'POST') return await handleVerify(req, res)
      if (urlPath === '/api/webhooks/razorpay' && req.method === 'POST') return await handleRazorpayWebhook(req, res)

      if (urlPath === '/api/admin/login' && req.method === 'POST') return await handleAdminLogin(req, res)
      if (urlPath === '/api/admin/logout' && req.method === 'POST') return handleAdminLogout(req, res)
      if (urlPath.startsWith('/api/admin/')) {
        if (!isAdmin(req)) return sendJson(res, 401, { error: 'Please log in.' })
        if (urlPath === '/api/admin/settings' && req.method === 'GET') return handleAdminGetSettings(req, res)
        if (urlPath === '/api/admin/settings' && req.method === 'PUT') return await handleAdminSaveSettings(req, res)
        if (urlPath === '/api/admin/registrations' && req.method === 'GET') return handleAdminRegistrations(req, res)
        if (urlPath === '/api/admin/registrations.xlsx' && req.method === 'GET') return handleAdminRegistrationsXlsx(req, res)
        if (urlPath === '/api/admin/razorpay' && req.method === 'GET') return handleAdminGetRazorpay(req, res)
        if (urlPath === '/api/admin/razorpay' && req.method === 'PUT') return await handleAdminSaveRazorpay(req, res)
        if (urlPath === '/api/admin/razorpay' && req.method === 'DELETE') return handleAdminDeleteRazorpay(req, res)
        if (urlPath === '/api/admin/webhook' && req.method === 'GET') return handleAdminGetWebhook(req, res)
        if (urlPath === '/api/admin/webhook' && req.method === 'PUT') return await handleAdminSaveWebhook(req, res)
        if (urlPath === '/api/admin/webhook' && req.method === 'DELETE') return handleAdminDeleteWebhook(req, res)
        if (urlPath === '/api/admin/smtp' && req.method === 'GET') return handleAdminGetSmtp(req, res)
        if (urlPath === '/api/admin/smtp' && req.method === 'PUT') return await handleAdminSaveSmtp(req, res)
        if (urlPath === '/api/admin/smtp' && req.method === 'DELETE') return handleAdminDeleteSmtp(req, res)
        if (urlPath === '/api/admin/smtp/test' && req.method === 'POST') return await handleAdminTestSmtp(req, res)
        if (urlPath === '/api/admin/credentials' && req.method === 'POST')
          return await handleAdminChangeCredentials(req, res, getCookie(req, SESSION_COOKIE))
      }

      if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' })
    } catch (e) {
      console.error(e)
      return sendJson(res, 500, { error: 'Something went wrong.' })
    }

    // Static files: only the page itself and assets/ — never .env, data/ or server.js.
    const rel = urlPath === '/' ? 'index.html' : urlPath === '/admin' ? 'admin.html' : urlPath.replace(/^\/+/, '')
    const file = path.resolve(ROOT, rel)
    const allowed = PUBLIC_FILES.has(rel) || (rel.startsWith('assets/') && file.startsWith(path.join(ROOT, 'assets') + path.sep))
    if (!allowed) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      res.end(data)
    })
  })
  .listen(PORT, () => {
    console.log(`Closer landing page → http://localhost:${PORT}  ·  admin → http://localhost:${PORT}/admin`)
    if (!adminAccount()) console.warn('⚠ ADMIN_PASSWORD not set in .env — admin login is disabled.')
    if (!mailConfigured()) console.warn('⚠ Email (SMTP) not set up — add it on /admin → Email settings.')
    if (!paymentsEnabled()) console.warn('⚠ Razorpay keys not set — Pay Now is disabled. Add them on /admin → Payments.')
    else console.log(`Razorpay: ${rzpMode(rzpConfig().keyId)} mode · fee ₹${currentFee()}`)
  })
