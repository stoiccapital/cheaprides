-- Cheaprides D1 schema

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'passenger',  -- 'passenger' | 'company'
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token           TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS companies (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  name                TEXT NOT NULL,
  billing_address     TEXT NOT NULL,
  city                TEXT NOT NULL,
  vat_number          TEXT NOT NULL,
  managing_director   TEXT NOT NULL,
  phone               TEXT NOT NULL,
  email               TEXT NOT NULL,
  description         TEXT,
  price_per_km        REAL NOT NULL,
  min_km              REAL NOT NULL,
  stats_completed     INTEGER NOT NULL DEFAULT 0,
  stats_cancelled     INTEGER NOT NULL DEFAULT 0,
  stats_noshow        INTEGER NOT NULL DEFAULT 0,
  last_completed_at   INTEGER,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_companies_city ON companies(city);
CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner_id);

CREATE TABLE IF NOT EXISTS bookings (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  rider_id        TEXT NOT NULL,
  pickup          TEXT NOT NULL,
  dropoff         TEXT NOT NULL,
  distance        REAL NOT NULL,
  price_per_km    REAL NOT NULL,
  total           REAL NOT NULL,
  status          TEXT NOT NULL,  -- pending/accepted/completed/cancelled/noshow/declined
  reviewed        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  accepted_at     INTEGER,
  completed_at    INTEGER,
  cancelled_at    INTEGER,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (rider_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_bookings_rider ON bookings(rider_id);
CREATE INDEX IF NOT EXISTS idx_bookings_company ON bookings(company_id);

CREATE TABLE IF NOT EXISTS reviews (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  rider_id        TEXT NOT NULL,
  booking_id      TEXT NOT NULL,
  rating          INTEGER NOT NULL,
  comment         TEXT,
  author          TEXT,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (rider_id) REFERENCES users(id),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_company ON reviews(company_id);
