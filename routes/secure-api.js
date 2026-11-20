import { ObjectId } from 'mongodb'
import Stripe from 'stripe'

import { verifyToken, requireRole, isOwner } from '../middleware/auth.js'

const validId = (id) => ObjectId.isValid(id)

// Slug derived from service name — stored documents have no `slug` field.
export const slugify = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

const categorySlugMap = {
  'Photography & Videography': 'photography',
  'Wedding Venues': 'venues',
  'Decoration & Florist': 'decoration',
  'Catering Services': 'catering',
  'Makeup & Styling': 'makeup',
  'Wedding Fashion': 'fashion',
}

function validateService(body) {
  const errors = {}
  const { serviceName, category, description, price, location, serviceImage } = body ?? {}
  if (!serviceName || String(serviceName).trim().length < 3) errors.serviceName = 'Service name must be at least 3 characters.'
  if (!category || String(category).trim().length < 2) errors.category = 'Choose a category.'
  if (!description || String(description).trim().length < 10) errors.description = 'Description must be at least 10 characters.'
  if (!price || !Number.isFinite(Number(price)) || Number(price) <= 0) errors.price = 'Enter a price greater than zero.'
  if (!location || String(location).trim().length < 2) errors.location = 'Enter a location.'
  if (!serviceImage || !/^https?:\/\//.test(String(serviceImage))) errors.serviceImage = 'Upload a service image.'
  return errors
}

export function registerSecureRoutes(app, collections) {
  const { services, bookings, users, transactions } = collections

  // ---------- Bookings ----------

  // POST /api/bookings — customers (and vendors) request a service.
  app.post('/api/bookings', verifyToken, requireRole('customer', 'vendor'), async (req, res) => {
    const { serviceSlug, eventDate, eventLocation, guests, phone, message = '' } = req.body ?? {}

    const errors = {}
    if (!serviceSlug) errors.serviceSlug = 'A service is required.'
    if (!eventDate || Number.isNaN(Date.parse(eventDate))) errors.eventDate = 'A valid event date is required.'
    const when = eventDate ? new Date(eventDate) : null
    if (when) {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      if (when < today) errors.eventDate = 'The event date cannot be in the past.'
    }
    if (!eventLocation || String(eventLocation).trim().length < 2) errors.eventLocation = 'Enter the event location.'
    const guestNumber = Number(guests)
    if (!Number.isInteger(guestNumber) || guestNumber < 1 || guestNumber > 10000) errors.guests = 'Guests must be between 1 and 10,000.'
    if (!phone || !/^\+?[0-9 ()-]{6,20}$/.test(String(phone).trim())) errors.phone = 'Enter a valid phone number.'
    if (Object.keys(errors).length) return res.status(400).json({ message: 'Please fix the highlighted fields.', errors })

    // Only approved + active services are bookable.
    const candidates = await services.find({ approved: true, active: true }).toArray()
    const service = candidates.find((doc) => slugify(doc.serviceName) === serviceSlug)
    if (!service) return res.status(404).json({ message: 'This service is not available for booking.' })

    const vendorEmail = service.vendorInfo?.email?.toLowerCase?.() ?? null
    const userEmail = String(req.user.email).toLowerCase()
    if (req.user.role === 'vendor' && vendorEmail === userEmail) {
      return res.status(403).json({ message: 'Vendors cannot book their own services.' })
    }

    // Prevent duplicate active requests for the same service and event date.
    const day = when.toISOString().slice(0, 10)
    const duplicate = await bookings.findOne({
      serviceId: service._id.toString(),
      customerId: req.user.id,
      eventDay: day,
      status: { $in: ['pending', 'accepted'] },
    })
    if (duplicate) {
      return res.status(409).json({ message: 'You already have an active request for this service on that date.' })
    }

    const now = new Date()
    const doc = {
      serviceId: service._id.toString(),
      vendorId: service.vendorId ?? null,
      customerId: req.user.id,
      serviceName: service.serviceName,
      serviceSlug,
      serviceImage: service.serviceImage ?? null,
      vendorName: service.vendorInfo?.name ?? 'WedPlan Vendor',
      vendorEmail,
      priceFrom: service.price ?? null,
      customerName: req.user.name,
      customerEmail: req.user.email,
      eventDate: when,
      eventDay: day,
      eventLocation: String(eventLocation).trim(),
      guests: guestNumber,
      phone: String(phone).trim(),
      message: String(message).trim().slice(0, 500),
      status: 'pending',
      createdAt: now,
    }

    const result = await bookings.insertOne(doc)
    res.status(201).json({
      message: 'Booking request sent! The vendor will be in touch shortly.',
      bookingId: result.insertedId.toString(),
    })
  })

  // PATCH /api/bookings/:id — vendor accepts/rejects, customer cancels.
  app.patch('/api/bookings/:id', verifyToken, async (req, res) => {
    const { id } = req.params
    if (!validId(id)) return res.status(404).json({ message: 'Booking not found.' })
    const booking = await bookings.findOne({ _id: new ObjectId(id) })
    if (!booking) return res.status(404).json({ message: 'Booking not found.' })

    const status = req.body?.status
    if (req.user.role === 'admin') {
      return res.status(403).json({ message: 'Admins cannot modify customer booking requests.' })
    }

    if (status === 'accepted' || status === 'rejected') {
      if (req.user.role !== 'vendor' || !isOwner(req, booking)) {
        return res.status(403).json({ message: 'You can only manage requests for your own services.' })
      }
    } else if (status === 'cancelled') {
      if (String(booking.customerId) !== String(req.user.id)) {
        return res.status(403).json({ message: 'You can only cancel your own requests.' })
      }
    } else {
      return res.status(400).json({ message: 'Invalid booking status.' })
    }

    const result = await bookings.updateOne(
      { _id: booking._id, status: 'pending' },
      { $set: { status, processedAt: new Date() } }
    )
    if (!result.matchedCount) {
      return res.status(409).json({ message: 'This request is no longer pending.' })
    }

    res.json({ message: `Booking ${status}.` })
  })

  // ---------- Services ----------

  app.post('/api/services', verifyToken, requireRole('vendor'), async (req, res) => {
    const errors = validateService(req.body)
    if (Object.keys(errors).length) return res.status(400).json({ message: 'Please fix the highlighted fields.', errors })

    const activeCount = await services.countDocuments({ vendorId: req.user.id, active: true })
    if ((req.user.plan ?? 'free') !== 'premium' && activeCount >= 3) {
      return res.status(403).json({ message: 'Free plan allows at most 3 active services. Upgrade to Premium.' })
    }

    const { serviceName, category, description, price, location, serviceImage } = req.body
    const images =
      Array.isArray(req.body.images) && req.body.images.length
        ? req.body.images.slice(0, 5).map(String).filter((url) => /^https?:\/\//.test(url))
        : []
    const finalImages = images.length ? images : [String(serviceImage).trim()]
    const now = new Date()
    const doc = {
      vendorId: req.user.id,
      vendorEmail: req.user.email,
      serviceName: String(serviceName).trim(),
      category: String(category).trim(),
      categorySlug: categorySlugMap[category] ?? slugify(category),
      description: String(description).trim(),
      price: Number(price),
      location: String(location).trim(),
      images: finalImages,
      serviceImage: finalImages[0],
      vendorInfo: { name: req.user.name, email: req.user.email, verified: false, rating: 0 },
      status: 'pending',
      approved: false,
      active: false,
      createdAt: now,
    }
    const result = await services.insertOne(doc)
    res.status(201).json({ message: 'Service submitted for approval.', id: result.insertedId.toString() })
  })

  app.patch('/api/services/:id', verifyToken, async (req, res) => {
    const { id } = req.params
    if (!validId(id)) return res.status(404).json({ message: 'Service not found.' })
    const service = await services.findOne({ _id: new ObjectId(id) })
    if (!service) return res.status(404).json({ message: 'Service not found.' })

    const isAdmin = req.user.role === 'admin'
    const isVendorOwner = req.user.role === 'vendor' && isOwner(req, service)
    if (!isAdmin && !isVendorOwner) {
      return res.status(403).json({ message: 'You can only modify your own services.' })
    }

    const update = { updatedAt: new Date() }
    if (isAdmin) {
      const status = req.body?.status
      if (!['approved', 'rejected', 'pending'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status.' })
      }
      Object.assign(update, {
        status,
        approved: status === 'approved',
        active: status === 'approved',
        reviewedAt: new Date(),
      })
    } else if (req.body?.action === 'toggle') {
      if (!service.active && (req.user.plan ?? 'free') !== 'premium') {
        const count = await services.countDocuments({ vendorId: req.user.id, active: true })
        if (count >= 3) return res.status(403).json({ message: 'Free plan allows at most 3 active services.' })
      }
      update.active = !service.active
    } else {
      const errors = validateService(req.body)
      if (Object.keys(errors).length) return res.status(400).json({ message: 'Please fix the highlighted fields.', errors })
      const { serviceName, category, description, price, location, serviceImage } = req.body
      const images =
        Array.isArray(req.body.images) && req.body.images.length
          ? req.body.images.slice(0, 5).map(String).filter((url) => /^https?:\/\//.test(url))
          : []
      const finalImages = images.length ? images : [String(serviceImage).trim()]
      Object.assign(update, {
        serviceName: String(serviceName).trim(),
        category: String(category).trim(),
        categorySlug: categorySlugMap[category] ?? slugify(category),
        description: String(description).trim(),
        price: Number(price),
        location: String(location).trim(),
        serviceImage: finalImages[0],
        images: finalImages,
        status: 'pending',
        approved: false,
        active: false,
      })
    }

    await services.updateOne({ _id: service._id }, { $set: update })
    res.json({ message: 'Service updated.' })
  })

  app.delete('/api/services/:id', verifyToken, async (req, res) => {
    const { id } = req.params
    if (!validId(id)) return res.status(404).json({ message: 'Service not found.' })
    const service = await services.findOne({ _id: new ObjectId(id) })
    if (!service) return res.status(404).json({ message: 'Service not found.' })

    const allowed =
      req.user.role === 'admin' ||
      (req.user.role === 'vendor' && isOwner(req, service))
    if (!allowed) return res.status(403).json({ message: 'You can only delete your own services.' })

    await services.deleteOne({ _id: service._id })
    res.json({ message: 'Service deleted.' })
  })

  // ---------- Users (admin) ----------

  app.patch('/api/users/:id', verifyToken, requireRole('admin'), async (req, res) => {
    const { id } = req.params
    if (!validId(id)) return res.status(404).json({ message: 'User not found.' })
    if (id === req.user.id) return res.status(400).json({ message: 'You cannot block your own account.' })

    const isBlocked = Boolean(req.body?.isBlocked)
    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { blocked: isBlocked, isBlocked, updatedAt: new Date() } }
    )
    if (!result.matchedCount) return res.status(404).json({ message: 'User not found.' })
    res.json({ message: isBlocked ? 'User blocked.' : 'User unblocked.' })
  })

  // ---------- Transactions (admin, read-only) ----------

  app.get('/api/transactions', verifyToken, requireRole('admin'), async (_req, res) => {
    const docs = await transactions.find({}).sort({ createdAt: -1 }).toArray()
    res.json(docs)
  })

  // ---------- Stripe Checkout ----------

  app.post('/api/subscription/checkout', verifyToken, requireRole('vendor'), async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ message: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY to the server .env.' })
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:3000'
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'WedPlan Premium Vendor Plan', description: 'Unlimited active services and a Premium Vendor Badge.' },
          unit_amount: 999,
        },
        quantity: 1,
      }],
      metadata: { vendorId: req.user.id, plan: 'premium' },
      customer_email: req.user.email,
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment/cancel`,
    })

    res.json({ url: session.url })
  })

  // Display-only verification — activation happens exclusively via webhook.
  app.get('/api/subscription/session', verifyToken, async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ message: 'Stripe is not configured.' })
    const sessionId = String(req.query.session_id ?? '')
    if (!sessionId.startsWith('cs_')) return res.status(400).json({ message: 'Invalid session.' })
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    res.json({ paymentStatus: session.payment_status, status: session.status })
  })
}

// Raw-body route registered BEFORE express.json() so Stripe can verify the
// signature over the exact bytes it signed.
export function registerStripeWebhook(app, collections) {
  const { users, transactions } = collections

  app.post('/api/subscription/webhook', expressRaw(), async (req, res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ message: 'Stripe is not configured.' })
    }

    const signature = req.headers['stripe-signature']
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (error) {
      return res.status(400).json({ message: `Webhook signature failed: ${error.message}` })
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      if (session.payment_status === 'paid') {
        const vendorId = session.metadata?.vendorId
        const sessionId = session.id

        // Idempotency — a retried webhook must never create a second payment.
        const seen = await transactions.findOne({ stripeSessionId: sessionId })
        if (!seen && validId(vendorId)) {
          const now = new Date()
          const expires = new Date(now)
          expires.setFullYear(expires.getFullYear() + 1)

          await transactions.insertOne({
            vendorId,
            plan: 'premium',
            amount: (session.amount_total ?? 999) / 100,
            currency: session.currency ?? 'usd',
            stripeSessionId: sessionId,
            stripeSubscriptionId: session.subscription ?? null,
            status: 'succeeded',
            createdAt: now,
          })

          await users.updateOne(
            { _id: new ObjectId(vendorId) },
            {
              $set: {
                plan: 'premium',
                subscriptionPlan: 'premium',
                subscriptionExpiresAt: expires,
                updatedAt: now,
              },
            }
          )
        }
      }
    }

    res.json({ received: true })
  })
}

// Minimal raw middleware (avoid adding a body-parser dependency).
function expressRaw() {
  return (req, res, next) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      req.body = Buffer.concat(chunks)
      next()
    })
    req.on('error', next)
  }
}
