ALTER TABLE workspace_ai_config ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
INSERT INTO ai_capabilities(id,key) VALUES('00000000-0000-4000-8000-000000000060','financial-assistant') ON CONFLICT DO NOTHING;
INSERT INTO ai_capability_versions(id,capability_id,version,configuration) VALUES('00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000060',1,'{"promptVersion":1,"routing":"free-only","privacy":"no-training"}') ON CONFLICT DO NOTHING;
GRANT SELECT ON ai_capabilities,ai_capability_versions TO moneo_app;
--> statement-breakpoint
CREATE UNIQUE INDEX ai_runs_one_active_conversation ON ai_runs(workspace_id,conversation_id) WHERE status='running';
--> statement-breakpoint
ALTER TABLE conversations ADD CONSTRAINT conversations_workspace_id_unique UNIQUE(workspace_id,id);
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_workspace_id_unique UNIQUE(workspace_id,id);
ALTER TABLE messages ADD CONSTRAINT messages_tenant_conversation_fk FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id) ON DELETE CASCADE;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_tenant_conversation_fk FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id);
ALTER TABLE ai_model_calls ADD CONSTRAINT ai_model_calls_tenant_run_fk FOREIGN KEY(workspace_id,run_id) REFERENCES ai_runs(workspace_id,id) ON DELETE CASCADE;
ALTER TABLE ai_tool_calls ADD CONSTRAINT ai_tool_calls_tenant_run_fk FOREIGN KEY(workspace_id,run_id) REFERENCES ai_runs(workspace_id,id) ON DELETE CASCADE;
ALTER TABLE accounts ADD CONSTRAINT accounts_ai_workspace_id_unique UNIQUE(workspace_id,id);
ALTER TABLE workspace_ai_access_policies ADD CONSTRAINT ai_access_tenant_account_fk FOREIGN KEY(workspace_id,account_id) REFERENCES accounts(workspace_id,id) ON DELETE CASCADE;
