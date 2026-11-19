import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { MongoClient } from 'mongodb';
dotenv.config()

const app = express()
const port = process.env.PORT || 5000

// middleware
app.use(cors())
app.use(express.json())

const client = new MongoClient(process.env.MONGODB_URI);

const database = client.db('wed_plan')
const users = database.collection('user')
const services = database.collection('services')
const bookings = database.collection('bookings')
const transactions = database.collection('transactions')
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

app.get('/', (req, res) => {
    res.send("WedPlan is running")
})

// All approved + active services. Supports ?category=<slug> and ?limit=<n>
app.get('/services', async (req, res) => {
  try {
    const { category, limit } = req.query;
    const query = { approved: true, active: true };
    if (category) query.categorySlug = category;

    let cursor = services
      .find(query)
      .sort({ rating: -1 });

    if (limit && Number.isFinite(Number(limit))) {
      cursor = cursor.limit(Number(limit));
    }

    res.json(await cursor.toArray());
  } catch (err) {
    console.error('Failed to load services:', err);
    res.status(500).json({ message: 'Failed to load services' });
  }
});

// Featured services — approved + active only, top rated first
app.get('/services/featured', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 6;

    const docs = await services
      .find({ approved: true, active: true })
      .sort({ rating: -1, reviews: -1 })
      .limit(limit)
      .toArray();

    res.json(docs);
  } catch (err) {
    console.error('Failed to load featured services:', err);
    res.status(500).json({ message: 'Failed to load featured services' });
  }
});

// Single service by slug (for the future detail page)
app.get('/services/:slug', async (req, res) => {
  try {
    const doc = await services.findOne({
      slug: req.params.slug,
      approved: true,
      active: true,
    });

    if (!doc) {
      return res.status(404).json({ message: 'Service not found' });
    }

    res.json(doc);
  } catch (err) {
    console.error('Failed to load service:', err);
    res.status(500).json({ message: 'Failed to load service' });
  }
});

// Service categories (static for now — mirror the homepage contract)
app.get('/categories', (req, res) => {
  res.json([
    { slug: 'photography', name: 'Photography & Videography', vendors: '180+ vendors' },
    { slug: 'venues', name: 'Wedding Venues', vendors: '120+ vendors' },
    { slug: 'decoration', name: 'Decoration & Florist', vendors: '150+ vendors' },
    { slug: 'catering', name: 'Catering Services', vendors: '140+ vendors' },
    { slug: 'makeup', name: 'Makeup & Styling', vendors: '110+ vendors' },
    { slug: 'fashion', name: 'Wedding Fashion', vendors: '90+ vendors' },
  ]);
});

async function run() {
  await connectToMongoDB();
  app.listen(port, () => {
    console.log(`WedPlan is running on port: ${port}`);
  });
}

run().catch(() => {
  process.exit(1);
});