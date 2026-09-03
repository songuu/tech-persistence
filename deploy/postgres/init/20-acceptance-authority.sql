\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.acceptance_authority_records (
  authority_scope text NOT NULL CHECK (authority_scope ~ '^sha256:[0-9a-f]{64}$'),
  record_kind text NOT NULL CHECK (record_kind IN (
    'acceptance-receipt',
    'authority-canary',
    'artifact-seal',
    'cohort-tombstone',
    'expected-sample',
    'independent-review-seal',
    'readback-seal',
    'validation-seal'
  )),
  record_key text NOT NULL CHECK (record_key ~ '^sha256:[0-9a-f]{64}$'),
  contract_hash text CHECK (contract_hash IS NULL OR contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  subject_hash text CHECK (subject_hash IS NULL OR subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  record_hash text NOT NULL CHECK (record_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (authority_scope, record_kind, record_key)
);

ALTER TABLE public.acceptance_authority_records
  DROP CONSTRAINT IF EXISTS acceptance_authority_records_record_kind_check;
ALTER TABLE public.acceptance_authority_records
  ADD CONSTRAINT acceptance_authority_records_record_kind_check CHECK (record_kind IN (
    'acceptance-receipt',
    'authority-canary',
    'artifact-seal',
    'cohort-tombstone',
    'expected-sample',
    'independent-review-seal',
    'readback-seal',
    'validation-seal'
  ));

CREATE OR REPLACE FUNCTION public.reject_acceptance_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'acceptance authority records are immutable';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_acceptance_authority_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS acceptance_authority_records_immutable
  ON public.acceptance_authority_records;
CREATE TRIGGER acceptance_authority_records_immutable
BEFORE UPDATE OR DELETE ON public.acceptance_authority_records
FOR EACH ROW EXECUTE FUNCTION public.reject_acceptance_authority_mutation();

REVOKE ALL ON TABLE public.acceptance_authority_records FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO acceptance_reader, acceptance_writer;
GRANT SELECT ON TABLE public.acceptance_authority_records TO acceptance_reader;
GRANT INSERT ON TABLE public.acceptance_authority_records TO acceptance_writer;
GRANT SELECT (
  authority_scope,
  record_kind,
  record_key,
  record_hash
) ON TABLE public.acceptance_authority_records TO acceptance_writer;

COMMIT;
