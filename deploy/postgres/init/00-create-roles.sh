#!/bin/sh
set -eu

# WHY: transcript ingestion and readback must not share a credential, and
# neither workload needs database ownership or schema creation privileges.
reader_password="$(cat /run/secrets/transcript_reader_password)"
writer_password="$(cat /run/secrets/transcript_writer_password)"

psql \
  --set=ON_ERROR_STOP=1 \
  --set=reader_password="$reader_password" \
  --set=writer_password="$writer_password" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
SELECT format(
  'CREATE ROLE transcript_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'reader_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transcript_reader')
\gexec

SELECT format(
  'CREATE ROLE transcript_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'writer_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transcript_writer')
\gexec

ALTER ROLE transcript_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'reader_password';
ALTER ROLE transcript_writer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'writer_password';
ALTER ROLE transcript_reader SET default_transaction_read_only = on;
ALTER ROLE transcript_reader SET statement_timeout = '15s';
ALTER ROLE transcript_writer SET statement_timeout = '60s';

REVOKE ALL ON DATABASE tech_persistence FROM PUBLIC;
GRANT CONNECT ON DATABASE tech_persistence TO transcript_reader, transcript_writer;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
