import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../data');
const dbPath = path.join(dataDir, 'jobs.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

sqlite3.verbose();
const db = new sqlite3.Database(dbPath);

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });

await run(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    startedAt TEXT,
    finishedAt TEXT,
    output TEXT,
    error TEXT
  )
`);

const toJob = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    command: row.command,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    output: row.output,
    error: row.error,
  };
};

export async function createJob(command) {
  const createdAt = new Date().toISOString();
  const { lastID } = await run(
    `INSERT INTO jobs (command, status, createdAt) VALUES (?, 'pending', ?)`,
    [command, createdAt],
  );
  return getJobById(lastID);
}

export async function updateJob(id, fields) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return getJobById(id);
  }
  const setClauses = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  values.push(id);
  await run(`UPDATE jobs SET ${setClauses} WHERE id = ?`, values);
  return getJobById(id);
}

export async function getJobById(id) {
  const row = await get(`SELECT * FROM jobs WHERE id = ?`, [id]);
  return toJob(row);
}

export async function getJobByCommand(command) {
  const row = await get(
    `SELECT * FROM jobs WHERE command = ? ORDER BY id DESC LIMIT 1`,
    [command],
  );
  return toJob(row);
}

export async function listPendingJobs() {
  const rows = await all(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY id ASC`);
  return rows.map(toJob);
}

export async function listJobs() {
  const rows = await all(`SELECT * FROM jobs ORDER BY id DESC`);
  return rows.map(toJob);
}

export async function closeStore() {
  await new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
