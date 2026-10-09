-- 0028_ai_actions (wave L, L1-1; owner W1): the AI usage ledger accepts any lowercase action name, so the
-- six wave L actions (recap, ask, command, diagram, sort, score) and any later one need no migration of
-- their own. Shipped migrations are never edited.
--
-- 0016_ai_usage's column CHECK listed the four actions of its day: summarize, themes, actions and ideas.
-- It becomes a pattern that every one of those still matches, so the previous api build (which inserts
-- only those four) runs unchanged on this schema: rolling the api back needs no down migration, only
-- DRAFTROOM_ALLOW_NEWER_SCHEMA=1 (docs/DEPLOY.md "Rollback"). The ALTER takes a brief lock on ai_usage, a
-- small table (one row per AI call), and validates its rows, all of which match the pattern.
--
-- Numbering: the plan reserved 0028 for wave K and named this 0029, but wave K shipped no migration, and
-- the runner refuses a migration numbered below the database's newest one ("renumber it"), so a 0028 left
-- free could never be applied after 0029. Contiguous is the safe choice.
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_action_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_action_check CHECK (action ~ '^[a-z][a-z_-]{0,31}$');
