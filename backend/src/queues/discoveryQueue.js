import { Queue } from "bullmq";
import Redis from "ioredis";

let queueInstance = null;

export function getDiscoveryQueue() {
  if (queueInstance) return queueInstance;

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true
  });

  queueInstance = new Queue("discovery-jobs", { connection });
  return queueInstance;
}
