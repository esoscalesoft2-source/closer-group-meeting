// Group meeting admin: log in, set the registration fee, see paid registrations.

const $ = (id) => document.getElementById(id)
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}/-`
const dateTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

function show(view) {
  $('loginView').hidden = view !== 'login'
  $('dashView').hidden = view !== 'dash'
  $('logoutBtn').hidden = view !== 'dash'
}

function alertMsg(el, message) {
  el.textContent = message || ''
  el.hidden = !message
}

/* ---------------- login ---------------- */

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  alertMsg($('loginAlert'), '')
  const username = $('username').value.trim()
  const password = $('password').value
  if (!username || !password) return alertMsg($('loginAlert'), 'Enter your username and password.')

  $('loginBtn').disabled = true
  const { ok, data } = await api('POST', '/api/admin/login', { username, password }).catch(() => ({ data: {} }))
  $('loginBtn').disabled = false
  if (!ok) return alertMsg($('loginAlert'), data.error || 'Could not log in. Please try again.')

  $('password').value = ''
  hideAllPasswords()
  loadDashboard()
})

$('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout').catch(() => {})
  hideAllPasswords()
  show('login')
})

/* ---------------- fee ---------------- */

const feeInput = $('fee')

feeInput.addEventListener('input', () => {
  feeInput.value = feeInput.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 7)
  $('feePreview').textContent = feeInput.value ? rupees(feeInput.value) : '—'
  $('feeError').textContent = ''
  feeInput.closest('.field').classList.remove('has-error')
  $('saveOk').hidden = true
})

function renderSettings(s) {
  feeInput.value = s.fee
  $('feePreview').textContent = rupees(s.fee)
  $('feeSummary').textContent = rupees(s.fee)
  $('updatedAt').textContent = s.updatedAt ? `Last changed ${dateTime(s.updatedAt)}` : 'Using the default fee from .env'

  const chip = $('rzpChip')
  if (!s.paymentsEnabled) {
    chip.className = 'chip chip--off'
    chip.textContent = 'Not connected'
  } else {
    chip.className = `chip chip--${s.mode === 'LIVE' ? 'live' : 'test'}`
    chip.textContent = s.mode === 'LIVE' ? 'Live mode' : 'Test mode'
  }
}

$('feeForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fee = Number(feeInput.value)
  if (!fee) {
    $('feeError').textContent = 'Enter an amount.'
    feeInput.closest('.field').classList.add('has-error')
    return
  }

  $('saveBtn').disabled = true
  const { ok, status, data } = await api('PUT', '/api/admin/settings', { fee }).catch(() => ({ data: {} }))
  $('saveBtn').disabled = false

  if (status === 401) return show('login')
  if (!ok) {
    $('feeError').textContent = data.error || 'Could not save. Please try again.'
    feeInput.closest('.field').classList.add('has-error')
    return
  }

  $('feePreview').textContent = rupees(data.fee)
  $('feeSummary').textContent = rupees(data.fee)
  $('updatedAt').textContent = `Last changed ${dateTime(data.updatedAt)}`
  $('saveOk').textContent = `Saved. The landing page now shows ${rupees(data.fee)}.`
  $('saveOk').hidden = false
})

/* ---------------- change login ---------------- */

const credForm = $('credForm')
const credFields = ['currentPassword', 'newUsername', 'newPassword', 'confirmPassword', 'email']

function credError(field, message) {
  const input = credForm.elements[field]
  const wrap = input.closest('.field')
  wrap.classList.toggle('has-error', Boolean(message))
  wrap.querySelector('.field__error').textContent = message || ''
}

function renderLogin(s) {
  $('currentUser').textContent = s.username || '—'
  $('loginSummary').textContent = s.username || '—'
  if (!credForm.elements.email.value) credForm.elements.email.value = s.notifyEmail || ''
  $('mailStatus').textContent = s.mailConfigured
    ? s.loginChangedAt
      ? `Login last changed ${dateTime(s.loginChangedAt)}`
      : ''
    : '⚠ Email is not set up yet (see Email settings above). The login will change, but no email will be sent.'
}

/* ---------------- show / hide password (eye button) ---------------- */

const EYE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
const EYE_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.5 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.6 18.6 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M2 2l20 20"/></svg>'

function setVisible(input, button, visible) {
  input.type = visible ? 'text' : 'password'
  button.innerHTML = visible ? EYE_OFF : EYE
  button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password')
  button.setAttribute('aria-pressed', String(visible))
}

// Every password box on the page gets its own eye button.
const eyeToggles = [...document.querySelectorAll('input[type="password"]')].map((input) => {
  const wrap = document.createElement('div')
  wrap.className = 'pw'
  input.replaceWith(wrap)
  wrap.append(input)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'pw__eye'
  wrap.append(button)
  setVisible(input, button, false)

  button.addEventListener('click', () => {
    setVisible(input, button, input.type === 'password')
    input.focus()
  })
  return { input, button }
})

const hideAllPasswords = () => eyeToggles.forEach(({ input, button }) => setVisible(input, button, false))

credFields.forEach((f) => credForm.elements[f].addEventListener('input', () => credError(f, '')))

credForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  alertMsg($('credAlert'), '')
  $('credOk').hidden = true
  $('credWarn').hidden = true

  const v = Object.fromEntries(credFields.map((f) => [f, credForm.elements[f].value]))
  v.newUsername = v.newUsername.trim()
  v.email = v.email.trim()

  // Quick checks here; the server checks everything again.
  const errors = {}
  if (!v.currentPassword) errors.currentPassword = 'Enter your current password.'
  if (!/^[A-Za-z0-9._@-]{3,40}$/.test(v.newUsername)) errors.newUsername = '3–40 characters: letters, numbers and . _ @ - only.'
  if (v.newPassword.length < 8) errors.newPassword = 'Use at least 8 characters.'
  else if (v.newPassword !== v.confirmPassword) errors.confirmPassword = "Passwords don't match."
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = 'Enter a valid mail ID.'
  credFields.forEach((f) => credError(f, errors[f]))
  if (Object.keys(errors).length) return

  $('credBtn').disabled = true
  $('credBtn').textContent = 'Saving…'
  const { ok, status, data } = await api('POST', '/api/admin/credentials', v).catch(() => ({ data: {} }))
  $('credBtn').disabled = false
  $('credBtn').textContent = 'Change & send email'

  if (status === 401) return show('login')
  if (!ok) {
    Object.entries(data.fields || {}).forEach(([f, msg]) => credError(f, msg))
    return alertMsg($('credAlert'), data.error || 'Could not change the login. Please try again.')
  }

  ;['currentPassword', 'newPassword', 'confirmPassword'].forEach((f) => (credForm.elements[f].value = ''))
  credForm.elements.newUsername.value = ''
  hideAllPasswords()
  $('currentUser').textContent = data.username
  $('loginSummary').textContent = data.username
  $('mailStatus').textContent = `Login last changed ${dateTime(new Date().toISOString())}`

  if (data.emailSent) {
    $('credOk').textContent = `Login changed. The new username and password were sent to ${data.email}.`
    $('credOk').hidden = false
  } else {
    $('credWarn').textContent = `Login changed, but no email went out. ${data.emailError || ''} Note your new password somewhere safe.`
    $('credWarn').hidden = false
  }
})

/* ---------------- Razorpay keys ---------------- */

const rzpForm = $('rzpForm')
const rzpFields = ['keyId', 'keySecret']
let rzpState = {}

function rzpError(field, message) {
  const wrap = rzpForm.elements[field].closest('.field')
  wrap.classList.toggle('has-error', Boolean(message))
  wrap.querySelector('.field__error').textContent = message || ''
}

function paintRzpChip(chip, s) {
  if (!s.configured) {
    chip.className = 'chip chip--off'
    chip.textContent = 'Not connected'
  } else {
    chip.className = `chip chip--${s.mode === 'LIVE' ? 'live' : 'test'}`
    chip.textContent = `${s.mode === 'LIVE' ? 'Live' : 'Test'} mode${s.source === 'env' ? ' · .env' : ''}`
  }
}

function renderRazorpay(s) {
  rzpState = s
  rzpForm.elements.keyId.value = s.keyId || ''
  rzpForm.elements.keySecret.value = ''
  rzpForm.elements.keySecret.placeholder = s.hasSecret ? 'Saved ✓ (blank = keep)' : 'Key Secret'
  $('rzpRemoveBtn').hidden = s.source !== 'admin'
  $('rzpLiveNote').hidden = !String(s.keyId).startsWith('rzp_live_')
  paintRzpChip($('rzpChip2'), s)
  paintRzpChip($('rzpChip'), s) // the status line on the fee panel too
}

rzpForm.elements.keyId.addEventListener('input', (e) => {
  $('rzpLiveNote').hidden = !e.target.value.trim().startsWith('rzp_live_')
})
rzpFields.forEach((f) => rzpForm.elements[f].addEventListener('input', () => rzpError(f, '')))

rzpForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  alertMsg($('rzpAlert'), '')
  $('rzpOk').hidden = true

  const keyId = rzpForm.elements.keyId.value.trim()
  const keySecret = rzpForm.elements.keySecret.value.trim()
  const errors = {}
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) errors.keyId = 'Key ID starts with rzp_test_ or rzp_live_.'
  if (!keySecret && !(rzpState.hasSecret && rzpState.keyId === keyId)) errors.keySecret = 'Enter the Key Secret.'
  rzpFields.forEach((f) => rzpError(f, errors[f]))
  if (Object.keys(errors).length) return

  $('rzpSaveBtn').disabled = true
  $('rzpSaveBtn').textContent = 'Checking…'
  const { ok, status, data } = await api('PUT', '/api/admin/razorpay', { keyId, keySecret }).catch(() => ({ data: {} }))
  $('rzpSaveBtn').disabled = false
  $('rzpSaveBtn').textContent = 'Save & check'

  if (status === 401) return show('login')
  if (!ok) {
    Object.entries(data.fields || {}).forEach(([f, msg]) => rzpError(f, msg))
    return alertMsg($('rzpAlert'), data.error || 'Could not save. Please try again.')
  }

  hideAllPasswords()
  renderRazorpay(data)
  $('rzpOk').textContent = `Connected in ${data.mode === 'LIVE' ? 'LIVE' : 'TEST'} mode. Pay Now on the landing page uses these keys now.`
  $('rzpOk').hidden = false
})

$('rzpRemoveBtn').addEventListener('click', async () => {
  if (!confirm('Remove the saved Razorpay keys? Pay Now will stop working unless .env has keys.')) return
  const { ok, status, data } = await api('DELETE', '/api/admin/razorpay').catch(() => ({ data: {} }))
  if (status === 401) return show('login')
  if (ok) {
    renderRazorpay(data)
    $('rzpOk').textContent = 'Razorpay keys removed.'
    $('rzpOk').hidden = false
  }
})

/* ---------------- Razorpay webhook ---------------- */

const whForm = $('whForm')
const whSecret = whForm.elements.secret

function renderWebhook(w) {
  $('whUrl').value = w.url
  $('whLocalNote').hidden = !w.urlIsLocal
  whSecret.value = ''
  whSecret.placeholder = w.hasSecret ? 'Saved ✓ (type a new one to replace)' : 'Same secret you type in Razorpay'
  $('whRemoveBtn').hidden = w.source !== 'admin'

  const chip = $('whChip')
  if (!w.hasSecret) {
    chip.className = 'chip chip--off'
    chip.textContent = 'Not set up'
  } else if (w.lastResult === 'bad-signature') {
    chip.className = 'chip chip--off'
    chip.textContent = 'Secret mismatch'
  } else if (w.lastEventAt) {
    chip.className = 'chip chip--live'
    chip.textContent = 'Receiving'
  } else {
    chip.className = 'chip chip--test'
    chip.textContent = 'Waiting'
  }

  const RESULT = {
    new: 'payment recorded',
    updated: 'payment details filled in',
    duplicate: 'already recorded',
    ignored: 'not a payment event',
    'not-ours': 'payment from another app, skipped',
    retry: 'order details unavailable, Razorpay will retry',
    'bad-signature': "signature didn't match — check the secret is the same in Razorpay and here",
  }
  $('whLast').textContent = w.lastEventAt
    ? `Last webhook: ${dateTime(w.lastEventAt)}${w.lastEvent ? ` · ${w.lastEvent}` : ''} · ${RESULT[w.lastResult] || w.lastResult || ''}`
    : w.hasSecret
      ? 'No webhook received yet.'
      : ''
}

$('whCopyUrl').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('whUrl').value)
    $('whCopyUrl').textContent = 'Copied ✓'
  } catch {
    $('whUrl').select()
    $('whCopyUrl').textContent = 'Press Ctrl+C'
  }
  setTimeout(() => ($('whCopyUrl').textContent = 'Copy'), 1800)
})

// A strong random secret, shown so it can be copied into Razorpay before saving.
$('whGenerate').addEventListener('click', () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  whSecret.value = [...bytes].map((b) => chars[b % chars.length]).join('')
  const toggle = eyeToggles.find((t) => t.input === whSecret)
  if (toggle) setVisible(whSecret, toggle.button, true)
  whSecret.select()
  alertMsg($('whAlert'), '')
  $('whOk').textContent = 'Copy this secret into Razorpay too, then press Save secret.'
  $('whOk').hidden = false
})

whSecret.addEventListener('input', () => {
  whForm.querySelector('[data-for="secret"]').textContent = ''
  whSecret.closest('.field').classList.remove('has-error')
})

whForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  alertMsg($('whAlert'), '')
  $('whOk').hidden = true
  const secret = whSecret.value.trim()
  const fieldErr = (msg) => {
    whForm.querySelector('[data-for="secret"]').textContent = msg
    whSecret.closest('.field').classList.add('has-error')
  }
  if (secret.length < 12 || /\s/.test(secret)) return fieldErr('Use at least 12 characters with no spaces (or press Generate).')

  $('whSaveBtn').disabled = true
  const { ok, status, data } = await api('PUT', '/api/admin/webhook', { secret }).catch(() => ({ data: {} }))
  $('whSaveBtn').disabled = false
  if (status === 401) return show('login')
  if (!ok) return data.fields?.secret ? fieldErr(data.fields.secret) : alertMsg($('whAlert'), data.error || 'Could not save.')

  hideAllPasswords()
  renderWebhook(data)
  $('whOk').textContent = 'Webhook secret saved. Make sure Razorpay has the same secret.'
  $('whOk').hidden = false
})

$('whRemoveBtn').addEventListener('click', async () => {
  if (!confirm('Remove the webhook secret? Webhooks from Razorpay will be refused until a secret is set again.')) return
  const { ok, status, data } = await api('DELETE', '/api/admin/webhook').catch(() => ({ data: {} }))
  if (status === 401) return show('login')
  if (ok) renderWebhook(data)
})

/* ---------------- email (SMTP) settings ---------------- */

const PROVIDERS = {
  gmail: {
    host: 'smtp.gmail.com',
    port: 587,
    passLabel: 'App password',
    hint: 'Gmail needs an App Password, not your normal password: Google Account → Security → 2-Step Verification → App passwords. <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">Open App passwords ↗</a>',
  },
  outlook: {
    host: 'smtp.office365.com',
    port: 587,
    passLabel: 'Password',
    hint: 'Your Microsoft account password (or an app password if 2-step verification is on).',
  },
  zoho: {
    host: 'smtp.zoho.in',
    port: 587,
    passLabel: 'App password',
    hint: 'Zoho Mail: Settings → Security → App Passwords → generate one for this page.',
  },
  custom: { passLabel: 'Password', hint: "Use the SMTP host, port and login from your email provider." },
}

const smtpForm = $('smtpForm')
const smtpFields = ['host', 'port', 'user', 'pass', 'from']
let lastSettings = {}
let smtpState = {}

function detectProvider(host) {
  return Object.keys(PROVIDERS).find((k) => PROVIDERS[k].host === host) || (host ? 'custom' : 'gmail')
}

function applyProviderText(key) {
  const p = PROVIDERS[key]
  $('smtpPassLabel').textContent = p.passLabel
  $('smtpHint').innerHTML = p.hint // fixed text from PROVIDERS above, never user input
}

function smtpError(field, message) {
  const wrap = smtpForm.elements[field].closest('.field')
  wrap.classList.toggle('has-error', Boolean(message))
  wrap.querySelector('.field__error').textContent = message || ''
}

function renderSmtp(s) {
  smtpState = s
  const provider = detectProvider(s.host)
  $('smtpProvider').value = provider
  applyProviderText(provider)

  smtpForm.elements.host.value = s.host || PROVIDERS.gmail.host
  smtpForm.elements.port.value = s.port || 587
  smtpForm.elements.user.value = s.user || ''
  smtpForm.elements.pass.value = ''
  smtpForm.elements.pass.placeholder = s.hasPassword ? 'Saved ✓ (blank = keep)' : '16-letter app password'
  smtpForm.elements.from.value = s.from && s.from !== s.user ? s.from : ''

  const chip = $('smtpChip')
  if (s.configured && s.source === 'admin') {
    chip.className = 'chip chip--live'
    chip.textContent = 'Connected'
  } else if (s.configured) {
    chip.className = 'chip chip--test'
    chip.textContent = 'From .env'
  } else {
    chip.className = 'chip chip--off'
    chip.textContent = 'Not set up'
  }

  $('smtpRemoveBtn').hidden = s.source !== 'admin'
  $('smtpTestBox').hidden = !s.configured
  if (!$('smtpTestTo').value) $('smtpTestTo').value = lastSettings.notifyEmail || s.user || ''

  // The Change-login panel says whether its email will go out.
  renderLogin({ ...lastSettings, mailConfigured: s.configured })
}

$('smtpProvider').addEventListener('change', (e) => {
  const p = PROVIDERS[e.target.value]
  applyProviderText(e.target.value)
  if (p.host) {
    smtpForm.elements.host.value = p.host
    smtpForm.elements.port.value = p.port
  } else {
    smtpForm.elements.host.focus()
  }
})

smtpForm.elements.port.addEventListener('input', (e) => (e.target.value = e.target.value.replace(/\D/g, '')))
smtpFields.forEach((f) => smtpForm.elements[f].addEventListener('input', () => smtpError(f, '')))

smtpForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  alertMsg($('smtpAlert'), '')
  $('smtpOk').hidden = true

  const v = Object.fromEntries(smtpFields.map((f) => [f, smtpForm.elements[f].value.trim()]))
  const errors = {}
  if (!v.host) errors.host = 'Enter the SMTP host.'
  if (!v.port) errors.port = 'Enter the port.'
  if (!v.user) errors.user = 'Enter the email / username.'
  if (!v.pass && !(smtpState.hasPassword && smtpState.user === v.user)) errors.pass = 'Enter the password.'
  smtpFields.forEach((f) => smtpError(f, errors[f]))
  if (Object.keys(errors).length) return

  $('smtpSaveBtn').disabled = true
  $('smtpSaveBtn').textContent = 'Checking…'
  const { ok, status, data } = await api('PUT', '/api/admin/smtp', { ...v, port: Number(v.port) }).catch(() => ({ data: {} }))
  $('smtpSaveBtn').disabled = false
  $('smtpSaveBtn').textContent = 'Save & check'

  if (status === 401) return show('login')
  if (!ok) {
    Object.entries(data.fields || {}).forEach(([f, msg]) => smtpError(f, msg))
    return alertMsg($('smtpAlert'), data.error || 'Could not save. Please try again.')
  }

  hideAllPasswords()
  renderSmtp(data)
  $('smtpOk').textContent = 'Connected and saved. Send a test email below to be sure.'
  $('smtpOk').hidden = false
})

$('smtpRemoveBtn').addEventListener('click', async () => {
  if (!confirm('Remove the saved email settings? Login-changed emails will stop unless .env has SMTP settings.')) return
  const { ok, status, data } = await api('DELETE', '/api/admin/smtp').catch(() => ({ data: {} }))
  if (status === 401) return show('login')
  if (ok) {
    renderSmtp(data)
    $('smtpOk').textContent = 'Email settings removed.'
    $('smtpOk').hidden = false
  }
})

$('smtpTestBtn').addEventListener('click', async () => {
  alertMsg($('smtpTestAlert'), '')
  $('smtpTestOk').hidden = true
  const to = $('smtpTestTo').value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return alertMsg($('smtpTestAlert'), 'Enter a valid mail ID.')

  $('smtpTestBtn').disabled = true
  $('smtpTestBtn').textContent = 'Sending…'
  const { ok, status, data } = await api('POST', '/api/admin/smtp/test', { to }).catch(() => ({ data: {} }))
  $('smtpTestBtn').disabled = false
  $('smtpTestBtn').textContent = 'Send test'

  if (status === 401) return show('login')
  if (!ok) return alertMsg($('smtpTestAlert'), data.error || 'Could not send the test email.')
  $('smtpTestOk').textContent = `Test email sent to ${data.to}. Check the inbox (and spam folder).`
  $('smtpTestOk').hidden = false
})

/* ---------------- registrations ---------------- */

function cell(text, className) {
  const td = document.createElement('td')
  td.textContent = text ?? '—'
  if (className) td.className = className
  return td
}

function renderRegistrations(list) {
  const body = $('regBody')
  if (!list.length) {
    const tr = document.createElement('tr')
    const td = cell(rangeText() ? 'No paid registrations in this date range.' : 'No paid registrations yet.', 'empty')
    td.colSpan = 7
    tr.append(td)
    body.replaceChildren(tr)
  } else {
    body.replaceChildren(
      ...list.map((r) => {
        const tr = document.createElement('tr')
        tr.append(
          cell(dateTime(r.paidAt)),
          cell(r.name),
          cell(r.phone),
          cell(r.email),
          cell(r.sellerType),
          cell(r.amountPaise != null ? rupees(r.amountPaise / 100) : null),
          cell(r.paymentId, 'mono'),
        )
        return tr
      }),
    )
  }

  const total = list.reduce((sum, r) => sum + (r.amountPaise || 0), 0) / 100
  $('statCount').textContent = list.length
  $('excelBtn').disabled = !list.length
  $('excelBtn').title = list.length ? '' : 'Nothing to download for this date range'
  $('rangeNote').textContent = rangeText()
    ? `Showing ${list.length} of ${lastTotalCount} registrations · ${rangeText()} · Download Excel gets just these.`
    : ''
  $('statTotal').textContent = rupees(total)
}

/* ---------------- date filter (IST days, both ends inclusive) ---------------- */

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const prettyDay = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })

const PRESETS = {
  all: () => ['', ''],
  today: () => [istToday(), istToday()],
  yesterday: () => [addDays(istToday(), -1), addDays(istToday(), -1)],
  '7d': () => [addDays(istToday(), -6), istToday()],
  '30d': () => [addDays(istToday(), -29), istToday()],
  month: () => [istToday().slice(0, 8) + '01', istToday()],
  lastmonth: () => {
    const firstThis = istToday().slice(0, 8) + '01'
    const lastPrev = addDays(firstThis, -1)
    return [lastPrev.slice(0, 8) + '01', lastPrev]
  },
}

const fromInput = $('fromDate')
const toInput = $('toDate')

function rangeQuery() {
  const p = new URLSearchParams()
  if (fromInput.value) p.set('from', fromInput.value)
  if (toInput.value) p.set('to', toInput.value)
  const q = p.toString()
  return q ? `?${q}` : ''
}

function rangeText() {
  const f = fromInput.value
  const t = toInput.value
  if (f && t) return f === t ? prettyDay(f) : `${prettyDay(f)} – ${prettyDay(t)}`
  if (f) return `from ${prettyDay(f)}`
  if (t) return `until ${prettyDay(t)}`
  return ''
}

function rangeIsValid() {
  const bad = fromInput.value && toInput.value && fromInput.value > toInput.value
  alertMsg($('rangeAlert'), bad ? '"From" date must be on or before the "To" date.' : '')
  return !bad
}

function onRangeChanged() {
  $('clearRange').hidden = !fromInput.value && !toInput.value
  if (rangeIsValid()) loadRegistrations()
}

$('rangePick').addEventListener('change', (e) => {
  if (e.target.value === 'custom') return fromInput.focus()
  const [f, t] = PRESETS[e.target.value]()
  fromInput.value = f
  toInput.value = t
  onRangeChanged()
})

;[fromInput, toInput].forEach((input) =>
  input.addEventListener('change', () => {
    $('rangePick').value = fromInput.value || toInput.value ? 'custom' : 'all'
    onRangeChanged()
  }),
)

$('clearRange').addEventListener('click', () => {
  $('rangePick').value = 'all'
  fromInput.value = ''
  toInput.value = ''
  onRangeChanged()
})

fromInput.max = toInput.max = istToday()

let lastTotalCount = 0

async function loadRegistrations() {
  const { ok, status, data } = await api('GET', `/api/admin/registrations${rangeQuery()}`)
  if (status === 401) return show('login')
  if (!ok) return alertMsg($('rangeAlert'), data.error || 'Could not load registrations.')
  lastTotalCount = data.totalCount ?? data.registrations.length
  renderRegistrations(data.registrations)
}

$('refreshBtn').addEventListener('click', loadRegistrations)

// Fetched rather than linked, so an expired login lands on the login card, not a JSON page.
$('excelBtn').addEventListener('click', async () => {
  alertMsg($('excelAlert'), '')
  const btn = $('excelBtn')
  btn.disabled = true
  try {
    const res = await fetch(`/api/admin/registrations.xlsx${rangeQuery()}`)
    if (res.status === 401) return show('login')
    if (!res.ok) throw new Error()
    const blob = await res.blob()
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'registrations.xlsx'
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: name })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    alertMsg($('excelAlert'), 'Could not download the Excel file. Please try again.')
  } finally {
    btn.disabled = false
  }
})

/* ---------------- accordion (left column) ---------------- */

const ACC_KEY = 'gm_admin_open_card'
const accCards = [...document.querySelectorAll('.acc')]

function setOpen(card, open) {
  card.classList.toggle('is-open', open)
  card.querySelector('.acc__head').setAttribute('aria-expanded', String(open))
  card.querySelector('.acc__body').hidden = !open
}

// One card open at a time; clicking the open one closes it.
function openCard(key) {
  accCards.forEach((card) => setOpen(card, card.dataset.acc === key))
  try {
    localStorage.setItem(ACC_KEY, key || '')
  } catch {}
}

accCards.forEach((card) =>
  card.querySelector('.acc__head').addEventListener('click', () => {
    openCard(card.classList.contains('is-open') ? '' : card.dataset.acc)
  }),
)

let savedCard = null
try {
  savedCard = localStorage.getItem(ACC_KEY)
} catch {}
openCard(savedCard !== null && (savedCard === '' || accCards.some((c) => c.dataset.acc === savedCard)) ? savedCard : 'fee')

/* ---------------- boot ---------------- */

async function loadDashboard() {
  const { ok, data } = await api('GET', '/api/admin/settings').catch(() => ({}))
  if (!ok) return show('login')
  lastSettings = data
  renderSettings(data)
  renderLogin(data)
  show('dash')
  loadRegistrations()
  const [rzp, smtp, wh] = await Promise.all([
    api('GET', '/api/admin/razorpay').catch(() => ({})),
    api('GET', '/api/admin/smtp').catch(() => ({})),
    api('GET', '/api/admin/webhook').catch(() => ({})),
  ])
  if (rzp.ok) renderRazorpay(rzp.data)
  if (wh.ok) renderWebhook(wh.data)
  if (smtp.ok) renderSmtp(smtp.data)
}

loadDashboard()
