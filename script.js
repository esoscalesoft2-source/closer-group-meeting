// ESO Wolf — group meeting landing page

const SELLER_LABELS = { existing: 'Existing seller', new: 'New seller' }

document.getElementById('year').textContent = new Date().getFullYear()

/* ---------------- Mobile nav ---------------- */
const navToggle = document.getElementById('navToggle')
const navLinks = document.getElementById('navLinks')

navToggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('is-open')
  navToggle.setAttribute('aria-expanded', String(open))
})
navLinks.querySelectorAll('a').forEach((a) =>
  a.addEventListener('click', () => {
    navLinks.classList.remove('is-open')
    navToggle.setAttribute('aria-expanded', 'false')
  }),
)

// "Book Now" anywhere → scroll to the form and put the cursor in Name.
document.querySelectorAll('a[href="#book"]').forEach((a) =>
  a.addEventListener('click', () => setTimeout(() => document.getElementById('name').focus({ preventScroll: true }), 450)),
)

/* ---------------- Active link on scroll ---------------- */
const sections = ['home', 'about', 'how', 'services', 'faq'].map((id) => document.getElementById(id)).filter(Boolean)
const navAnchors = [...navLinks.querySelectorAll('a:not(.btn)')]

const spy = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      navAnchors.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === `#${entry.target.id}`))
    })
  },
  { rootMargin: '-45% 0px -50% 0px' },
)
sections.forEach((s) => spy.observe(s))

/* ---------------- Form validation ---------------- */
const form = document.getElementById('bookingForm')
const bookBtn = document.getElementById('payBtn')

const phoneInput = form.phone
phoneInput.addEventListener('input', () => {
  phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 10)
})

const rules = {
  name: (v) => (v.trim().length < 2 ? 'Please enter your name.' : ''),
  phone: (v) => (/^[6-9]\d{9}$/.test(v) ? '' : 'Enter a valid 10-digit mobile number.'),
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Enter a valid mail ID.'),
  sellerType: (v) => (v ? '' : 'Please choose existing or new seller.'),
}

function showError(field, message) {
  const wrap = form[field].closest('.field')
  wrap.classList.toggle('has-error', Boolean(message))
  wrap.querySelector('.field__error').textContent = message
}

function validate() {
  let firstInvalid = null
  for (const [field, check] of Object.entries(rules)) {
    const message = check(form[field].value)
    showError(field, message)
    if (message && !firstInvalid) firstInvalid = form[field]
  }
  if (firstInvalid) firstInvalid.focus()
  return !firstInvalid
}

// Clear a field's error as soon as it becomes valid.
Object.keys(rules).forEach((field) => {
  const evt = field === 'sellerType' ? 'change' : 'input'
  form[field].addEventListener(evt, () => {
    if (form[field].closest('.field').classList.contains('has-error')) {
      showError(field, rules[field](form[field].value))
    }
  })
})

/* ---------------- Free or Paid (set on /admin) ---------------- */

// The page ships with the Free wording. When the admin has set a fee, the
// server says so and these swap in; the Free text is kept to switch back.
const PAID_COPY = {
  'fee-value': (f) => f,
  'fee-hint': () => 'Pay once with Razorpay — UPI, cards or net banking. Your seat is booked as soon as you pay.',
  'form-note': (f) => `Registration ${f} · Secure payment by Razorpay · Join link on WhatsApp &amp; email`,
  'trust-fee': () => 'Secure payment by Razorpay',
  'how-intro': () => 'Book in a minute — pay once with Razorpay — and the join link comes to you. The rest happens live, with your questions answered.',
  'how-step': (f) => `Pay ${f} with Razorpay and your seat is booked at once.`,
  'pricing-title': (f) => `${f} <span class="accent">for your seat.</span>`,
  'pricing-text': (f) => `Registration for the group meeting is ${f}. Fill in your details, pay securely with Razorpay, and your seat is booked; your join link follows on WhatsApp and email.`,
  'price-amount': (f) => f,
  'price-sub': () => 'One-time registration · one live session',
  'price-check': () => 'Secure payment with Razorpay',
  'faq-fee': (f) => `Yes — ${f}, paid once with Razorpay (UPI, cards or net banking). Fill in your details, press Pay &amp; book, and your seat is booked as soon as you pay.`,
}
const FREE_COPY = Object.fromEntries([...document.querySelectorAll('[data-copy]')].map((el) => [el.dataset.copy, el.innerHTML]))

const formatRupees = (n) => `₹${Number(n).toLocaleString('en-IN')}/-`
let pricing = { free: true, fee: 0 }

function applyPricing(p) {
  pricing = p
  const fee = formatRupees(p.fee)
  document.querySelectorAll('[data-copy]').forEach((el) => {
    const key = el.dataset.copy
    // Fixed text from this file; the only number in it is the server's fee.
    el.innerHTML = p.free ? FREE_COPY[key] : PAID_COPY[key]?.(fee) ?? FREE_COPY[key]
  })
  setBusy(false)
}

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => applyPricing({ free: cfg.free !== false, fee: cfg.fee }))
  .catch(() => {}) // stays Free; the server refuses a free booking if that is wrong

/* ---------------- Book: Free (details only) or Paid (Razorpay) ---------------- */
const formAlert = document.getElementById('formAlert')

function setAlert(message) {
  formAlert.textContent = message || ''
  formAlert.hidden = !message
}

// While booking: a spinner and words on the button, and the form locked, so a
// second press can't send it twice and the visitor can see something is happening.
function setBusy(busy, label) {
  bookBtn.disabled = busy
  bookBtn.classList.toggle('is-loading', busy)
  bookBtn.setAttribute('aria-busy', String(busy))
  form.classList.toggle('is-busy', busy)
  if (busy) {
    const spinner = document.createElement('span')
    spinner.className = 'spinner'
    spinner.setAttribute('aria-hidden', 'true')
    bookBtn.replaceChildren(spinner, document.createTextNode(label || 'Booking your seat…'))
  } else {
    bookBtn.textContent = pricing.free ? 'Book Now' : `Pay ${formatRupees(pricing.fee)} & book`
  }
}

// A booking answers in milliseconds; holding the spinner a moment longer lets the
// visitor see it was sent rather than wondering whether the press did anything.
const atLeast = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

// Razorpay's checkout script, loaded only when a payment is actually started.
let razorpayLoading = null
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve()
  razorpayLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = resolve
    s.onerror = () => {
      razorpayLoading = null
      reject(new Error('load'))
    }
    document.head.append(s)
  })
  return razorpayLoading
}

function showFieldErrors(data) {
  Object.entries(data.fields || {}).forEach(([field, msg]) => showError(field, msg))
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  setAlert('')
  if (!validate()) return

  const booking = {
    name: form.name.value.trim(),
    phone: form.phone.value,
    email: form.email.value.trim(),
    sellerType: form.sellerType.value,
    website: form.website.value,
  }

  if (bookBtn.disabled) return // already booking
  if (pricing.free) return bookFree(booking)
  return bookPaid(booking)
})

async function bookFree(booking) {
  setBusy(true)
  try {
    const [{ res, data }] = await Promise.all([postJson('/api/book', booking), atLeast(800)])
    setBusy(false)
    if (res.status === 409) return refreshPricing()
    if (!res.ok) {
      showFieldErrors(data)
      setAlert(data.error || 'Could not book your seat. Please try again.')
      return
    }
    openModal({ ...booking, phone: `+91${booking.phone}`, bookingId: data.bookingId, alreadyBooked: data.alreadyBooked, bookedAt: data.bookedAt })
  } catch {
    setBusy(false)
    setAlert('Network error. Please check your connection and try again.')
  }
}

async function bookPaid(booking) {
  setBusy(true, 'Opening payment…')
  let order
  try {
    await loadRazorpay()
    const { res, data } = await postJson('/api/create-order', booking)
    if (res.status === 409) {
      setBusy(false)
      return refreshPricing()
    }
    if (!res.ok) {
      setBusy(false)
      showFieldErrors(data)
      return setAlert(data.error || 'Could not start the payment. Please try again.')
    }
    order = data
  } catch {
    setBusy(false)
    return setAlert('Could not open the payment window. Check your connection and try again.')
  }

  // The server's amount is what is charged; show it if the page had an older one.
  if (order.amount / 100 !== pricing.fee) applyPricing({ free: false, fee: order.amount / 100 })
  setBusy(true, 'Waiting for payment…')

  const rzp = new window.Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency,
    name: order.businessName,
    description: order.description,
    image: `${location.origin}/assets/eso-wolf-icon.png`,
    prefill: order.prefill,
    notes: { seller_type: SELLER_LABELS[booking.sellerType] },
    theme: { color: '#fd761a' },
    modal: { ondismiss: () => setBusy(false) },
    handler: async (response) => {
      setBusy(true, 'Confirming…')
      try {
        const { data } = await postJson('/api/verify-payment', response)
        setBusy(false)
        if (data.status === 'PAID') {
          openModal({ ...booking, phone: `+91${booking.phone}`, paid: order.amount / 100, paymentId: data.paymentId })
        } else {
          setAlert(`We received your payment but couldn't confirm it yet. Please keep this ID and contact us: ${response.razorpay_payment_id}`)
        }
      } catch {
        setBusy(false)
        setAlert(`Payment done, but confirmation failed due to a network error. Payment ID: ${response.razorpay_payment_id}`)
      }
    },
  })
  rzp.on('payment.failed', (resp) => {
    setBusy(false)
    setAlert(`Payment failed: ${resp.error?.description || 'please try again.'}`)
  })
  rzp.open()
}

// The admin changed Free/Paid while this page was open: reload the price and say so.
async function refreshPricing() {
  try {
    const cfg = await (await fetch('/api/config')).json()
    applyPricing({ free: cfg.free !== false, fee: cfg.fee })
  } catch {}
  setAlert(`${pricing.free ? 'Registration is free now.' : `The registration fee is now ${formatRupees(pricing.fee)}.`} Please press the button again.`)
}

/* ---------------- Modal ---------------- */
const modal = document.getElementById('payModal')

function openModal(b) {
  // Booking again with the same number is the same seat — said plainly, so it
  // doesn't read as a booking that failed.
  const again = Boolean(b.alreadyBooked)
  const icon = modal.querySelector('.modal__check')
  icon.textContent = again ? 'i' : '✓'
  icon.classList.toggle('modal__check--info', again)
  document.getElementById('modalTitle').textContent = b.paymentId ? 'Payment successful!' : again ? 'You’re already booked' : 'Seat booked!'
  const when = b.bookedAt
    ? new Date(b.bookedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : null
  document.getElementById('modalText').textContent = again
    ? `This number already has a seat${when ? ` (booked on ${when})` : ''}. One seat per number — your join link was sent to WhatsApp and email when you first booked.`
    : 'Your seat for the group meeting is booked. The join link is on its way to your WhatsApp and email.'
  const rows = [
    ['Name', b.name],
    ['Phone', b.phone],
    ['Mail ID', b.email],
    ['Seller', SELLER_LABELS[b.sellerType]],
    ['Booking ID', b.bookingId],
    ['Paid', b.paid ? formatRupees(b.paid) : null],
    ['Payment ID', b.paymentId],
  ].filter(([, v]) => v)
  const summary = document.getElementById('modalSummary')
  summary.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt')
      const dd = document.createElement('dd')
      dt.textContent = k
      dd.textContent = v
      return [dt, dd]
    }),
  )
  modal.hidden = false
  modal.querySelector('button[data-close]').focus()
}

function closeModal() {
  modal.hidden = true
  form.reset()
}

modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal()
})
