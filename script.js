// ESO Closer — group meeting landing page

// The fee is set on the server (REGISTRATION_FEE in .env); this is only for display.
let registrationFee = null

const SELLER_LABELS = { existing: 'Existing seller', new: 'New seller' }

const formatRupees = (n) => `₹${n.toLocaleString('en-IN')}/-`

function showFee(fee) {
  registrationFee = fee
  document.getElementById('feeLabel').textContent = formatRupees(fee)
  document.querySelector('.pay-amount').textContent = formatRupees(fee)
}

document.getElementById('year').textContent = new Date().getFullYear()
fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => showFee(cfg.fee))
  .catch(() => {})

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
const sections = ['home', 'about', 'services'].map((id) => document.getElementById(id))
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
const payBtn = document.getElementById('payBtn')

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

/* ---------------- Pay Now (Razorpay) ---------------- */
const formAlert = document.getElementById('formAlert')

function setAlert(message) {
  formAlert.textContent = message || ''
  formAlert.hidden = !message
}

function setBusy(busy, label = 'Processing… ') {
  payBtn.disabled = busy
  payBtn.firstChild.textContent = busy ? label : 'Pay Now '
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
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
  }

  if (typeof window.Razorpay !== 'function') {
    setAlert('Payment window could not load. Check your internet connection and try again.')
    return
  }

  setBusy(true)
  let order
  try {
    const { ok, data } = await postJson('/api/create-order', booking)
    if (!ok) {
      Object.entries(data.fields || {}).forEach(([field, msg]) => showError(field, msg))
      setAlert(data.error || 'Could not start the payment. Please try again.')
      setBusy(false)
      return
    }
    order = data
    // If the admin changed the fee since this page loaded, show what is actually charged.
    showFee(order.amount / 100)
  } catch {
    setAlert('Network error. Please check your connection and try again.')
    setBusy(false)
    return
  }

  const rzp = new window.Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency,
    name: order.businessName,
    description: order.description,
    image: `${location.origin}/assets/eso-closer.png`,
    prefill: order.prefill,
    notes: { seller_type: SELLER_LABELS[booking.sellerType] },
    theme: { color: '#fd761a' },
    modal: {
      // Closed the popup without paying.
      ondismiss: () => setBusy(false),
    },
    handler: async (response) => {
      setBusy(true, 'Confirming… ')
      try {
        const { data } = await postJson('/api/verify-payment', response)
        setBusy(false)
        if (data.status === 'PAID') {
          openModal({ ...booking, phone: `+91${booking.phone}`, amount: order.amount / 100, paymentId: data.paymentId })
        } else {
          setAlert(
            `We received your payment but couldn't confirm it yet. Please keep this ID and contact us: ${response.razorpay_payment_id}`,
          )
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
})

/* ---------------- Modal ---------------- */
const modal = document.getElementById('payModal')

function openModal(b) {
  const rows = [
    ['Name', b.name],
    ['Phone', b.phone],
    ['Mail ID', b.email],
    ['Seller', SELLER_LABELS[b.sellerType]],
    ['Paid', formatRupees(b.amount)],
    ['Payment ID', b.paymentId],
  ]
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
