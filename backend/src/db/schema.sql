CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  external_ref text UNIQUE,
  matrix_user_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  customer_id uuid REFERENCES customers(id),
  room_id text UNIQUE,
  status text NOT NULL DEFAULT 'ai',
  assigned_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS agents (
  matrix_user_id text PRIMARY KEY,
  display_name text,
  max_concurrent int NOT NULL DEFAULT 3,
  online boolean NOT NULL DEFAULT false,
  last_seen timestamptz
);

-- customer profile supplied by the host web page (nullable: defaults are applied when reading)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
