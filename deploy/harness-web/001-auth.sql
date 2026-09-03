-- First installation only. Existing names fail closed; never adopt or overwrite a schema.
BEGIN;
CREATE ROLE tp_web_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE tp_web_account_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA harness_web;
REVOKE ALL ON SCHEMA harness_web FROM PUBLIC;

CREATE TABLE harness_web.accounts (
  id uuid PRIMARY KEY,
  username text UNIQUE NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt-v1[$]131072[$]8[$]1[$][0-9a-f]{32}[$][0-9a-f]{128}$'),
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE harness_web.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES harness_web.accounts(id),
  auth_version integer NOT NULL CHECK (auth_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour')
);
CREATE INDEX sessions_account_expiry ON harness_web.sessions(account_id, expires_at) WHERE revoked_at IS NULL;
CREATE TABLE harness_web.login_limits (
  bucket text PRIMARY KEY CHECK (bucket = 'global' OR bucket ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 61),
  reset_at timestamptz NOT NULL
);
CREATE INDEX login_limits_expiry ON harness_web.login_limits(reset_at);

REVOKE ALL ON ALL TABLES IN SCHEMA harness_web FROM PUBLIC;
GRANT USAGE ON SCHEMA harness_web TO tp_web_auth, tp_web_account_admin;
GRANT SELECT ON harness_web.accounts TO tp_web_auth;
GRANT SELECT, INSERT ON harness_web.sessions TO tp_web_auth;
GRANT UPDATE(revoked_at) ON harness_web.sessions TO tp_web_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_web.login_limits TO tp_web_auth;
GRANT SELECT, INSERT ON harness_web.accounts TO tp_web_account_admin;
GRANT UPDATE(password_hash, auth_version, disabled, updated_at) ON harness_web.accounts TO tp_web_account_admin;
GRANT CONNECT ON DATABASE tech_persistence TO tp_web_auth, tp_web_account_admin;
COMMIT;
