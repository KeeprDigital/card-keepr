-- Pre-merge check for retiring Source Adapter Version parser code (ADR 0004).
--
-- Lists every non-terminal Ingestion Run whose Evidence Plan pins a retired
-- Source Adapter Version. The result must be empty before a retirement
-- merges: such a run can no longer capture or parse and must be terminated
-- and restarted under a live version (docs/runbooks/adapter-version-retirement.md).
--
-- The version list below must name exactly the versions registered in
-- src/catalogue/retired-source-adapter-versions.ts; the acceptance suite
-- asserts that.
SELECT run.id, run.state, plan.adapter_version
FROM ingestion_evidence_plans AS plan
JOIN ingestion_runs AS run ON run.id = plan.ingestion_run_id
WHERE run.state NOT IN ('published', 'rejected', 'expired', 'failed')
  AND plan.adapter_version IN (
    'one-piece-en@1',
    'one-piece-en@2',
    'one-piece-en@3',
    'one-piece-en@4',
    'fusion-world-en@2',
    'fusion-world-en@3',
    'fusion-world-en@4',
    'fusion-world-en@5',
    'fusion-world-en@6',
    'fusion-world-en@7',
    'digimon-en@2',
    'digimon-en@3',
    'digimon-en@4',
    'digimon-en@5',
    'gundam-en-asia@2',
    'gundam-en-asia@3',
    'gundam-en-asia@4',
    'gundam-en-asia@5',
    'gundam-en-us@2',
    'gundam-en-us@3',
    'gundam-en-us@4',
    'gundam-en-us@5'
  );
