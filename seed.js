import dotenv from 'dotenv'
import { MongoClient } from 'mongodb'

dotenv.config()

// One-time (idempotent) seed for the wedding-plan frontend.
// Safe to re-run: every document is upserted by `slug`.
//
// Usage:  node seed.js
//
// Note: the service images live in the FRONTEND's /public/images/services
// folder, so only relative paths are stored — the API never serves binaries.

const services = [
  {
    slug: 'royal-frame-photography',
    name: 'Royal Wedding Photography & Video',
    category: 'Photography & Videography',
    categorySlug: 'photography',
    priceFrom: 45000,
    location: 'Gulshan, Dhaka',
    rating: 4.9,
    reviews: 212,
    vendor: { name: 'Royal Frame Studio', verified: true },
    approved: true,
    active: true,
    image: '/images/services/royal-photography.jpg',
  },
  {
    slug: 'the-grand-palace-venue',
    name: 'The Grand Palace — Banquet & Lawn',
    category: 'Wedding Venues',
    categorySlug: 'venues',
    priceFrom: 250000,
    location: 'Banani, Dhaka',
    rating: 4.8,
    reviews: 96,
    vendor: { name: 'The Grand Palace Banquet', verified: true },
    approved: true,
    active: true,
    image: '/images/services/grand-palace-hall.jpg',
  },
  {
    slug: 'bloom-blossom-florals',
    name: 'Signature Floral & Décor Package',
    category: 'Decoration & Florist',
    categorySlug: 'decoration',
    priceFrom: 120000,
    location: 'Dhanmondi, Dhaka',
    rating: 4.9,
    reviews: 148,
    vendor: { name: 'Bloom & Blossom Florals', verified: true },
    approved: true,
    active: true,
    image: '/images/services/bloom-blossom-decor.jpg',
  },
  {
    slug: 'spice-route-catering',
    name: 'Royal Feast Wedding Buffet — 100 Guests',
    category: 'Catering Services',
    categorySlug: 'catering',
    priceFrom: 85000,
    location: 'Uttara, Dhaka',
    rating: 4.7,
    reviews: 320,
    vendor: { name: 'Spice Route Catering', verified: true },
    approved: true,
    active: true,
    image: '/images/services/spice-route-catering.jpg',
  },
  {
    slug: 'glam-canvas-by-rafiya',
    name: 'Bridal Makeup & Full-Day Styling',
    category: 'Makeup & Styling',
    categorySlug: 'makeup',
    priceFrom: 25000,
    location: 'Banani, Dhaka',
    rating: 5.0,
    reviews: 187,
    vendor: { name: 'Glam Canvas by Rafiya', verified: true },
    approved: true,
    active: true,
    image: '/images/services/glam-canvas-makeup.jpg',
  },
  {
    slug: 'house-of-noor-bridal-wear',
    name: 'Handwoven Bridal Lehenga & Sherwani',
    category: 'Wedding Fashion',
    categorySlug: 'fashion',
    priceFrom: 180000,
    location: 'Mirpur, Dhaka',
    rating: 4.8,
    reviews: 74,
    vendor: { name: 'House of Noor', verified: true },
    approved: true,
    active: true,
    image: '/images/services/house-of-noor-bridal.jpg',
  },
  // Intentionally filtered by the approved+active rule (not returned by the API):
  {
    slug: 'budget-tent-shamiana',
    name: 'Budget Tent & Shamiana Setup',
    category: 'Decoration & Florist',
    categorySlug: 'decoration',
    priceFrom: 30000,
    location: 'Mirpur, Dhaka',
    rating: 4.2,
    reviews: 45,
    vendor: { name: 'Budget Tent House', verified: false },
    approved: true,
    active: false,
    image: '/images/services/bloom-blossom-decor.jpg',
  },
  {
    slug: 'loudspeaker-hire-pending',
    name: 'Loudspeaker & Sound Hire',
    category: 'Photography & Videography',
    categorySlug: 'photography',
    priceFrom: 15000,
    location: 'Tongi, Gazipur',
    rating: 0,
    reviews: 0,
    vendor: { name: 'Pending Review Trader', verified: false },
    approved: false,
    active: true,
    image: '/images/services/royal-photography.jpg',
  },
]

const client = new MongoClient(process.env.MONGODB_URI)

async function run() {
  await client.connect()
  const servicesCollection = client.db('wed_plan').collection('services')

  let upserted = 0
  for (const service of services) {
    await servicesCollection.updateOne(
      { slug: service.slug },
      { $set: service },
      { upsert: true }
    )
    upserted += 1
  }

  const approvedActive = await servicesCollection.countDocuments({
    approved: true,
    active: true,
  })

  console.log(`Seeded ${upserted} services. Approved + active in DB: ${approvedActive}`)
  await client.close()
}

run().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
