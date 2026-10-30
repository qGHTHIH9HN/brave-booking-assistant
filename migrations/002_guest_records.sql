-- Staging-only migration. Requires GUEST_DATA_ENCRYPTION_KEY in the server environment.
-- Guest contact data is stored as AES-256-GCM ciphertext; key must be backed up securely.
BEGIN;
CREATE TABLE IF NOT EXISTS managed_guests (
  id uuid PRIMARY KEY,
  encrypted_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_managed_guests_created ON managed_guests(created_at DESC);
COMMIT;
