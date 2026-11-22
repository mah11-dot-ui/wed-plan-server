
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { MongoClient } from 'mongodb';
import { registerSecureRoutes, registerStripeWebhook } from './routes/secure-api.js'
dotenv.config()

const app = express()
const port = process.env.PORT || 5000

const client = new MongoClient(process.env.MONGODB_URI);

const database = client.db('wed_plan')
const users = database.collection('user')
const services = database.collection('services')
const bookings = database.collection('bookings')
const transactions = database.collection('transactions')
const collections = { users, services, bookings, transactions }

// middleware
app.use(cors())

// Stripe webhook needs the exact raw bytes for signature verification —
// register it before express.json().
registerStripeWebhook(app, collections)

app.use(express.json())
export async function connectToMongoDB() {
  try {
      await client.connect();
      
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    throw err;
  }
}

// Call this only when your application terminates
// export async function disconnectFromMongoDB() {
//   await client.close();
// }

// Normalize a service document to the public API contract the
// WedPlan frontend renders (see src/lib/services.js there).
const categorySlugMap = {
  'Photography & Videography': 'photography',
  'Wedding Venues': 'venues',
  'Decoration & Florist': 'decoration',
  'Catering Services': 'catering',
  'Makeup & Styling': 'makeup',
  'Wedding Fashion': 'fashion',
};

const slugify = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const escapeRegex = (text) =>
  String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function toPublicService(doc) {
  return {
    slug: doc.slug ?? slugify(doc.serviceName),
    name: doc.serviceName,
    category: doc.category,
    categorySlug: doc.categorySlug ?? categorySlugMap[doc.category] ?? slugify(doc.category),
    priceFrom: doc.price,
    location: doc.location,
    rating: doc.vendorInfo?.rating ?? 0,
    reviews: doc.reviews ?? 0,
    vendor: {
      name: doc.vendorInfo?.name ?? 'WedPlan Vendor',
      verified: doc.vendorInfo?.verified ?? true,
      email: doc.vendorInfo?.email,
      phone: doc.vendorInfo?.phone,
    },
    approved: doc.approved === true,
    active: doc.active === true,
    image: doc.serviceImage ?? doc.images?.[0],
    images: doc.images ?? (doc.serviceImage ? [doc.serviceImage] : []),
    description: doc.description ?? "",
    buttonText: doc.buttonText ?? 'View Details',
  };
}

app.get('/', (req, res) => {
    res.send("WedPlan is running")
})

// All approved + active services. Supports ?category=<slug> and ?limit=<n>
app.get('/services', async (req, res) => {
  try {
    const { category, limit, search, location, sort } = req.query;
    const slugToName = Object.fromEntries(
      Object.entries(categorySlugMap).map(([name, slug]) => [slug, name])
    );
    const query = { approved: true, active: true };
    if (category && category !== 'all') {
      query.category = slugToName[category] ?? category;
    }
    if (location && location !== 'all') {
      query.location = location;
    }
    if (search) {
      query.serviceName = { $regex: escapeRegex(search), $options: 'i' };
    }

    const order = sort === 'price_asc' ? 1 : sort === 'price_desc' ? -1 : null;

    let cursor = services
      .find(query)
      .sort(order ? { price: order } : { 'vendorInfo.rating': -1 });

    if (limit && Number.isFinite(Number(limit))) {
      cursor = cursor.limit(Number(limit));
    }

    const docs = await cursor.toArray();
    res.json(docs.map(toPublicService));
  } catch (err) {
    console.error('Failed to load services:', err);
    res.status(500).json({ message: 'Failed to load services' });
  }
});

// Distinct locations among approved + active services (for filter dropdowns)
app.get('/services/locations', async (req, res) => {
  try {
    const rows = await services
      .aggregate([
        { $match: { approved: true, active: true } },
        { $group: { _id: '$location' } },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    res.json(rows.map((row) => row._id).filter(Boolean));
  } catch (err) {
    console.error('Failed to load locations:', err);
    res.status(500).json({ message: 'Failed to load locations' });
  }
});

// Featured services — approved + active only, top rated first
app.get('/services/featured', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 6;

    const docs = await services
      .find({ approved: true, active: true })
      .sort({ 'vendorInfo.rating': -1, reviews: -1 })
      .limit(limit)
      .toArray();

    res.json(docs.map(toPublicService));
  } catch (err) {
    console.error('Failed to load featured services:', err);
    res.status(500).json({ message: 'Failed to load featured services' });
  }
});

// Single service by slug (for the future detail page).
// Slugs are derived (slugify(serviceName)) — there is no stored slug field.
app.get('/services/:slug', async (req, res) => {
  try {
    const docs = await services
      .find({ approved: true, active: true })
      .toArray();

    const match = docs
      .map(toPublicService)
      .find((service) => service.slug === req.params.slug);

    if (!match) {
      return res.status(404).json({ message: 'Service not found' });
    }

    res.json(match);
  } catch (err) {
    console.error('Failed to load service:', err);
    res.status(500).json({ message: 'Failed to load service' });
  }
});

// Service categories — built live from the approved + active services in the
// database. The six spec categories are always present (count may be 0), and
// any additional category found in the DB is appended too.
const categoryDisplayOrder = [
  'Photography & Videography',
  'Wedding Venues',
  'Decoration & Florist',
  'Catering Services',
  'Makeup & Styling',
  'Wedding Fashion',
];

app.get('/categories', async (req, res) => {
  try {
    const grouped = await services
      .aggregate([
        { $match: { approved: true, active: true } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ])
      .toArray();

    const countByName = new Map(grouped.map((row) => [row._id, row.count]));
    const seen = new Set(categoryDisplayOrder);

    const specCategories = categoryDisplayOrder.map((name) => ({
      slug: categorySlugMap[name] ?? slugify(name),
      name,
      count: countByName.get(name) ?? 0,
      vendors: `${countByName.get(name) ?? 0} vendors`,
    }));

    const extraCategories = grouped
      .filter((row) => !seen.has(row._id))
      .sort((a, b) => b.count - a.count)
      .map((row) => ({
        slug: slugify(row._id),
        name: row._id,
        count: row.count,
        vendors: `${row.count} vendors`,
      }));

    res.json([...specCategories, ...extraCategories]);
  } catch (err) {
    console.error('Failed to load categories:', err);
    res.status(500).json({ message: 'Failed to load categories' });
  }
});

// JWT-protected business API (auth, roles and ownership enforced server-side).
registerSecureRoutes(app, collections)

async function run() {
  await connectToMongoDB();
  app.listen(port, () => {
    console.log(`WedPlan is running on port: ${port}`);
  });
}

run().catch(() => {
  process.exit(1);
});

export default app;
