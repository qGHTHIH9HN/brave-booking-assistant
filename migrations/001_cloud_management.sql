-- Development-only schema for the cloud management API.
-- Apply to a staging Neon database first. Does not alter assistant_settings.
BEGIN;
CREATE TABLE IF NOT EXISTS managed_properties (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS managed_bookings (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES managed_properties(id) ON DELETE RESTRICT,
  check_in date NOT NULL,
  check_out date NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','pending_review','cancelled','completed')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);
CREATE INDEX IF NOT EXISTS idx_managed_bookings_property ON managed_bookings(property_id);
CREATE INDEX IF NOT EXISTS idx_managed_bookings_created ON managed_bookings(created_at DESC);
COMMIT;
