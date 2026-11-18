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

async function run() {
  await connectToMongoDB();
  app.listen(port, () => {
    console.log(`WedPlan is running on port: ${port}`);
  });
}

run().catch(() => {
  process.exit(1);
});