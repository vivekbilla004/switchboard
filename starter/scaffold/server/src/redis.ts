import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;

// Connects on first use. Call from anywhere: const redis = getRedis();
export function getRedis(): Redis {
  if (!redis) redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  return redis;
}
