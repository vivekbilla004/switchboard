
import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';
import { createIndexes, seedWorkspaces } from './models/indexes.js';

let client: MongoClient | undefined;
let database: Db | undefined;
let initialization: Promise<Db> | undefined;

export async function getDb(): Promise<Db> {
  if (database) return database;

  if (!initialization) {
    initialization = (async () => {
      const mongoClient = new MongoClient(config.mongoUrl);

      try {
        await mongoClient.connect();

        const db = mongoClient.db();

        await createIndexes(db);
        await seedWorkspaces(db);

        client = mongoClient;
        database = db;

        return db;
      } catch (error) {
        await mongoClient.close().catch(() => undefined);
        throw error;
      }
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }

  return initialization;
}

export async function closeDb(): Promise<void> {
  if (initialization && !database) {
    await initialization.catch(() => undefined);
  }

  if (client) {
    await client.close();
  }

  client = undefined;
  database = undefined;
  initialization = undefined;
}
