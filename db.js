import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

export async function getDb() {
  if (db) {
    return db;
  }

  const dbPath = path.join(__dirname, 'netvu.db');
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON');

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip_address TEXT NOT NULL UNIQUE,
      site_id TEXT,
      status TEXT DEFAULT 'active',
      device_type TEXT DEFAULT 'nvr',
      max_cameras INTEGER DEFAULT 16,
      username TEXT DEFAULT NULL,      
      password TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER NOT NULL,
      device_ip TEXT NOT NULL,
      cam INTEGER NOT NULL,
      type TEXT,
      description TEXT,
      time INTEGER NOT NULL,
      duration INTEGER,
      range_value INTEGER,
      exists_flag TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, device_ip)
    )
  `);

  // Create indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_device_cam_time 
    ON events(device_ip, cam, time DESC)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_time 
    ON events(time DESC)
  `);

  console.log('[Database] Tables and indexes created successfully');

  return db;
}

export async function closeDb() {
  if (db) {
    await db.close();
    db = null;
    console.log('[Database] Connection closed');
  }
}

export default { getDb, closeDb };