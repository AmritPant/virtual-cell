import "dotenv/config";
import app from "./app.js";
import { connectDb } from "./config/db.js";
import { initGridFs } from "./services/gridfsService.js";
import { startDiscoveryWorker } from "./workers/discoveryWorker.js";

const port = Number(process.env.PORT || 4000);
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/virtual_cell";

async function start() {
  await connectDb(mongoUri);
  initGridFs();
  startDiscoveryWorker();
  app.listen(port, () => {
    console.log(`virtual-cell backend listening on ${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to boot API", error);
  process.exit(1);
});
