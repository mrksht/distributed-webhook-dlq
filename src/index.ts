import express, { NextFunction, Request, Response } from "express";
import { webhooksRouter } from "./routes/webhooks";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(webhooksRouter);

// Catches errors from webhooksRouter's asyncHandler wrapper (e.g. requireTenant's invariant
// check) so they surface as a 500 instead of an unhandled rejection. Must be registered last,
// after every route -- Express identifies error-handling middleware by its 4-argument arity.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal server error" });
});

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
