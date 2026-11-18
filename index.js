import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
dotenv.config()

const app = express()
const port = process.env.PORT || 5000

// middleware
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
    res.send("WedPlan is running")
})

app.listen(port, () => {
    console.log(`WedPlan is running on port: ${port}`)
})