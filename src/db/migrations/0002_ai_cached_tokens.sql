-- Prompt-caching support in the AI usage ledger.
--
-- The Responses API reports `input_tokens` as the TOTAL input, with
-- `input_tokens_details.cached_tokens` being the subset served from cache.
-- Cached tokens are billed at a lower rate, so the ledger has to keep them
-- separately to compute real cost.
--
-- Existing rows default to 0 cached tokens, which is accurate: they were
-- recorded before caching was tracked, and pricing was not configured then
-- either, so their cost was already stored as 0.

ALTER TABLE ai_calls ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
