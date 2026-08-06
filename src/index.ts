import express from "express";
import { onJob } from "./queue/queue";
import { processJob } from "./worker/worker";
import { webhooksRouter } from "./routes/webhooks";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(webhooksRouter);

const PORT = process.env.PORT ?? 3000;

onJob(processJob);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
