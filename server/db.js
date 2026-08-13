"use strict";
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const SCHEMA = `
create extension if not exists pgcrypto;

create table if not exists subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists exercises (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  code text default '',
  topic text default '',
  statement jsonb not null default '[]',
  resolution jsonb not null default '[]',
  my_attempt jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  filename text,
  mime_type text,
  data bytea not null,
  created_at timestamptz not null default now()
);
`;

function migrate() {
  return pool.query(SCHEMA);
}

module.exports = { pool: pool, migrate: migrate };
