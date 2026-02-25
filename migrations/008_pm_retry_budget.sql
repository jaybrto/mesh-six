-- migrations/008_pm_retry_budget.sql
-- Add retry budget tracking to pm_workflow_instances

ALTER TABLE pm_workflow_instances
  ADD COLUMN plan_cycles_used   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN qa_cycles_used     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN retry_budget       INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN failure_history    JSONB NOT NULL DEFAULT '[]';
