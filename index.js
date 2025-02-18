import express from 'express';
import fetch from 'node-fetch';  // Now using ES module import
import cors from 'cors';
const app = express();
app.use(cors());

// Express route to handle POST request
app.post('/submit', async (req, res) => {
  const { content } = req.body;
  const payload = {
    transaction: { content: content },
    frontRunningProtection: true,
  };
  try {
    const resonse = await fetch("https://ny.nextblock.io/api/v2/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "entry1730832791-bN14n%2BFtqfPJqWXWtXteSftVdzUt5yHH7ACRmoRtCvk%3D",
      },
      body: JSON.stringify(payload),
    });
    console.log("sucess", resonse);
    res.status(200).json({isSucess : true, data: resonse});
  } catch (error) {
    console.log("error", error);
    res.status(500).json({ isSucess: false, error: error });
  }
})

app.get("/ping", (req, res) => {
  res.send("pong")
});

// Start the Express server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});