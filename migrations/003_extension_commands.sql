-- Run on isolated staging database first.
CREATE TABLE IF NOT EXISTS extension_commands (
 id BIGSERIAL PRIMARY KEY,
 action TEXT NOT NULL CHECK (action IN ('open_listing','inspect_active')),
 payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed')),
 result JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 claimed_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS extension_commands_pending_idx ON extension_commands(created_at) WHERE status='pending';