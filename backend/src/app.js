import cors from "cors";
import express from "express";
import discoveryRoutes from "./routes/discoveryRoutes.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "virtual-cell-api" }));
app.use("/api/discovery", discoveryRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

export default app;
