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

/* ---------------- Book Now: details only, no fee ---------------- */
const formAlert = document.getElementById('formAlert')

function setAlert(message) {
  formAlert.textContent = message || ''
  formAlert.hidden = !message
}

function setBusy(busy) {
  bookBtn.disabled = busy
  bookBtn.textContent = busy ? 'Booking…' : 'Book Now'
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

  setBusy(true)
  try {
    const res = await fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(booking),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      Object.entries(data.fields || {}).forEach(([field, msg]) => showError(field, msg))
      setAlert(data.error || 'Could not book your seat. Please try again.')
      return
    }
    openModal({ ...booking, phone: `+91${booking.phone}`, bookingId: data.bookingId, alreadyBooked: data.alreadyBooked })
  } catch {
    setBusy(false)
    setAlert('Network error. Please check your connection and try again.')
  }
})

/* ---------------- Modal ---------------- */
const modal = document.getElementById('payModal')

function openModal(b) {
  document.getElementById('modalText').textContent = b.alreadyBooked
    ? 'This number already has a seat booked — here it is. We’ll send the join link on WhatsApp and email.'
    : 'Your seat for the group meeting is booked. We’ll send the join link on WhatsApp and email.'
  const rows = [
    ['Name', b.name],
    ['Phone', b.phone],
    ['Mail ID', b.email],
    ['Seller', SELLER_LABELS[b.sellerType]],
    ['Booking ID', b.bookingId],
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
