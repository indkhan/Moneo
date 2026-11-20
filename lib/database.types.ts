
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "accounts": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"currency_code": string,"id": string,"name": string,"type": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"currency_code": string,"id"?: string,"name": string,"type"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"currency_code"?: string,"id"?: string,"name"?: string,"type"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "accounts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"agent_proposals": {
                  Row: {
                    "agent": string,"chat_request_id": string | null,"confidence": number,"conflict_key": string,"created_at": string,"decided_at": string | null,"detail": string,"evidence": NonNullable<Json>,"id": string,"kind": string,"notes": (string)[],"payload": NonNullable<Json>,"result": Json | null,"run_id": string | null,"status": string,"title": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent": string,"chat_request_id"?: string | null,"confidence"?: number,"conflict_key": string,"created_at"?: string,"decided_at"?: string | null,"detail"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"kind": string,"notes"?: (string)[],"payload"?: NonNullable<Json>,"result"?: Json | null,"run_id"?: string | null,"status"?: string,"title": string,"workspace_id": string
                  }
                  Update: {
                    "agent"?: string,"chat_request_id"?: string | null,"confidence"?: number,"conflict_key"?: string,"created_at"?: string,"decided_at"?: string | null,"detail"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"kind"?: string,"notes"?: (string)[],"payload"?: NonNullable<Json>,"result"?: Json | null,"run_id"?: string | null,"status"?: string,"title"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_proposals_chat_request_id_fkey"
      columns: ["chat_request_id"]
isOneToOne: false
      referencedRelation: "chat_requests"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_proposals_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "agent_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_proposals_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"agent_runs": {
                  Row: {
                    "briefing": string | null,"cancel_requested": boolean,"created_at": string,"data_fingerprint": string | null,"error": string | null,"finished_at": string | null,"id": string,"import_id": string | null,"model_budget": number,"model_calls": number,"model_status": string,"organize_after": string | null,"plan": NonNullable<Json>,"rerun_trigger": string | null,"status": string,"trigger": string,"updated_at": string,"workflow_run_id": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "briefing"?: string | null,"cancel_requested"?: boolean,"created_at"?: string,"data_fingerprint"?: string | null,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"import_id"?: string | null,"model_budget"?: number,"model_calls"?: number,"model_status"?: string,"organize_after"?: string | null,"plan"?: NonNullable<Json>,"rerun_trigger"?: string | null,"status"?: string,"trigger"?: string,"updated_at"?: string,"workflow_run_id"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "briefing"?: string | null,"cancel_requested"?: boolean,"created_at"?: string,"data_fingerprint"?: string | null,"error"?: string | null,"finished_at"?: string | null,"id"?: string,"import_id"?: string | null,"model_budget"?: number,"model_calls"?: number,"model_status"?: string,"organize_after"?: string | null,"plan"?: NonNullable<Json>,"rerun_trigger"?: string | null,"status"?: string,"trigger"?: string,"updated_at"?: string,"workflow_run_id"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_runs_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "imports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_runs_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"agent_tasks": {
                  Row: {
                    "agent": string,"events": NonNullable<Json>,"finished_at": string | null,"id": string,"position": number,"run_id": string,"started_at": string | null,"status": string,"step": string | null,"summary": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent": string,"events"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"position"?: number,"run_id": string,"started_at"?: string | null,"status"?: string,"step"?: string | null,"summary"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "agent"?: string,"events"?: NonNullable<Json>,"finished_at"?: string | null,"id"?: string,"position"?: number,"run_id"?: string,"started_at"?: string | null,"status"?: string,"step"?: string | null,"summary"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_tasks_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "agent_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_tasks_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"artifact_card_versions": {
                  Row: {
                    "card_id": string,"compiled": string,"created_at": string,"id": string,"kind": string,"model": string | null,"params": NonNullable<Json>,"preset": string | null,"prompt": string,"queries": NonNullable<Json>,"source": string,"title": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "card_id": string,"compiled": string,"created_at"?: string,"id"?: string,"kind": string,"model"?: string | null,"params"?: NonNullable<Json>,"preset"?: string | null,"prompt": string,"queries"?: NonNullable<Json>,"source": string,"title": string,"version": number,"workspace_id": string
                  }
                  Update: {
                    "card_id"?: string,"compiled"?: string,"created_at"?: string,"id"?: string,"kind"?: string,"model"?: string | null,"params"?: NonNullable<Json>,"preset"?: string | null,"prompt"?: string,"queries"?: NonNullable<Json>,"source"?: string,"title"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "artifact_card_versions_card_id_workspace_id_fkey"
      columns: ["card_id","workspace_id"]
isOneToOne: false
      referencedRelation: "artifact_cards"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "artifact_card_versions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"artifact_cards": {
                  Row: {
                    "artifact_id": string,"created_at": string,"deleted_at": string | null,"id": string,"published_version": number | null,"size": string,"title": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "artifact_id": string,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"published_version"?: number | null,"size"?: string,"title": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "artifact_id"?: string,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"published_version"?: number | null,"size"?: string,"title"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "artifact_cards_artifact_id_workspace_id_fkey"
      columns: ["artifact_id","workspace_id"]
isOneToOne: false
      referencedRelation: "artifacts"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "artifact_cards_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"artifact_versions": {
                  Row: {
                    "artifact_id": string,"created_at": string,"html": string,"id": string,"model": string | null,"prompt": string,"queries": NonNullable<Json>,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "artifact_id": string,"created_at"?: string,"html": string,"id"?: string,"model"?: string | null,"prompt": string,"queries"?: NonNullable<Json>,"version": number,"workspace_id": string
                  }
                  Update: {
                    "artifact_id"?: string,"created_at"?: string,"html"?: string,"id"?: string,"model"?: string | null,"prompt"?: string,"queries"?: NonNullable<Json>,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "artifact_versions_artifact_id_fkey"
      columns: ["artifact_id"]
isOneToOne: false
      referencedRelation: "artifacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "artifact_versions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"artifacts": {
                  Row: {
                    "created_at": string,"deleted_at": string | null,"first_prompt": string | null,"first_prompt_claimed_at": string | null,"id": string,"title": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"deleted_at"?: string | null,"first_prompt"?: string | null,"first_prompt_claimed_at"?: string | null,"id"?: string,"title": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"deleted_at"?: string | null,"first_prompt"?: string | null,"first_prompt_claimed_at"?: string | null,"id"?: string,"title"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "artifacts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"background_jobs": {
                  Row: {
                    "cancel_requested": boolean,"chat_request_id": string | null,"created_at": string,"dispatched_at": string | null,"error": string | null,"id": string,"kind": string,"request_id": string | null,"review_progress": Json | null,"review_request": Json | null,"stage": string,"status": string,"updated_at": string,"workflow_run_id": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cancel_requested"?: boolean,"chat_request_id"?: string | null,"created_at"?: string,"dispatched_at"?: string | null,"error"?: string | null,"id"?: string,"kind": string,"request_id"?: string | null,"review_progress"?: Json | null,"review_request"?: Json | null,"stage"?: string,"status"?: string,"updated_at"?: string,"workflow_run_id"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "cancel_requested"?: boolean,"chat_request_id"?: string | null,"created_at"?: string,"dispatched_at"?: string | null,"error"?: string | null,"id"?: string,"kind"?: string,"request_id"?: string | null,"review_progress"?: Json | null,"review_request"?: Json | null,"stage"?: string,"status"?: string,"updated_at"?: string,"workflow_run_id"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "background_jobs_chat_request_id_fkey"
      columns: ["chat_request_id"]
isOneToOne: false
      referencedRelation: "chat_requests"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "background_jobs_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"balance_snapshots": {
                  Row: {
                    "account_id": string,"actor_id": string | null,"amount_minor": number,"as_of": string,"balance_type": string | null,"boundary_kind": string,"command_input": Json | null,"covered_transactions": Json | null,"created_at": string,"currency_code": string,"id": string,"provenance": string,"source_transaction_id": string | null,"undone_at": string | null,"undone_by": string | null,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"actor_id"?: string | null,"amount_minor": number,"as_of": string,"balance_type"?: string | null,"boundary_kind"?: string,"command_input"?: Json | null,"covered_transactions"?: Json | null,"created_at"?: string,"currency_code": string,"id"?: string,"provenance": string,"source_transaction_id"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string,"actor_id"?: string | null,"amount_minor"?: number,"as_of"?: string,"balance_type"?: string | null,"boundary_kind"?: string,"command_input"?: Json | null,"covered_transactions"?: Json | null,"created_at"?: string,"currency_code"?: string,"id"?: string,"provenance"?: string,"source_transaction_id"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "balance_snapshots_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "balance_snapshots_source_transaction_id_fkey"
      columns: ["source_transaction_id"]
isOneToOne: false
      referencedRelation: "source_transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "balance_snapshots_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"bank_connection_accounts": {
                  Row: {
                    "account_name": string,"connection_id": string,"currency_code": string,"iban": string | null,"last_attempted_at": string | null,"last_booked_on": string | null,"last_error": string | null,"next_allowed_at": string | null,"provider_account_uid": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_name": string,"connection_id": string,"currency_code": string,"iban"?: string | null,"last_attempted_at"?: string | null,"last_booked_on"?: string | null,"last_error"?: string | null,"next_allowed_at"?: string | null,"provider_account_uid": string,"workspace_id": string
                  }
                  Update: {
                    "account_name"?: string,"connection_id"?: string,"currency_code"?: string,"iban"?: string | null,"last_attempted_at"?: string | null,"last_booked_on"?: string | null,"last_error"?: string | null,"next_allowed_at"?: string | null,"provider_account_uid"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_connection_accounts_connection_id_fkey"
      columns: ["connection_id"]
isOneToOne: false
      referencedRelation: "bank_connections"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bank_connection_accounts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"bank_connections": {
                  Row: {
                    "aspsp_country": string,"aspsp_name": string,"auth_state": string,"created_at": string,"id": string,"last_attempted_at": string | null,"last_error": string | null,"last_synced_at": string | null,"provider": string,"session_id_encrypted": string | null,"status": string,"sync_lease_token": string | null,"sync_lease_until": string | null,"sync_started_at": string | null,"valid_until": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "aspsp_country": string,"aspsp_name": string,"auth_state"?: string,"created_at"?: string,"id"?: string,"last_attempted_at"?: string | null,"last_error"?: string | null,"last_synced_at"?: string | null,"provider"?: string,"session_id_encrypted"?: string | null,"status"?: string,"sync_lease_token"?: string | null,"sync_lease_until"?: string | null,"sync_started_at"?: string | null,"valid_until"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "aspsp_country"?: string,"aspsp_name"?: string,"auth_state"?: string,"created_at"?: string,"id"?: string,"last_attempted_at"?: string | null,"last_error"?: string | null,"last_synced_at"?: string | null,"provider"?: string,"session_id_encrypted"?: string | null,"status"?: string,"sync_lease_token"?: string | null,"sync_lease_until"?: string | null,"sync_started_at"?: string | null,"valid_until"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_connections_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"bank_transaction_raw": {
                  Row: {
                    "bank_code": string | null,"bank_id": string | null,"bank_sub_code": string | null,"counterparty_bic": string | null,"counterparty_iban": string | null,"counterparty_ids": NonNullable<Json>,"counterparty_name": string | null,"created_at": string,"creditor_id": string | null,"exchange_rate": string | null,"import_id": string,"instructed_amount": string | null,"instructed_currency": string | null,"mandate_ref": string | null,"mcc": string | null,"own_account": boolean,"own_side_ids": NonNullable<Json>,"payment_type": string,"raw": NonNullable<Json>,"row_number": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "bank_code"?: string | null,"bank_id"?: string | null,"bank_sub_code"?: string | null,"counterparty_bic"?: string | null,"counterparty_iban"?: string | null,"counterparty_ids"?: NonNullable<Json>,"counterparty_name"?: string | null,"created_at"?: string,"creditor_id"?: string | null,"exchange_rate"?: string | null,"import_id": string,"instructed_amount"?: string | null,"instructed_currency"?: string | null,"mandate_ref"?: string | null,"mcc"?: string | null,"own_account"?: boolean,"own_side_ids"?: NonNullable<Json>,"payment_type"?: string,"raw"?: NonNullable<Json>,"row_number": number,"workspace_id": string
                  }
                  Update: {
                    "bank_code"?: string | null,"bank_id"?: string | null,"bank_sub_code"?: string | null,"counterparty_bic"?: string | null,"counterparty_iban"?: string | null,"counterparty_ids"?: NonNullable<Json>,"counterparty_name"?: string | null,"created_at"?: string,"creditor_id"?: string | null,"exchange_rate"?: string | null,"import_id"?: string,"instructed_amount"?: string | null,"instructed_currency"?: string | null,"mandate_ref"?: string | null,"mcc"?: string | null,"own_account"?: boolean,"own_side_ids"?: NonNullable<Json>,"payment_type"?: string,"raw"?: NonNullable<Json>,"row_number"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_transaction_raw_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "imports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bank_transaction_raw_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"categories": {
                  Row: {
                    "created_by": string,"id": string,"name": string,"owner_touched": boolean,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_by"?: string,"id"?: string,"name": string,"owner_touched"?: boolean,"workspace_id": string
                  }
                  Update: {
                    "created_by"?: string,"id"?: string,"name"?: string,"owner_touched"?: boolean,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "categories_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"chat_requests": {
                  Row: {
                    "action_result": Json | null,"allowed_category": string | null,"allowed_transaction_id": string | null,"answer": string | null,"context": NonNullable<Json>,"conversation_id": string,"created_at": string,"error": string | null,"id": string,"message": string,"regenerates": string | null,"status": string,"tool_calls": Json | null,"updated_at": string,"usage": Json | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action_result"?: Json | null,"allowed_category"?: string | null,"allowed_transaction_id"?: string | null,"answer"?: string | null,"context"?: NonNullable<Json>,"conversation_id": string,"created_at"?: string,"error"?: string | null,"id": string,"message": string,"regenerates"?: string | null,"status"?: string,"tool_calls"?: Json | null,"updated_at"?: string,"usage"?: Json | null,"workspace_id": string
                  }
                  Update: {
                    "action_result"?: Json | null,"allowed_category"?: string | null,"allowed_transaction_id"?: string | null,"answer"?: string | null,"context"?: NonNullable<Json>,"conversation_id"?: string,"created_at"?: string,"error"?: string | null,"id"?: string,"message"?: string,"regenerates"?: string | null,"status"?: string,"tool_calls"?: Json | null,"updated_at"?: string,"usage"?: Json | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "chat_requests_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "chat_requests_regenerates_fkey"
      columns: ["regenerates"]
isOneToOne: false
      referencedRelation: "chat_requests"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "chat_requests_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"chat_steers": {
                  Row: {
                    "chat_request_id": string,"closed_at": string | null,"consumed_at": string | null,"content": string,"created_at": string,"id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "chat_request_id": string,"closed_at"?: string | null,"consumed_at"?: string | null,"content": string,"created_at"?: string,"id": string,"workspace_id": string
                  }
                  Update: {
                    "chat_request_id"?: string,"closed_at"?: string | null,"consumed_at"?: string | null,"content"?: string,"created_at"?: string,"id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "chat_steers_chat_request_id_fkey"
      columns: ["chat_request_id"]
isOneToOne: false
      referencedRelation: "chat_requests"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "chat_steers_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"conversations": {
                  Row: {
                    "artifact_id": string | null,"created_at": string,"deleted_at": string | null,"id": string,"title": string,"title_settled": boolean,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "artifact_id"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"title": string,"title_settled"?: boolean,"workspace_id": string
                  }
                  Update: {
                    "artifact_id"?: string | null,"created_at"?: string,"deleted_at"?: string | null,"id"?: string,"title"?: string,"title_settled"?: boolean,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversations_artifact_fkey"
      columns: ["artifact_id","workspace_id"]
isOneToOne: false
      referencedRelation: "artifacts"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "conversations_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"correction_events": {
                  Row: {
                    "actor_id": string,"after": NonNullable<Json>,"before": NonNullable<Json>,"created_at": string,"id": string,"origin": string,"transaction_id": string,"undone": boolean,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"after": NonNullable<Json>,"before": NonNullable<Json>,"created_at"?: string,"id"?: string,"origin"?: string,"transaction_id": string,"undone"?: boolean,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"after"?: NonNullable<Json>,"before"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"origin"?: string,"transaction_id"?: string,"undone"?: boolean,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "correction_events_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "correction_events_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "correction_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"dashboard_layouts": {
                  Row: {
                    "items": (string)[],"sizes": NonNullable<Json>,"updated_at": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "items": (string)[],"sizes"?: NonNullable<Json>,"updated_at"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "items"?: (string)[],"sizes"?: NonNullable<Json>,"updated_at"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "dashboard_layouts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: true
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"data_sources": {
                  Row: {
                    "account_id": string | null,"created_at": string,"id": string,"kind": string,"name": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id"?: string | null,"created_at"?: string,"id"?: string,"kind": string,"name": string,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"name"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "data_sources_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "data_sources_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"financial_assumptions": {
                  Row: {
                    "account_id": string | null,"amount_minor": number,"cadence": string,"category_id": string | null,"confidence": number | null,"confirmed": boolean,"created_at": string,"currency_code": string,"enabled": boolean,"ends_on": string | null,"id": string,"kind": string,"name": string,"recurring_evidence_eligible": boolean,"removed_at": string | null,"schedule_anchor_on": string | null,"source": string,"starts_on": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id"?: string | null,"amount_minor": number,"cadence": string,"category_id"?: string | null,"confidence"?: number | null,"confirmed"?: boolean,"created_at"?: string,"currency_code": string,"enabled"?: boolean,"ends_on"?: string | null,"id"?: string,"kind": string,"name": string,"recurring_evidence_eligible"?: boolean,"removed_at"?: string | null,"schedule_anchor_on"?: string | null,"source": string,"starts_on": string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string | null,"amount_minor"?: number,"cadence"?: string,"category_id"?: string | null,"confidence"?: number | null,"confirmed"?: boolean,"created_at"?: string,"currency_code"?: string,"enabled"?: boolean,"ends_on"?: string | null,"id"?: string,"kind"?: string,"name"?: string,"recurring_evidence_eligible"?: boolean,"removed_at"?: string | null,"schedule_anchor_on"?: string | null,"source"?: string,"starts_on"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "financial_assumptions_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "financial_assumptions_category_fkey"
      columns: ["category_id","workspace_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "financial_assumptions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"financial_evidence_receipts": {
                  Row: {
                    "created_at": string,"id": string,"receipt": NonNullable<Json>,"scopes": (string)[],"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id": string,"receipt": NonNullable<Json>,"scopes": (string)[],"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"receipt"?: NonNullable<Json>,"scopes"?: (string)[],"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "financial_evidence_receipts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"forecast_preference_events": {
                  Row: {
                    "actor_id": string,"after": NonNullable<Json>,"before": Json | null,"created_at": string,"id": string,"request_id": string,"undo_of": string | null,"undone_at": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"after": NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"id"?: string,"request_id": string,"undo_of"?: string | null,"undone_at"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"after"?: NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"id"?: string,"request_id"?: string,"undo_of"?: string | null,"undone_at"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "forecast_preference_events_undo_of_fkey"
      columns: ["undo_of"]
isOneToOne: false
      referencedRelation: "forecast_preference_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "forecast_preference_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"forecast_preferences": {
                  Row: {
                    "currency_code": string,"daily_spending_minor": number,"safety_buffer_minor": number,"spending_account_id": string | null,"spending_starts_on": string | null,"uncertainty_bps": number,"updated_at": string,"version": number,"workspace_id": string,"forecast_preference_record": Json | null
                  }
                  ComputedFields: "forecast_preference_record"
                  Insert: {
                    "currency_code": string,"daily_spending_minor"?: number,"safety_buffer_minor"?: number,"spending_account_id"?: string | null,"spending_starts_on"?: string | null,"uncertainty_bps"?: number,"updated_at"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "currency_code"?: string,"daily_spending_minor"?: number,"safety_buffer_minor"?: number,"spending_account_id"?: string | null,"spending_starts_on"?: string | null,"uncertainty_bps"?: number,"updated_at"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "forecast_preferences_spending_account_id_fkey"
      columns: ["spending_account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "forecast_preferences_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: true
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"forecast_runs": {
                  Row: {
                    "created_at": string,"horizon_end": string,"horizon_start": string,"id": string,"inputs": NonNullable<Json>,"result": NonNullable<Json>,"scenario_id": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"horizon_end": string,"horizon_start": string,"id"?: string,"inputs": NonNullable<Json>,"result": NonNullable<Json>,"scenario_id"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"horizon_end"?: string,"horizon_start"?: string,"id"?: string,"inputs"?: NonNullable<Json>,"result"?: NonNullable<Json>,"scenario_id"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "forecast_runs_scenario_id_fkey"
      columns: ["scenario_id"]
isOneToOne: false
      referencedRelation: "scenarios"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "forecast_runs_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"fx_rates": {
                  Row: {
                    "created_at": string,"from_currency": string,"id": string,"rate_date": string,"rate_text": string,"source": string,"to_currency": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"from_currency": string,"id"?: string,"rate_date": string,"rate_text": string,"source": string,"to_currency": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"from_currency"?: string,"id"?: string,"rate_date"?: string,"rate_text"?: string,"source"?: string,"to_currency"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "fx_rates_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"goal_allocations": {
                  Row: {
                    "account_id": string,"amount_minor": number,"goal_id": string,"id": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"amount_minor": number,"goal_id": string,"id"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string,"amount_minor"?: number,"goal_id"?: string,"id"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "goal_allocations_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_allocations_goal_id_fkey"
      columns: ["goal_id"]
isOneToOne: false
      referencedRelation: "goals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_allocations_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"goal_events": {
                  Row: {
                    "actor_id": string | null,"after": NonNullable<Json>,"before": Json | null,"created_at": string,"goal_id": string,"id": string,"request_id": string | null,"undone": boolean,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"after": NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"goal_id": string,"id"?: string,"request_id"?: string | null,"undone"?: boolean,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string | null,"after"?: NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"goal_id"?: string,"id"?: string,"request_id"?: string | null,"undone"?: boolean,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "goal_events_goal_id_fkey"
      columns: ["goal_id"]
isOneToOne: false
      referencedRelation: "goals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"goal_reservation_events": {
                  Row: {
                    "actor_id": string,"after": NonNullable<Json>,"allocation_id": string,"before": NonNullable<Json>,"created_at": string,"id": string,"request_id": string,"undo_of": string | null,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"after": NonNullable<Json>,"allocation_id": string,"before": NonNullable<Json>,"created_at"?: string,"id"?: string,"request_id": string,"undo_of"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"after"?: NonNullable<Json>,"allocation_id"?: string,"before"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"request_id"?: string,"undo_of"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "goal_reservation_events_allocation_id_fkey"
      columns: ["allocation_id"]
isOneToOne: false
      referencedRelation: "goal_allocations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_reservation_events_undo_of_fkey"
      columns: ["undo_of"]
isOneToOne: false
      referencedRelation: "goal_reservation_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_reservation_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"goals": {
                  Row: {
                    "contribution_starts_on": string | null,"created_at": string,"currency_code": string,"id": string,"idempotency_key": string | null,"name": string,"notes": string | null,"planned_monthly_minor": number,"priority": number,"recorded_saved_minor": number | null,"saved_as_of": string | null,"status": string,"target_date": string | null,"target_minor": number,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contribution_starts_on"?: string | null,"created_at"?: string,"currency_code": string,"id"?: string,"idempotency_key"?: string | null,"name": string,"notes"?: string | null,"planned_monthly_minor"?: number,"priority"?: number,"recorded_saved_minor"?: number | null,"saved_as_of"?: string | null,"status"?: string,"target_date"?: string | null,"target_minor": number,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "contribution_starts_on"?: string | null,"created_at"?: string,"currency_code"?: string,"id"?: string,"idempotency_key"?: string | null,"name"?: string,"notes"?: string | null,"planned_monthly_minor"?: number,"priority"?: number,"recorded_saved_minor"?: number | null,"saved_as_of"?: string | null,"status"?: string,"target_date"?: string | null,"target_minor"?: number,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "goals_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"import_control_events": {
                  Row: {
                    "action": string,"actor_id": string,"created_at": string,"id": string,"import_id": string,"request_id": string,"result": NonNullable<Json>,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id": string,"created_at"?: string,"id"?: string,"import_id": string,"request_id": string,"result": NonNullable<Json>,"workspace_id": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string,"created_at"?: string,"id"?: string,"import_id"?: string,"request_id"?: string,"result"?: NonNullable<Json>,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_control_events_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "imports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_control_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"import_row_decisions": {
                  Row: {
                    "action": string,"actor_id": string | null,"balance_records": NonNullable<Json>,"created_at": string,"id": string,"source_id": string,"source_record": NonNullable<Json>,"transaction_record": Json | null,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"balance_records"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"source_id": string,"source_record": NonNullable<Json>,"transaction_record"?: Json | null,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"balance_records"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"source_id"?: string,"source_record"?: NonNullable<Json>,"transaction_record"?: Json | null,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_row_decisions_source_id_fkey"
      columns: ["source_id"]
isOneToOne: false
      referencedRelation: "source_transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_row_decisions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"import_staging": {
                  Row: {
                    "created_at": string,"file_hash": string,"import_id": string,"mapping": NonNullable<Json>,"route_accounts": NonNullable<Json>,"rows": NonNullable<Json>,"stage_version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"file_hash": string,"import_id": string,"mapping": NonNullable<Json>,"route_accounts": NonNullable<Json>,"rows": NonNullable<Json>,"stage_version": number,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"file_hash"?: string,"import_id"?: string,"mapping"?: NonNullable<Json>,"route_accounts"?: NonNullable<Json>,"rows"?: NonNullable<Json>,"stage_version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_staging_import_id_fkey"
      columns: ["import_id"]
isOneToOne: true
      referencedRelation: "imports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_staging_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"imports": {
                  Row: {
                    "classification_review_rows": number,"created_at": string,"error": string | null,"file_hash": string,"filename": string,"id": string,"mapping": Json | null,"matched_rows": number,"new_rows": number,"rejected_rows": number,"review_rows": number,"route_accounts": NonNullable<Json>,"run_version": number,"source_id": string | null,"status": string,"storage_path": string,"total_rows": number,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "classification_review_rows"?: number,"created_at"?: string,"error"?: string | null,"file_hash": string,"filename": string,"id"?: string,"mapping"?: Json | null,"matched_rows"?: number,"new_rows"?: number,"rejected_rows"?: number,"review_rows"?: number,"route_accounts"?: NonNullable<Json>,"run_version"?: number,"source_id"?: string | null,"status"?: string,"storage_path": string,"total_rows"?: number,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "classification_review_rows"?: number,"created_at"?: string,"error"?: string | null,"file_hash"?: string,"filename"?: string,"id"?: string,"mapping"?: Json | null,"matched_rows"?: number,"new_rows"?: number,"rejected_rows"?: number,"review_rows"?: number,"route_accounts"?: NonNullable<Json>,"run_version"?: number,"source_id"?: string | null,"status"?: string,"storage_path"?: string,"total_rows"?: number,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "imports_source_id_fkey"
      columns: ["source_id"]
isOneToOne: false
      referencedRelation: "data_sources"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "imports_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"insight_dismissals": {
                  Row: {
                    "created_at": string,"evidence_key": string,"insight_type": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"evidence_key": string,"insight_type": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"evidence_key"?: string,"insight_type"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "insight_dismissals_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"insight_preferences": {
                  Row: {
                    "currency_code": string,"important_only": boolean,"max_items": number,"minimum_change_minor": number,"upcoming_days": number,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "currency_code"?: string,"important_only"?: boolean,"max_items"?: number,"minimum_change_minor"?: number,"upcoming_days"?: number,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "currency_code"?: string,"important_only"?: boolean,"max_items"?: number,"minimum_change_minor"?: number,"upcoming_days"?: number,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "insight_preferences_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: true
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"iou_repayments": {
                  Row: {
                    "actor_id": string | null,"applied_minor": number,"created_at": string,"currency_code": string,"id": string,"item_id": string,"request_id": string,"transaction_amount_minor": number,"transaction_id": string | null,"transaction_posted_on": string,"undone_at": string | null,"wealth_event_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"applied_minor": number,"created_at"?: string,"currency_code": string,"id"?: string,"item_id": string,"request_id": string,"transaction_amount_minor": number,"transaction_id"?: string | null,"transaction_posted_on": string,"undone_at"?: string | null,"wealth_event_id": string,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string | null,"applied_minor"?: number,"created_at"?: string,"currency_code"?: string,"id"?: string,"item_id"?: string,"request_id"?: string,"transaction_amount_minor"?: number,"transaction_id"?: string | null,"transaction_posted_on"?: string,"undone_at"?: string | null,"wealth_event_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "iou_repayments_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "wealth_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "iou_repayments_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "iou_repayments_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "iou_repayments_wealth_event_id_fkey"
      columns: ["wealth_event_id"]
isOneToOne: false
      referencedRelation: "wealth_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "iou_repayments_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"manual_transaction_entries": {
                  Row: {
                    "actor_id": string,"created_at": string,"id": string,"original_record": NonNullable<Json>,"request_id": string,"transaction_id": string | null,"undone_at": string | null,"undone_by": string | null,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"created_at"?: string,"id"?: string,"original_record": NonNullable<Json>,"request_id": string,"transaction_id"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"created_at"?: string,"id"?: string,"original_record"?: NonNullable<Json>,"request_id"?: string,"transaction_id"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "manual_transaction_entries_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "manual_transaction_entries_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "manual_transaction_entries_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"memories": {
                  Row: {
                    "closed_at": string | null,"conversation_id": string | null,"created_at": string,"ended_on": string | null,"id": string,"kind": string,"quote": string | null,"replaces": string | null,"request_id": string | null,"saved_by": string,"search": unknown,"statement": string,"status": string,"valid_from": string | null,"valid_until": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "closed_at"?: string | null,"conversation_id"?: string | null,"created_at"?: string,"ended_on"?: string | null,"id"?: string,"kind": string,"quote"?: string | null,"replaces"?: string | null,"request_id"?: string | null,"saved_by": string,"search"?: never,"statement": string,"status"?: string,"valid_from"?: string | null,"valid_until"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "closed_at"?: string | null,"conversation_id"?: string | null,"created_at"?: string,"ended_on"?: string | null,"id"?: string,"kind"?: string,"quote"?: string | null,"replaces"?: string | null,"request_id"?: string | null,"saved_by"?: string,"search"?: never,"statement"?: string,"status"?: string,"valid_from"?: string | null,"valid_until"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memories_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "memories_replaces_fkey"
      columns: ["replaces"]
isOneToOne: false
      referencedRelation: "memories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "memories_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"merchants": {
                  Row: {
                    "created_at": string,"created_by": string,"id": string,"name": string,"normalized_name": string,"owner_touched": boolean,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string,"id"?: string,"name": string,"normalized_name": string,"owner_touched"?: boolean,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"id"?: string,"name"?: string,"normalized_name"?: string,"owner_touched"?: boolean,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "merchants_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"messages": {
                  Row: {
                    "answer_of": string | null,"attachments": NonNullable<Json>,"content": string,"context": Json | null,"conversation_id": string,"created_at": string,"id": string,"reply_to": string | null,"request_id": string | null,"role": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "answer_of"?: string | null,"attachments"?: NonNullable<Json>,"content": string,"context"?: Json | null,"conversation_id": string,"created_at"?: string,"id"?: string,"reply_to"?: string | null,"request_id"?: string | null,"role": string,"workspace_id": string
                  }
                  Update: {
                    "answer_of"?: string | null,"attachments"?: NonNullable<Json>,"content"?: string,"context"?: Json | null,"conversation_id"?: string,"created_at"?: string,"id"?: string,"reply_to"?: string | null,"request_id"?: string | null,"role"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"money_metadata_events": {
                  Row: {
                    "actor_id": string,"after": NonNullable<Json>,"before": NonNullable<Json>,"created_at": string,"entity_id": string,"entity_type": string,"id": string,"input": NonNullable<Json>,"request_id": string,"undo_of": string | null,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"after": NonNullable<Json>,"before": NonNullable<Json>,"created_at"?: string,"entity_id": string,"entity_type": string,"id"?: string,"input": NonNullable<Json>,"request_id": string,"undo_of"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"after"?: NonNullable<Json>,"before"?: NonNullable<Json>,"created_at"?: string,"entity_id"?: string,"entity_type"?: string,"id"?: string,"input"?: NonNullable<Json>,"request_id"?: string,"undo_of"?: string | null,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "money_metadata_events_undo_of_fkey"
      columns: ["undo_of"]
isOneToOne: false
      referencedRelation: "money_metadata_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "money_metadata_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"organization_reviews": {
                  Row: {
                    "actor_id": string,"batch_id": string | null,"created_at": string,"evidence": NonNullable<Json>,"id": string,"merchant_name": string | null,"patch": NonNullable<Json>,"request_id": string,"rule_key": string | null,"rule_version": number,"saved_rule_after": Json | null,"saved_rule_before": Json | null,"saved_rule_id": string | null,"selection": NonNullable<Json>,"snapshots": NonNullable<Json>,"status": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"batch_id"?: string | null,"created_at"?: string,"evidence": NonNullable<Json>,"id"?: string,"merchant_name"?: string | null,"patch": NonNullable<Json>,"request_id": string,"rule_key"?: string | null,"rule_version"?: number,"saved_rule_after"?: Json | null,"saved_rule_before"?: Json | null,"saved_rule_id"?: string | null,"selection": NonNullable<Json>,"snapshots": NonNullable<Json>,"status"?: string,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"batch_id"?: string | null,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"merchant_name"?: string | null,"patch"?: NonNullable<Json>,"request_id"?: string,"rule_key"?: string | null,"rule_version"?: number,"saved_rule_after"?: Json | null,"saved_rule_before"?: Json | null,"saved_rule_id"?: string | null,"selection"?: NonNullable<Json>,"snapshots"?: NonNullable<Json>,"status"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organization_reviews_batch_id_fkey"
      columns: ["batch_id"]
isOneToOne: false
      referencedRelation: "transaction_batches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organization_reviews_saved_rule_id_fkey"
      columns: ["saved_rule_id"]
isOneToOne: false
      referencedRelation: "organization_rules"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organization_reviews_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"organization_rules": {
                  Row: {
                    "approved_by": string,"category_id": string | null,"description_key": string,"enabled": boolean,"id": string,"merchant_id": string | null,"updated_at": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_by": string,"category_id"?: string | null,"description_key": string,"enabled"?: boolean,"id"?: string,"merchant_id"?: string | null,"updated_at"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "approved_by"?: string,"category_id"?: string | null,"description_key"?: string,"enabled"?: boolean,"id"?: string,"merchant_id"?: string | null,"updated_at"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organization_rules_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organization_rules_merchant_id_fkey"
      columns: ["merchant_id"]
isOneToOne: false
      referencedRelation: "merchants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organization_rules_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"organize_identities": {
                  Row: {
                    "created_at": string,"created_by": string,"display_name": string,"id": string,"kind": string,"merchant_id": string | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string,"display_name": string,"id"?: string,"kind": string,"merchant_id"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"display_name"?: string,"id"?: string,"kind"?: string,"merchant_id"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organize_identities_merchant_id_fkey"
      columns: ["merchant_id"]
isOneToOne: false
      referencedRelation: "merchants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organize_identities_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"organize_identity_aliases": {
                  Row: {
                    "alias_type": string,"created_at": string,"id": string,"identity_id": string,"value": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "alias_type": string,"created_at"?: string,"id"?: string,"identity_id": string,"value": string,"workspace_id": string
                  }
                  Update: {
                    "alias_type"?: string,"created_at"?: string,"id"?: string,"identity_id"?: string,"value"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organize_identity_aliases_identity_id_fkey"
      columns: ["identity_id"]
isOneToOne: false
      referencedRelation: "organize_identities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organize_identity_aliases_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"organize_memory": {
                  Row: {
                    "category_id": string | null,"confirmed_at": string | null,"created_at": string,"id": string,"identity_id": string,"merchant_id": string | null,"purpose": string | null,"source": string,"suppressed": NonNullable<Json>,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id"?: string | null,"confirmed_at"?: string | null,"created_at"?: string,"id"?: string,"identity_id": string,"merchant_id"?: string | null,"purpose"?: string | null,"source": string,"suppressed"?: NonNullable<Json>,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "category_id"?: string | null,"confirmed_at"?: string | null,"created_at"?: string,"id"?: string,"identity_id"?: string,"merchant_id"?: string | null,"purpose"?: string | null,"source"?: string,"suppressed"?: NonNullable<Json>,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organize_memory_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organize_memory_identity_id_fkey"
      columns: ["identity_id"]
isOneToOne: false
      referencedRelation: "organize_identities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organize_memory_merchant_id_fkey"
      columns: ["merchant_id"]
isOneToOne: false
      referencedRelation: "merchants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organize_memory_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"organize_questions": {
                  Row: {
                    "answer": Json | null,"answered_at": string | null,"created_at": string,"created_by": string,"id": string,"identity_id": string | null,"identity_key": string,"question": string,"status": string,"transaction_ids": (string)[],"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "answer"?: Json | null,"answered_at"?: string | null,"created_at"?: string,"created_by": string,"id"?: string,"identity_id"?: string | null,"identity_key": string,"question": string,"status"?: string,"transaction_ids"?: (string)[],"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "answer"?: Json | null,"answered_at"?: string | null,"created_at"?: string,"created_by"?: string,"id"?: string,"identity_id"?: string | null,"identity_key"?: string,"question"?: string,"status"?: string,"transaction_ids"?: (string)[],"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organize_questions_identity_id_fkey"
      columns: ["identity_id"]
isOneToOne: false
      referencedRelation: "organize_identities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organize_questions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"organizer_ops": {
                  Row: {
                    "after": NonNullable<Json>,"before": NonNullable<Json>,"category_id": string | null,"created_at": string,"id": string,"identity_key": string,"merchant_id": string | null,"proposal_id": string | null,"run_id": string | null,"suppressed": boolean,"transaction_id": string,"undone_at": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "after": NonNullable<Json>,"before": NonNullable<Json>,"category_id"?: string | null,"created_at"?: string,"id"?: string,"identity_key": string,"merchant_id"?: string | null,"proposal_id"?: string | null,"run_id"?: string | null,"suppressed"?: boolean,"transaction_id": string,"undone_at"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "after"?: NonNullable<Json>,"before"?: NonNullable<Json>,"category_id"?: string | null,"created_at"?: string,"id"?: string,"identity_key"?: string,"merchant_id"?: string | null,"proposal_id"?: string | null,"run_id"?: string | null,"suppressed"?: boolean,"transaction_id"?: string,"undone_at"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organizer_ops_proposal_id_fkey"
      columns: ["proposal_id"]
isOneToOne: false
      referencedRelation: "agent_proposals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organizer_ops_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "agent_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organizer_ops_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organizer_ops_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organizer_ops_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"own_account_identifiers": {
                  Row: {
                    "account_id": string | null,"confirmed": boolean,"created_at": string,"iban": string | null,"id": string,"label": string,"name_key": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id"?: string | null,"confirmed"?: boolean,"created_at"?: string,"iban"?: string | null,"id"?: string,"label": string,"name_key"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string | null,"confirmed"?: boolean,"created_at"?: string,"iban"?: string | null,"id"?: string,"label"?: string,"name_key"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "own_account_identifiers_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "own_account_identifiers_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"pending_hold_resolutions": {
                  Row: {
                    "actor_id": string,"created_at": string,"id": string,"input": NonNullable<Json>,"note": string,"operation": string,"pending_transaction_id": string | null,"posted_transaction_id": string | null,"receipt": NonNullable<Json>,"released_minor": number,"request_id": string,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"created_at"?: string,"id"?: string,"input": NonNullable<Json>,"note": string,"operation": string,"pending_transaction_id"?: string | null,"posted_transaction_id"?: string | null,"receipt": NonNullable<Json>,"released_minor": number,"request_id": string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"created_at"?: string,"id"?: string,"input"?: NonNullable<Json>,"note"?: string,"operation"?: string,"pending_transaction_id"?: string | null,"posted_transaction_id"?: string | null,"receipt"?: NonNullable<Json>,"released_minor"?: number,"request_id"?: string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pending_hold_resolutions_pending_transaction_id_fkey"
      columns: ["pending_transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pending_hold_resolutions_pending_transaction_id_fkey"
      columns: ["pending_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pending_hold_resolutions_posted_transaction_id_fkey"
      columns: ["posted_transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pending_hold_resolutions_posted_transaction_id_fkey"
      columns: ["posted_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pending_hold_resolutions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"planning_events": {
                  Row: {
                    "actor_id": string | null,"after": Json | null,"before": Json | null,"created_at": string,"entity_id": string,"entity_type": string,"id": string,"request_id": string | null,"undone": boolean,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"after"?: Json | null,"before"?: Json | null,"created_at"?: string,"entity_id": string,"entity_type": string,"id"?: string,"request_id"?: string | null,"undone"?: boolean,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string | null,"after"?: Json | null,"before"?: Json | null,"created_at"?: string,"entity_id"?: string,"entity_type"?: string,"id"?: string,"request_id"?: string | null,"undone"?: boolean,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "planning_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"recurring_occurrence_settlements": {
                  Row: {
                    "actor_id": string,"assumption_id": string,"completes_occurrence": boolean,"created_at": string,"id": string,"receipt": NonNullable<Json>,"scheduled_on": string,"transaction_id": string,"undone_at": string | null,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"assumption_id": string,"completes_occurrence": boolean,"created_at"?: string,"id"?: string,"receipt": NonNullable<Json>,"scheduled_on": string,"transaction_id": string,"undone_at"?: string | null,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"assumption_id"?: string,"completes_occurrence"?: boolean,"created_at"?: string,"id"?: string,"receipt"?: NonNullable<Json>,"scheduled_on"?: string,"transaction_id"?: string,"undone_at"?: string | null,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "recurring_occurrence_settlements_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"recurring_series": {
                  Row: {
                    "account_id": string,"amount_max_minor": number,"amount_min_minor": number,"assumption_id": string | null,"assumption_restore": Json | null,"cadence": string,"confidence": number | null,"created_at": string,"currency_code": string,"evidence_baseline": Json | null,"evidence_invalidated": boolean,"id": string,"invalidated_assumption_version": number | null,"label": string,"merchant_identity": string | null,"normalized_label": string,"occurrences": number,"run_anchor_id": string | null,"status": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"amount_max_minor": number,"amount_min_minor": number,"assumption_id"?: string | null,"assumption_restore"?: Json | null,"cadence": string,"confidence"?: number | null,"created_at"?: string,"currency_code": string,"evidence_baseline"?: Json | null,"evidence_invalidated"?: boolean,"id"?: string,"invalidated_assumption_version"?: number | null,"label": string,"merchant_identity"?: string | null,"normalized_label": string,"occurrences": number,"run_anchor_id"?: string | null,"status"?: string,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string,"amount_max_minor"?: number,"amount_min_minor"?: number,"assumption_id"?: string | null,"assumption_restore"?: Json | null,"cadence"?: string,"confidence"?: number | null,"created_at"?: string,"currency_code"?: string,"evidence_baseline"?: Json | null,"evidence_invalidated"?: boolean,"id"?: string,"invalidated_assumption_version"?: number | null,"label"?: string,"merchant_identity"?: string | null,"normalized_label"?: string,"occurrences"?: number,"run_anchor_id"?: string | null,"status"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "recurring_series_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recurring_series_assumption_id_fkey"
      columns: ["assumption_id"]
isOneToOne: false
      referencedRelation: "financial_assumptions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recurring_series_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"recurring_series_transactions": {
                  Row: {
                    "series_id": string,"transaction_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "series_id": string,"transaction_id": string,"workspace_id": string
                  }
                  Update: {
                    "series_id"?: string,"transaction_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "recurring_series_transactions_series_id_fkey"
      columns: ["series_id"]
isOneToOne: false
      referencedRelation: "recurring_series"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recurring_series_transactions_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recurring_series_transactions_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recurring_series_transactions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"saved_analyses": {
                  Row: {
                    "body": string,"created_at": string,"evidence": NonNullable<Json>,"id": string,"job_id": string,"title": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"created_at"?: string,"evidence": NonNullable<Json>,"id"?: string,"job_id": string,"title": string,"workspace_id": string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"job_id"?: string,"title"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "saved_analyses_job_id_fkey"
      columns: ["job_id"]
isOneToOne: true
      referencedRelation: "background_jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "saved_analyses_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scalable_connections": {
                  Row: {
                    "auth_state": string,"client_id": string,"created_at": string,"history_checked_on": string | null,"history_error": string | null,"history_status": string | null,"id": string,"last_error": string | null,"last_synced_at": string | null,"pkce_verifier_encrypted": string | null,"portfolio": Json | null,"portfolio_fetched_at": string | null,"redirect_uri": string,"refresh_claimed_until": string | null,"status": string,"token_version": number,"tokens_encrypted": string | null,"trading_access": string | null,"transfers_backfilled_at": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auth_state"?: string,"client_id": string,"created_at"?: string,"history_checked_on"?: string | null,"history_error"?: string | null,"history_status"?: string | null,"id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"pkce_verifier_encrypted"?: string | null,"portfolio"?: Json | null,"portfolio_fetched_at"?: string | null,"redirect_uri": string,"refresh_claimed_until"?: string | null,"status"?: string,"token_version"?: number,"tokens_encrypted"?: string | null,"trading_access"?: string | null,"transfers_backfilled_at"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "auth_state"?: string,"client_id"?: string,"created_at"?: string,"history_checked_on"?: string | null,"history_error"?: string | null,"history_status"?: string | null,"id"?: string,"last_error"?: string | null,"last_synced_at"?: string | null,"pkce_verifier_encrypted"?: string | null,"portfolio"?: Json | null,"portfolio_fetched_at"?: string | null,"redirect_uri"?: string,"refresh_claimed_until"?: string | null,"status"?: string,"token_version"?: number,"tokens_encrypted"?: string | null,"trading_access"?: string | null,"transfers_backfilled_at"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scalable_connections_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scalable_security_charts": {
                  Row: {
                    "currency_code": string,"fetched_at": string,"isin": string,"points": NonNullable<Json>,"timeframe": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "currency_code": string,"fetched_at": string,"isin": string,"points": NonNullable<Json>,"timeframe": string,"workspace_id": string
                  }
                  Update: {
                    "currency_code"?: string,"fetched_at"?: string,"isin"?: string,"points"?: NonNullable<Json>,"timeframe"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scalable_security_charts_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scalable_security_trades": {
                  Row: {
                    "isin": string,"occurred_at": string,"provider_id": string,"quantity_text": string,"side": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "isin": string,"occurred_at": string,"provider_id": string,"quantity_text": string,"side": string,"workspace_id": string
                  }
                  Update: {
                    "isin"?: string,"occurred_at"?: string,"provider_id"?: string,"quantity_text"?: string,"side"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scalable_security_trades_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scalable_trade_details": {
                  Row: {
                    "isin": string,"price_text": string | null,"provider_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "isin": string,"price_text"?: string | null,"provider_id": string,"workspace_id": string
                  }
                  Update: {
                    "isin"?: string,"price_text"?: string | null,"provider_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scalable_trade_details_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scalable_transfers": {
                  Row: {
                    "amount_minor": number,"currency_code": string,"description": string | null,"first_seen_at": string,"is_cancellation": boolean,"occurred_at": string,"on_date": string,"provider_id": string,"returns_provider_id": string | null,"revision": number,"revisions": NonNullable<Json>,"status": string,"type": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"currency_code": string,"description"?: string | null,"first_seen_at"?: string,"is_cancellation"?: boolean,"occurred_at": string,"on_date": string,"provider_id": string,"returns_provider_id"?: string | null,"revision"?: number,"revisions"?: NonNullable<Json>,"status": string,"type": string,"workspace_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"currency_code"?: string,"description"?: string | null,"first_seen_at"?: string,"is_cancellation"?: boolean,"occurred_at"?: string,"on_date"?: string,"provider_id"?: string,"returns_provider_id"?: string | null,"revision"?: number,"revisions"?: NonNullable<Json>,"status"?: string,"type"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scalable_transfers_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scalable_value_history": {
                  Row: {
                    "cash_minor": number,"crypto_minor": number,"currency_code": string,"on_date": string,"securities_minor": number,"total_minor": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cash_minor": number,"crypto_minor": number,"currency_code": string,"on_date": string,"securities_minor": number,"total_minor": number,"workspace_id": string
                  }
                  Update: {
                    "cash_minor"?: number,"crypto_minor"?: number,"currency_code"?: string,"on_date"?: string,"securities_minor"?: number,"total_minor"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scalable_value_history_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scenario_events": {
                  Row: {
                    "actor_id": string | null,"after": NonNullable<Json>,"before": Json | null,"created_at": string,"entity_id": string,"entity_type": string,"id": string,"request_id": string | null,"undone": boolean,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"after": NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"entity_id": string,"entity_type": string,"id"?: string,"request_id"?: string | null,"undone"?: boolean,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string | null,"after"?: NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"entity_id"?: string,"entity_type"?: string,"id"?: string,"request_id"?: string | null,"undone"?: boolean,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scenario_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scenario_overrides": {
                  Row: {
                    "account_id": string,"amount_delta_minor": number,"assumption_id": string | null,"cadence": string,"currency_code": string,"ends_on": string | null,"id": string,"name": string,"removed_at": string | null,"scenario_id": string,"starts_on": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_id": string,"amount_delta_minor": number,"assumption_id"?: string | null,"cadence": string,"currency_code": string,"ends_on"?: string | null,"id"?: string,"name": string,"removed_at"?: string | null,"scenario_id": string,"starts_on": string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string,"amount_delta_minor"?: number,"assumption_id"?: string | null,"cadence"?: string,"currency_code"?: string,"ends_on"?: string | null,"id"?: string,"name"?: string,"removed_at"?: string | null,"scenario_id"?: string,"starts_on"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scenario_overrides_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scenario_overrides_assumption_id_fkey"
      columns: ["assumption_id"]
isOneToOne: false
      referencedRelation: "financial_assumptions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scenario_overrides_scenario_id_fkey"
      columns: ["scenario_id"]
isOneToOne: false
      referencedRelation: "scenarios"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "scenario_overrides_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"scenarios": {
                  Row: {
                    "created_at": string,"description": string | null,"id": string,"name": string,"removed_at": string | null,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"name": string,"removed_at"?: string | null,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"name"?: string,"removed_at"?: string | null,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "scenarios_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"service_keys": {
                  Row: {
                    "name": string,"updated_at": string,"value_encrypted": string
                  }
                  ComputedFields: never
                  Insert: {
                    "name": string,"updated_at"?: string,"value_encrypted": string
                  }
                  Update: {
                    "name"?: string,"updated_at"?: string,"value_encrypted"?: string
                  }
                  Relationships: [
                    
                  ]
                },"source_transactions": {
                  Row: {
                    "external_id": string | null,"fee_evidence": Json | null,"id": string,"import_id": string,"normalized_row": Json | null,"original_row": NonNullable<Json>,"review_reasons": (string)[],"row_number": number,"status": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "external_id"?: string | null,"fee_evidence"?: Json | null,"id"?: string,"import_id": string,"normalized_row"?: Json | null,"original_row": NonNullable<Json>,"review_reasons"?: (string)[],"row_number": number,"status"?: string,"workspace_id": string
                  }
                  Update: {
                    "external_id"?: string | null,"fee_evidence"?: Json | null,"id"?: string,"import_id"?: string,"normalized_row"?: Json | null,"original_row"?: NonNullable<Json>,"review_reasons"?: (string)[],"row_number"?: number,"status"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_transactions_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "imports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_transactions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"spending_plan_limits": {
                  Row: {
                    "created_at": string,"effective_month": string,"enabled": boolean,"id": string,"limit_minor": number,"plan_id": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"effective_month": string,"enabled": boolean,"id"?: string,"limit_minor": number,"plan_id": string,"version": number,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"effective_month"?: string,"enabled"?: boolean,"id"?: string,"limit_minor"?: number,"plan_id"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "spending_plan_limits_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"spending_plans": {
                  Row: {
                    "category_id": string,"created_at": string,"currency_code": string,"enabled": boolean,"id": string,"limit_minor": number,"rollover": boolean,"rollover_from": string,"updated_at": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id": string,"created_at"?: string,"currency_code": string,"enabled"?: boolean,"id"?: string,"limit_minor": number,"rollover"?: boolean,"rollover_from": string,"updated_at"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "category_id"?: string,"created_at"?: string,"currency_code"?: string,"enabled"?: boolean,"id"?: string,"limit_minor"?: number,"rollover"?: boolean,"rollover_from"?: string,"updated_at"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "spending_plans_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "spending_plans_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"summary_runs": {
                  Row: {
                    "cadence": string,"created_at": string,"id": string,"job_id": string,"period_start": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cadence": string,"created_at"?: string,"id"?: string,"job_id": string,"period_start": string,"workspace_id": string
                  }
                  Update: {
                    "cadence"?: string,"created_at"?: string,"id"?: string,"job_id"?: string,"period_start"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "summary_runs_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "background_jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "summary_runs_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"transaction_batches": {
                  Row: {
                    "actor_id": string,"created_at": string,"id": string,"patch": NonNullable<Json>,"request_id": string,"selection": NonNullable<Json>,"undone": boolean,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"created_at"?: string,"id"?: string,"patch": NonNullable<Json>,"request_id": string,"selection": NonNullable<Json>,"undone"?: boolean,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"created_at"?: string,"id"?: string,"patch"?: NonNullable<Json>,"request_id"?: string,"selection"?: NonNullable<Json>,"undone"?: boolean,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_batches_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"transaction_link_fees": {
                  Row: {
                    "category_id": string | null,"fee_minor": number,"id": string,"link_id": string,"note": string,"transaction_id": string,"treatment": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id"?: string | null,"fee_minor": number,"id"?: string,"link_id": string,"note": string,"transaction_id": string,"treatment": string,"workspace_id": string
                  }
                  Update: {
                    "category_id"?: string | null,"fee_minor"?: number,"id"?: string,"link_id"?: string,"note"?: string,"transaction_id"?: string,"treatment"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_link_fees_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_link_fees_link_id_fkey"
      columns: ["link_id"]
isOneToOne: false
      referencedRelation: "transaction_links"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_link_fees_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_link_fees_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_link_fees_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"transaction_links": {
                  Row: {
                    "actor_id": string,"after_rows": NonNullable<Json>,"before_rows": NonNullable<Json>,"counterpart_transaction_id": string,"created_at": string,"fx_evidence": Json | null,"id": string,"input": NonNullable<Json>,"operation": string,"original_equivalent_minor": number | null,"primary_transaction_id": string,"request_id": string,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"after_rows": NonNullable<Json>,"before_rows": NonNullable<Json>,"counterpart_transaction_id": string,"created_at"?: string,"fx_evidence"?: Json | null,"id"?: string,"input": NonNullable<Json>,"operation": string,"original_equivalent_minor"?: number | null,"primary_transaction_id": string,"request_id": string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"after_rows"?: NonNullable<Json>,"before_rows"?: NonNullable<Json>,"counterpart_transaction_id"?: string,"created_at"?: string,"fx_evidence"?: Json | null,"id"?: string,"input"?: NonNullable<Json>,"operation"?: string,"original_equivalent_minor"?: number | null,"primary_transaction_id"?: string,"request_id"?: string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_links_counterpart_transaction_id_fkey"
      columns: ["counterpart_transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_links_counterpart_transaction_id_fkey"
      columns: ["counterpart_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_links_primary_transaction_id_fkey"
      columns: ["primary_transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_links_primary_transaction_id_fkey"
      columns: ["primary_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_links_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"transaction_sources": {
                  Row: {
                    "source_transaction_id": string,"transaction_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "source_transaction_id": string,"transaction_id": string
                  }
                  Update: {
                    "source_transaction_id"?: string,"transaction_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_sources_source_transaction_id_fkey"
      columns: ["source_transaction_id"]
isOneToOne: true
      referencedRelation: "source_transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_sources_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_sources_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"transaction_split_sets": {
                  Row: {
                    "actor_id": string,"after": NonNullable<Json>,"before": NonNullable<Json>,"created_at": string,"id": string,"request_id": string,"transaction_id": string,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"after": NonNullable<Json>,"before": NonNullable<Json>,"created_at"?: string,"id"?: string,"request_id": string,"transaction_id": string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"after"?: NonNullable<Json>,"before"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"request_id"?: string,"transaction_id"?: string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_split_sets_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_split_sets_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_split_sets_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"transaction_splits": {
                  Row: {
                    "amount_minor": number,"category_id": string | null,"id": string,"note": string,"ordinal": number,"parent_transaction_id": string,"split_set_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"category_id"?: string | null,"id"?: string,"note"?: string,"ordinal": number,"parent_transaction_id": string,"split_set_id": string,"workspace_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"category_id"?: string | null,"id"?: string,"note"?: string,"ordinal"?: number,"parent_transaction_id"?: string,"split_set_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_splits_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_splits_parent_transaction_id_fkey"
      columns: ["parent_transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_splits_parent_transaction_id_fkey"
      columns: ["parent_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_splits_split_set_id_fkey"
      columns: ["split_set_id"]
isOneToOne: false
      referencedRelation: "transaction_split_sets"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transaction_splits_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"transaction_views": {
                  Row: {
                    "created_at": string,"filters": NonNullable<Json>,"id": string,"name": string,"removed_at": string | null,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"filters"?: NonNullable<Json>,"id"?: string,"name": string,"removed_at"?: string | null,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"filters"?: NonNullable<Json>,"id"?: string,"name"?: string,"removed_at"?: string | null,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_views_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"transactions": {
                  Row: {
                    "account_id": string,"ai_confidence": string | null,"ai_reason": string | null,"amount_minor": number,"category_id": string | null,"created_at": string,"currency_code": string,"description": string,"event_name": string | null,"id": string,"identity_id": string | null,"kind": string,"merchant_id": string | null,"note": string | null,"organize_op_id": string | null,"organized_by": string | null,"posted_at": string | null,"posted_on": string,"refund_of_id": string | null,"review_reasons": (string)[],"status": string,"tags": (string)[],"transfer_id": string | null,"version": number,"workspace_id": string,"balance_review_record": Json | null,"link_money_snapshot": Json | null,"recurring_evidence_snapshot": Json | null,"recurring_merchant_identity": string | null
                  }
                  ComputedFields: "balance_review_record" | "link_money_snapshot" | "recurring_evidence_snapshot" | "recurring_merchant_identity"
                  Insert: {
                    "account_id": string,"ai_confidence"?: string | null,"ai_reason"?: string | null,"amount_minor": number,"category_id"?: string | null,"created_at"?: string,"currency_code": string,"description": string,"event_name"?: string | null,"id"?: string,"identity_id"?: string | null,"kind"?: string,"merchant_id"?: string | null,"note"?: string | null,"organize_op_id"?: string | null,"organized_by"?: string | null,"posted_at"?: string | null,"posted_on": string,"refund_of_id"?: string | null,"review_reasons"?: (string)[],"status"?: string,"tags"?: (string)[],"transfer_id"?: string | null,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "account_id"?: string,"ai_confidence"?: string | null,"ai_reason"?: string | null,"amount_minor"?: number,"category_id"?: string | null,"created_at"?: string,"currency_code"?: string,"description"?: string,"event_name"?: string | null,"id"?: string,"identity_id"?: string | null,"kind"?: string,"merchant_id"?: string | null,"note"?: string | null,"organize_op_id"?: string | null,"organized_by"?: string | null,"posted_at"?: string | null,"posted_on"?: string,"refund_of_id"?: string | null,"review_reasons"?: (string)[],"status"?: string,"tags"?: (string)[],"transfer_id"?: string | null,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transactions_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_identity_id_fkey"
      columns: ["identity_id"]
isOneToOne: false
      referencedRelation: "organize_identities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_merchant_id_fkey"
      columns: ["merchant_id"]
isOneToOne: false
      referencedRelation: "merchants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_refund_of_id_fkey"
      columns: ["refund_of_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_refund_of_id_fkey"
      columns: ["refund_of_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_transfer_id_fkey"
      columns: ["transfer_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_transfer_id_fkey"
      columns: ["transfer_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"voice_calls": {
                  Row: {
                    "conversation_id": string,"created_at": string,"duration_seconds": number,"id": string,"request_ids": (string)[],"summary": string | null,"summary_status": string,"tasks": NonNullable<Json>,"transcript": NonNullable<Json>,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "conversation_id": string,"created_at"?: string,"duration_seconds": number,"id": string,"request_ids"?: (string)[],"summary"?: string | null,"summary_status"?: string,"tasks": NonNullable<Json>,"transcript": NonNullable<Json>,"workspace_id": string
                  }
                  Update: {
                    "conversation_id"?: string,"created_at"?: string,"duration_seconds"?: number,"id"?: string,"request_ids"?: (string)[],"summary"?: string | null,"summary_status"?: string,"tasks"?: NonNullable<Json>,"transcript"?: NonNullable<Json>,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "voice_calls_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "voice_calls_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"wealth_events": {
                  Row: {
                    "actor_id": string,"after": NonNullable<Json>,"before": Json | null,"created_at": string,"id": string,"item_id": string,"request_id": string,"undone_at": string | null,"undone_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"after": NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"id"?: string,"item_id": string,"request_id": string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "actor_id"?: string,"after"?: NonNullable<Json>,"before"?: Json | null,"created_at"?: string,"id"?: string,"item_id"?: string,"request_id"?: string,"undone_at"?: string | null,"undone_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wealth_events_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "wealth_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wealth_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"wealth_items": {
                  Row: {
                    "amount_minor": number,"annual_rate_text": string | null,"as_of": string,"cost_basis_minor": number | null,"created_at": string,"currency_code": string,"id": string,"kind": string,"linked_account_id": string | null,"monthly_payment_minor": number | null,"name": string,"next_payment_on": string | null,"payment_account_id": string | null,"payment_assumption_id": string | null,"payment_transaction_id": string | null,"quantity_text": string | null,"removed_at": string | null,"unit_price_text": string | null,"updated_at": string,"version": number,"workspace_id": string,"wealth_record": Json | null
                  }
                  ComputedFields: "wealth_record"
                  Insert: {
                    "amount_minor": number,"annual_rate_text"?: string | null,"as_of": string,"cost_basis_minor"?: number | null,"created_at"?: string,"currency_code": string,"id": string,"kind": string,"linked_account_id"?: string | null,"monthly_payment_minor"?: number | null,"name": string,"next_payment_on"?: string | null,"payment_account_id"?: string | null,"payment_assumption_id"?: string | null,"payment_transaction_id"?: string | null,"quantity_text"?: string | null,"removed_at"?: string | null,"unit_price_text"?: string | null,"updated_at"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "amount_minor"?: number,"annual_rate_text"?: string | null,"as_of"?: string,"cost_basis_minor"?: number | null,"created_at"?: string,"currency_code"?: string,"id"?: string,"kind"?: string,"linked_account_id"?: string | null,"monthly_payment_minor"?: number | null,"name"?: string,"next_payment_on"?: string | null,"payment_account_id"?: string | null,"payment_assumption_id"?: string | null,"payment_transaction_id"?: string | null,"quantity_text"?: string | null,"removed_at"?: string | null,"unit_price_text"?: string | null,"updated_at"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wealth_items_linked_account_id_fkey"
      columns: ["linked_account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wealth_items_payment_account_id_fkey"
      columns: ["payment_account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wealth_items_payment_assumption_id_fkey"
      columns: ["payment_assumption_id"]
isOneToOne: false
      referencedRelation: "financial_assumptions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wealth_items_payment_transaction_id_fkey"
      columns: ["payment_transaction_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wealth_items_payment_transaction_id_fkey"
      columns: ["payment_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wealth_items_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspace_settings": {
                  Row: {
                    "ai_data_scopes": (string)[],"ai_memory": boolean,"ai_models": NonNullable<Json>,"artifact_scalable_data": string,"locale": string,"muted_insight_types": (string)[],"speech_engine": string,"speech_local_model": string | null,"speech_openrouter_model": string | null,"summary_cadence": string,"summary_time": string,"theme": string,"timezone": string,"uncategorized_skipped_at": string | null,"updated_at": string,"voice": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ai_data_scopes"?: (string)[],"ai_memory"?: boolean,"ai_models"?: NonNullable<Json>,"artifact_scalable_data"?: string,"locale"?: string,"muted_insight_types"?: (string)[],"speech_engine"?: string,"speech_local_model"?: string | null,"speech_openrouter_model"?: string | null,"summary_cadence"?: string,"summary_time"?: string,"theme"?: string,"timezone": string,"uncategorized_skipped_at"?: string | null,"updated_at"?: string,"voice"?: string,"workspace_id": string
                  }
                  Update: {
                    "ai_data_scopes"?: (string)[],"ai_memory"?: boolean,"ai_models"?: NonNullable<Json>,"artifact_scalable_data"?: string,"locale"?: string,"muted_insight_types"?: (string)[],"speech_engine"?: string,"speech_local_model"?: string | null,"speech_openrouter_model"?: string | null,"summary_cadence"?: string,"summary_time"?: string,"theme"?: string,"timezone"?: string,"uncategorized_skipped_at"?: string | null,"updated_at"?: string,"voice"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspace_settings_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: true
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "created_at": string,"display_currency": string,"id": string,"name": string,"owner_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_currency"?: string,"id"?: string,"name"?: string,"owner_id": string
                  }
                  Update: {
                    "created_at"?: string,"display_currency"?: string,"id"?: string,"name"?: string,"owner_id"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "effective_transactions": {
                  Row: {
                    "account_id": string | null,"amount_minor": number | null,"category_id": string | null,"created_at": string | null,"currency_code": string | null,"description": string | null,"event_name": string | null,"id": string | null,"kind": string | null,"merchant_id": string | null,"note": string | null,"parent_transaction_id": string | null,"posted_at": string | null,"posted_on": string | null,"refund_of_id": string | null,"review_reasons": (string)[] | null,"status": string | null,"tags": (string)[] | null,"transfer_id": string | null,"version": number | null,"workspace_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"transaction_category_ledger": {
                  Row: {
                    "account_id": string,"amount_minor": number,"category_id": string | null,"created_at": string,"currency_code": string,"description": string,"event_name": string | null,"id": string,"kind": string,"merchant_id": string | null,"note": string | null,"posted_at": string | null,"posted_on": string,"refund_of_id": string | null,"review_reasons": (string)[],"source_category_id": string | null,"status": string,"tags": (string)[],"transfer_id": string | null,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "transactions_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_category_id_fkey"
      columns: ["source_category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_merchant_id_fkey"
      columns: ["merchant_id"]
isOneToOne: false
      referencedRelation: "merchants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_refund_of_id_fkey"
      columns: ["refund_of_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_refund_of_id_fkey"
      columns: ["refund_of_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_transfer_id_fkey"
      columns: ["transfer_id"]
isOneToOne: false
      referencedRelation: "transaction_category_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_transfer_id_fkey"
      columns: ["transfer_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transactions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "agent_data_fingerprint":
{ Args: { "p_workspace_id": string }; Returns: string
                           },
"answer_organize_question":
{ Args: { "p_answer"?: Json,"p_question": string,"p_status": string }; Returns: {
              "answer": Json | null,
"answered_at": string | null,
"created_at": string,
"created_by": string,
"id": string,
"identity_id": string | null,
"identity_key": string,
"question": string,
"status": string,
"transaction_ids": (string)[],
"updated_at": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "organize_questions"
        isOneToOne: true
        isSetofReturn: false
      } },
"apply_ai_organization":
{ Args: { "p_items": Json,"p_proposal"?: string,"p_run": string,"p_workspace": string }; Returns: Json
                           },
"apply_iou_repayment":
{ Args: { "p_applied_minor": number,"p_item_id": string,"p_request_id": string,"p_transaction_id": string }; Returns: Json
                           },
"apply_organization_review":
{ Args: { "p_review_id": string,"p_save_rule": boolean }; Returns: Json
                           },
"balance_review_record":
{ Args: { "p_row": Omit<Database["public"]['Tables']["transactions"]['Row'], Database["public"]['Tables']["transactions"]['ComputedFields']> }; Returns: Json
                           },
"bulk_edit_transactions":
{ Args: { "p_patch": Json,"p_request_id": string,"p_rows": Json }; Returns: Json
                           },
"can_link_workspace":
{ Args: { "p_workspace_id": string }; Returns: boolean
                           },
"cancel_chat_request":
{ Args: { "p_request_id": string }; Returns: string
                           },
"cancel_financial_review":
{ Args: { "p_job_id": string }; Returns: string
                           },
"chat_set_category":
{ Args: { "p_category": string,"p_request_id": string,"p_transaction_id": string }; Returns: Json
                           },
"checkpoint_financial_investigation":
{ Args: { "p_job_id": string,"p_progress": Json,"p_run_id": string,"p_workspace_id": string }; Returns: boolean
                           },
"claim_bank_sync":
{ Args: { "p_connection_id": string,"p_token": string,"p_workspace_id": string }; Returns: boolean
                           },
"claim_scalable_refresh":
{ Args: { "p_connection_id": string,"p_token_version": number }; Returns: boolean
                           },
"claim_scheduled_summary":
{ Args: { "p_cadence": string,"p_period_start": string,"p_workspace_id": string }; Returns: string
                           },
"clear_transaction_link":
{ Args: { "p_expected_version": number,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"confirm_ai_organization":
{ Args: { "p_transaction_ids": (string)[] }; Returns: number
                           },
"confirm_iou_repayment":
{ Args: { "p_repayment_id": string }; Returns: undefined
                           },
"confirm_memory":
{ Args: { "p_id": string,"p_today": string }; Returns: undefined
                           },
"confirm_organize_memory":
{ Args: { "p_apply_to_existing": boolean,"p_category": string,"p_identity": string,"p_merchant": string,"p_purpose"?: string }; Returns: Json
                           },
"confirm_recurring_series":
{ Args: { "p_account_id": string,"p_amount_max_minor": number,"p_amount_min_minor": number,"p_cadence": string,"p_confidence": number,"p_currency_code": string,"p_label": string,"p_occurrences": number,"p_transaction_ids": (string)[] }; Returns: {
              "account_id": string,
"amount_max_minor": number,
"amount_min_minor": number,
"assumption_id": string | null,
"assumption_restore": Json | null,
"cadence": string,
"confidence": number | null,
"created_at": string,
"currency_code": string,
"evidence_baseline": Json | null,
"evidence_invalidated": boolean,
"id": string,
"invalidated_assumption_version": number | null,
"label": string,
"merchant_identity": string | null,
"normalized_label": string,
"occurrences": number,
"run_anchor_id": string | null,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "recurring_series"
        isOneToOne: true
        isSetofReturn: false
      } },
"control_import":
{ Args: { "p_action": string,"p_import_id": string,"p_request_id": string }; Returns: Json
                           },
"correct_transaction":
{ Args: { "p_category_name": string,"p_expected_version": number,"p_note": string,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_manual_transaction":
{ Args: { "p_account_id": string,"p_amount_minor": string,"p_category_id": string,"p_description": string,"p_note": string,"p_posted_on": string,"p_request_id": string,"p_status": string }; Returns: Json
                           },
"create_organization_review":
{ Args: { "p_evidence": Json,"p_merchant_name": string,"p_patch": Json,"p_request_id": string,"p_rows": Json,"p_rule_key": string }; Returns: Json
                           },
"currency_minor_digits":
{ Args: { "code": string }; Returns: number
                           },
"data_query":
{ Args: { "p_max_rows"?: number,"p_scopes": (string)[],"p_sql": string }; Returns: Json
                           },
"decline_recurring_series":
{ Args: { "p_account_id": string,"p_amount_max_minor": number,"p_amount_min_minor": number,"p_cadence": string,"p_confidence": number,"p_currency_code": string,"p_label": string,"p_occurrences": number,"p_transaction_ids": (string)[] }; Returns: {
              "account_id": string,
"amount_max_minor": number,
"amount_min_minor": number,
"assumption_id": string | null,
"assumption_restore": Json | null,
"cadence": string,
"confidence": number | null,
"created_at": string,
"currency_code": string,
"evidence_baseline": Json | null,
"evidence_invalidated": boolean,
"id": string,
"invalidated_assumption_version": number | null,
"label": string,
"merchant_identity": string | null,
"normalized_label": string,
"occurrences": number,
"run_anchor_id": string | null,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "recurring_series"
        isOneToOne: true
        isSetofReturn: false
      } },
"default_category_names":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"dismiss_organization_review":
{ Args: { "p_review_id": string }; Returns: undefined
                           },
"edit_assumption":
{ Args: { "p_expected_version": number,"p_id": string,"p_patch": Json,"p_request_id": string }; Returns: string
                           },
"edit_forecast_preferences":
{ Args: { "p_expected_version": number,"p_record": Json,"p_request_id": string,"p_workspace_id": string }; Returns: Json
                           },
"edit_goal_plan":
{ Args: { "p_expected_version": number,"p_goal_id": string,"p_patch": Json,"p_request_id": string }; Returns: string
                           },
"edit_memory":
{ Args: { "p_id": string,"p_kind": string,"p_statement": string,"p_valid_from": string,"p_valid_until": string }; Returns: string
                           },
"edit_money_metadata":
{ Args: { "p_entity_type": string,"p_expected_version": number,"p_id": string,"p_patch": Json,"p_request_id": string }; Returns: string
                           },
"edit_scenario_record":
{ Args: { "p_entity_type": string,"p_expected_version": number,"p_id": string,"p_patch": Json,"p_request_id": string }; Returns: string
                           },
"edit_spending_plan":
{ Args: { "p_expected_version": number,"p_id": string,"p_patch": Json,"p_request_id": string }; Returns: string
                           },
"edit_wealth_item":
{ Args: { "p_expected_version": number,"p_id": string,"p_record": Json,"p_remove": boolean,"p_request_id": string }; Returns: Json
                           },
"end_memory":
{ Args: { "p_ended_on": string,"p_id": string,"p_quote"?: string,"p_request_id"?: string }; Returns: undefined
                           },
"fail_financial_review":
{ Args: { "p_error": string,"p_job_id": string,"p_run_id": string,"p_stage": string,"p_workspace_id": string }; Returns: string
                           },
"finish_chat_request":
{ Args: { "p_content": string,"p_request_id": string,"p_status": string,"p_tool_calls"?: Json,"p_usage"?: Json }; Returns: string
                           },
"finish_financial_investigation":
{ Args: { "p_body": string,"p_evidence": Json,"p_job_id": string,"p_run_id": string,"p_scheduled"?: boolean,"p_title": string,"p_workspace_id": string }; Returns: string
                           },
"finish_financial_review":
{ Args: { "p_body": string,"p_evidence": Json,"p_job_id": string,"p_scheduled"?: boolean,"p_title": string,"p_workspace_id": string }; Returns: string
                           },
"finish_import_run":
{ Args: { "p_error"?: string,"p_import_id": string,"p_run_version": number,"p_workspace_id": string }; Returns: string
                           },
"finish_verified_chat_request":
{ Args: { "p_actor_id": string,"p_content": string,"p_receipt_ids": (string)[],"p_request_id": string,"p_scopes": (string)[],"p_usage"?: Json,"p_workspace_id": string }; Returns: string
                           },
"forecast_preference_record":
{ Args: { "item": Omit<Database["public"]['Tables']["forecast_preferences"]['Row'], Database["public"]['Tables']["forecast_preferences"]['ComputedFields']> }; Returns: Json
                           },
"forget_memory":
{ Args: { "p_id": string }; Returns: number
                           },
"hold_bank_sync":
{ Args: { "p_connection_id": string,"p_token": string }; Returns: boolean
                           },
"import_batch_candidates":
{ Args: { "p_import_id": string,"p_offset": number,"p_run_version": number,"p_workspace_id": string }; Returns: Json
                           },
"import_rows_progress":
{ Args: { "p_first_row": number,"p_import_id": string,"p_last_row": number }; Returns: {
              "classification_review_rows": number,"matched_rows": number,"new_rows": number,"rejected_rows": number,"review_rows": number
            }[]
                           },
"ingest_import_batch":
{ Args: { "p_decisions": Json,"p_import_id": string,"p_offset": number,"p_run_version": number,"p_workspace_id": string }; Returns: Json
                           },
"ingest_import_row":
{ Args: { "p_account_id": string,"p_import_id": string,"p_row": Json,"p_run_version": number,"p_workspace_id": string }; Returns: Json
                           },
"ingest_import_row_internal":
{ Args: { "p_account_id": string,"p_import_id": string,"p_review": boolean,"p_row": Json,"p_run_version": number,"p_workspace_id": string }; Returns: Json
                           },
"link_actor":
{ Args: { "p_workspace_id": string }; Returns: string
                           },
"link_fx_minor":
{ Args: { "p_amount": number,"p_from": string,"p_rate": Omit<Database["public"]['Tables']["fx_rates"]['Row'], Database["public"]['Tables']["fx_rates"]['ComputedFields']>,"p_to": string }; Returns: number
                           },
"link_money_snapshot":
{ Args: { "p": Omit<Database["public"]['Tables']["transactions"]['Row'], Database["public"]['Tables']["transactions"]['ComputedFields']> }; Returns: Json
                           },
"link_transactions":
{ Args: { "p_expected_version": number,"p_fees": Json,"p_fx_rate_id": string,"p_operation": string,"p_other_id": string,"p_other_version": number,"p_primary_id": string,"p_request_id": string }; Returns: Json
                           },
"lock_import_run":
{ Args: { "p_import_id": string,"p_run_version": number,"p_workspace_id": string }; Returns: {
              "classification_review_rows": number,
"created_at": string,
"error": string | null,
"file_hash": string,
"filename": string,
"id": string,
"mapping": Json | null,
"matched_rows": number,
"new_rows": number,
"rejected_rows": number,
"review_rows": number,
"route_accounts": NonNullable<Json>,
"run_version": number,
"source_id": string | null,
"status": string,
"storage_path": string,
"total_rows": number,
"undone_at": string | null,
"undone_by": string | null,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "imports"
        isOneToOne: true
        isSetofReturn: false
      } },
"mark_own_account_transfer":
{ Args: { "p_expected_version": number,"p_identifier_id": string,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"mark_own_exchange":
{ Args: { "p_counterpart_id"?: string,"p_expected_version": number,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"mark_own_iban_transfer":
{ Args: { "p_expected_version": number,"p_iban": string,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"mark_own_named_transfer":
{ Args: { "p_expected_version": number,"p_kind": string,"p_label"?: string,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"mark_transaction_refund":
{ Args: { "p_expected_version": number,"p_original_id": string,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"mark_transaction_transfer":
{ Args: { "p_counterpart_id": string,"p_expected_version": number,"p_transaction_id": string }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"memory_text":
{ Args: { "value": string }; Returns: string
                           },
"owned_workspace_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"owner_said":
{ Args: { "p_quote": string,"p_request_id": string,"p_workspace_id": string }; Returns: boolean
                           },
"owns_workspace":
{ Args: { "target": string }; Returns: boolean
                           },
"prepare_import_review":
{ Args: { "p_mapping": Json,"p_routes": Json,"p_row": Json,"p_source_id": string,"p_workspace_id": string }; Returns: undefined
                           },
"prepare_import_route":
{ Args: { "p_account_id": string,"p_account_name": string,"p_currency_code": string,"p_import_id": string,"p_run_version": number,"p_source_id": string,"p_total_rows": number,"p_workspace_id": string }; Returns: undefined
                           },
"preview_import_undo":
{ Args: { "p_import_id": string }; Returns: Json
                           },
"raise_organize_question":
{ Args: { "p_created_by": string,"p_identity_id": string,"p_identity_key": string,"p_question": string,"p_transaction_ids": (string)[],"p_workspace": string }; Returns: string
                           },
"read_import_stage":
{ Args: { "p_import_id": string,"p_run_version": number,"p_workspace_id": string }; Returns: number
                           },
"record_bank_balance":
{ Args: { "p_account_name": string,"p_amount_minor": number,"p_as_of": string,"p_balance_type": string,"p_connection_id": string,"p_currency_code": string }; Returns: undefined
                           },
"record_import_exclusion":
{ Args: { "p_import_id": string,"p_row": Json,"p_run_version": number,"p_workspace_id": string }; Returns: undefined
                           },
"record_manual_balance":
{ Args: { "p_account_id": string,"p_amount_minor": string,"p_covered_transactions": Json,"p_date": string,"p_expected_snapshot_id": string,"p_expected_version": number,"p_request_id": string,"p_reviewed": boolean }; Returns: Json
                           },
"record_recurring_occurrence":
{ Args: { "p_assumption_id": string,"p_assumption_version": number,"p_completes_occurrence": boolean,"p_scheduled_on": string,"p_transaction_id": string,"p_transaction_version": number }; Returns: {
              "actor_id": string,
"assumption_id": string,
"completes_occurrence": boolean,
"created_at": string,
"id": string,
"receipt": NonNullable<Json>,
"scheduled_on": string,
"transaction_id": string,
"undone_at": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "recurring_occurrence_settlements"
        isOneToOne: true
        isSetofReturn: false
      } },
"recount_import_progress":
{ Args: { "p_import_id": string }; Returns: undefined
                           },
"recurring_evidence_snapshot":
{ Args: { "p": Omit<Database["public"]['Tables']["transactions"]['Row'], Database["public"]['Tables']["transactions"]['ComputedFields']> }; Returns: Json
                           },
"recurring_merchant_identity":
{ Args: { "p": Omit<Database["public"]['Tables']["transactions"]['Row'], Database["public"]['Tables']["transactions"]['ComputedFields']> }; Returns: string
                           },
"recurring_period_index":
{ Args: { "p_anchor": string,"p_cadence": string,"p_observed": string }; Returns: number
                           },
"recurring_scheduled_date":
{ Args: { "p_anchor": string,"p_cadence": string,"p_index": number }; Returns: string
                           },
"register_financial_review_run":
{ Args: { "p_job_id": string,"p_run_id": string,"p_workspace_id": string }; Returns: boolean
                           },
"remove_organize_memory":
{ Args: { "p_memory": string }; Returns: undefined
                           },
"remove_scalable_charts":
{ Args: { "p_workspace_id": string }; Returns: undefined
                           },
"replace_scalable_value_history":
{ Args: { "p_checked_on": string,"p_connection_id": string,"p_rows": Json }; Returns: number
                           },
"replaced_on":
{ Args: { "p_new_from": string,"p_old_from": string,"p_today": string }; Returns: string
                           },
"request_workspace":
{ Args: { "p_request_id": string }; Returns: string
                           },
"reservation_balance_evidence":
{ Args: { "p_account_id": string,"p_as_of": string,"p_timezone": string }; Returns: Json
                           },
"reserve_agent_model_call":
{ Args: { "p_run_id": string,"p_workspace_id": string }; Returns: boolean
                           },
"reserve_financial_investigation_synthesis":
{ Args: { "p_job_id": string,"p_progress": Json,"p_run_id": string,"p_workspace_id": string }; Returns: boolean
                           },
"reserve_goal_funds":
{ Args: { "p_account_id": string,"p_amount_minor": string,"p_expected_version": number,"p_goal_id": string,"p_request_id": string }; Returns: Json
                           },
"reset_auto_organization":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"reset_workspace":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"resolve_import_review":
{ Args: { "p_action": string,"p_amount_minor"?: number,"p_currency_code"?: string,"p_description"?: string,"p_posted_on"?: string,"p_source_id": string }; Returns: {
              "external_id": string | null,
"fee_evidence": Json | null,
"id": string,
"import_id": string,
"normalized_row": Json | null,
"original_row": NonNullable<Json>,
"review_reasons": (string)[],
"row_number": number,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "source_transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"resolve_import_review_before_classification":
{ Args: { "p_action": string,"p_amount_minor"?: number,"p_currency_code"?: string,"p_description"?: string,"p_posted_on"?: string,"p_source_id": string }; Returns: {
              "external_id": string | null,
"fee_evidence": Json | null,
"id": string,
"import_id": string,
"normalized_row": Json | null,
"original_row": NonNullable<Json>,
"review_reasons": (string)[],
"row_number": number,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "source_transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"resolve_normalized_import_review":
{ Args: { "p_account_id"?: string,"p_action": string,"p_expected_account_version"?: number,"p_expected_route_id"?: string,"p_source_id": string }; Returns: {
              "external_id": string | null,
"fee_evidence": Json | null,
"id": string,
"import_id": string,
"normalized_row": Json | null,
"original_row": NonNullable<Json>,
"review_reasons": (string)[],
"row_number": number,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "source_transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"resolve_organize_identities":
{ Args: { "p_items": Json,"p_workspace": string }; Returns: Json
                           },
"resolve_pending_hold":
{ Args: { "p_expected_released_minor": number,"p_expected_version": number,"p_note": string,"p_pending_id": string,"p_posted_id": string,"p_posted_version": number,"p_released_minor": number,"p_request_id": string }; Returns: Json
                           },
"resolve_transaction_classification":
{ Args: { "p_expected_version": number,"p_fee_included"?: boolean,"p_kind": string,"p_transaction_id": string }; Returns: Json
                           },
"restore_manual_transaction":
{ Args: { "p_entry_id": string,"p_entry_version": number }; Returns: string
                           },
"review_recurring_series":
{ Args: { "p_account_id": string,"p_cadence": string,"p_currency_code": string,"p_decision": string,"p_evidence": Json,"p_evidence_limited"?: boolean,"p_label": string,"p_run_anchor_id": string }; Returns: {
              "account_id": string,
"amount_max_minor": number,
"amount_min_minor": number,
"assumption_id": string | null,
"assumption_restore": Json | null,
"cadence": string,
"confidence": number | null,
"created_at": string,
"currency_code": string,
"evidence_baseline": Json | null,
"evidence_invalidated": boolean,
"id": string,
"invalidated_assumption_version": number | null,
"label": string,
"merchant_identity": string | null,
"normalized_label": string,
"occurrences": number,
"run_anchor_id": string | null,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "recurring_series"
        isOneToOne: true
        isSetofReturn: false
      } },
"review_recurring_series_versions":
{ Args: { "p_account_id": string,"p_cadence": string,"p_currency_code": string,"p_decision": string,"p_evidence": Json,"p_evidence_limited"?: boolean,"p_label": string,"p_run_anchor_id": string }; Returns: {
              "account_id": string,
"amount_max_minor": number,
"amount_min_minor": number,
"assumption_id": string | null,
"assumption_restore": Json | null,
"cadence": string,
"confidence": number | null,
"created_at": string,
"currency_code": string,
"evidence_baseline": Json | null,
"evidence_invalidated": boolean,
"id": string,
"invalidated_assumption_version": number | null,
"label": string,
"merchant_identity": string | null,
"normalized_label": string,
"occurrences": number,
"run_anchor_id": string | null,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "recurring_series"
        isOneToOne: true
        isSetofReturn: false
      } },
"reviewed_import_source_row":
{ Args: { "p_source_id": string }; Returns: Json
                           },
"save_memory":
{ Args: { "p_kind": string,"p_quote": string,"p_replaces"?: string,"p_request_id": string,"p_statement": string,"p_sure": boolean,"p_today": string,"p_valid_from"?: string,"p_valid_until"?: string }; Returns: Json
                           },
"save_organization_rule":
{ Args: { "p_category": string,"p_enabled": boolean,"p_expected_version": number,"p_key": string,"p_merchant": string,"p_workspace": string }; Returns: Json
                           },
"save_scalable_charts":
{ Args: { "p_charts": Json,"p_connection_id": string,"p_held": (string)[],"p_trades": Json }; Returns: undefined
                           },
"save_scalable_transfers":
{ Args: { "p_complete": boolean,"p_connection_id": string,"p_rows": Json }; Returns: number
                           },
"save_workspace_preferences":
{ Args: { "p_display_currency": string,"p_preferences": Json,"p_workspace_id": string }; Returns: undefined
                           },
"set_goal_allocation":
{ Args: { "p_account_id": string,"p_amount_minor": number,"p_goal_id": string }; Returns: {
              "account_id": string,
"amount_minor": number,
"goal_id": string,
"id": string,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "goal_allocations"
        isOneToOne: true
        isSetofReturn: false
      } },
"settle_import_review":
{ Args: { "p_account_id"?: string,"p_expected_account_version"?: number,"p_expected_released_minor": number,"p_expected_route_id"?: string,"p_note": string,"p_pending_id": string,"p_pending_version": number,"p_released_minor": number,"p_request_id": string,"p_source_id": string }; Returns: {
              "external_id": string | null,
"fee_evidence": Json | null,
"id": string,
"import_id": string,
"normalized_row": Json | null,
"original_row": NonNullable<Json>,
"review_reasons": (string)[],
"row_number": number,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "source_transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"similar_transaction_ids":
{ Args: { "p_from"?: string,"p_limit"?: number,"p_max_minor"?: number,"p_min_minor"?: number,"p_query": string,"p_to"?: string,"p_workspace_id": string }; Returns: {
              "id": string
            }[]
                           },
"split_transaction":
{ Args: { "p_children": Json,"p_expected_version": number,"p_request_id": string,"p_transaction_id": string }; Returns: Json
                           },
"stable_import_uuid":
{ Args: { "p_key": string }; Returns: string
                           },
"stage_import_rows":
{ Args: { "p_file_hash": string,"p_import_id": string,"p_mapping": Json,"p_routes": Json,"p_rows": Json,"p_run_version": number,"p_source_id": string,"p_workspace_id": string }; Returns: number
                           },
"start_chat_request":
{ Args: { "p_context": Json,"p_conversation_id": string,"p_message": string,"p_regenerates"?: string,"p_request_id": string }; Returns: Json
                           },
"start_financial_investigation":
{ Args: { "p_chat_request_id"?: string,"p_request_id": string,"p_specification": Json }; Returns: Json
                           },
"start_financial_review":
{ Args: { "p_chat_request_id"?: string,"p_request_id": string }; Returns: Json
                           },
"steer_chat_request":
{ Args: { "p_message": string,"p_request_id": string,"p_steer_id": string }; Returns: boolean
                           },
"sync_scalable_wealth":
{ Args: { "p_connection_id": string,"p_fetched_at": string,"p_items": Json,"p_portfolio": Json }; Returns: number
                           },
"take_chat_steers":
{ Args: { "p_request_id": string }; Returns: Json
                           },
"undo_ai_organization":
{ Args: { "p_op_ids": (string)[] }; Returns: Json
                           },
"undo_forecast_preferences":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: Json
                           },
"undo_goal_plan":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: undefined
                           },
"undo_goal_reservation":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: undefined
                           },
"undo_import":
{ Args: { "p_expected_balances": number,"p_expected_transactions": number,"p_import_id": string }; Returns: Json
                           },
"undo_import_before_control":
{ Args: { "p_expected_balances": number,"p_expected_transactions": number,"p_import_id": string }; Returns: Json
                           },
"undo_import_row_decision":
{ Args: { "p_decision_id": string }; Returns: {
              "external_id": string | null,
"fee_evidence": Json | null,
"id": string,
"import_id": string,
"normalized_row": Json | null,
"original_row": NonNullable<Json>,
"review_reasons": (string)[],
"row_number": number,
"status": string,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "source_transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"undo_manual_balance":
{ Args: { "p_expected_latest_id": string,"p_expected_latest_version": number,"p_expected_version": number,"p_snapshot_id": string }; Returns: Json
                           },
"undo_manual_transaction":
{ Args: { "p_entry_id": string,"p_entry_version": number,"p_expected_version": number }; Returns: undefined
                           },
"undo_memory":
{ Args: { "p_id": string }; Returns: undefined
                           },
"undo_money_metadata":
{ Args: { "p_event_id": string,"p_expected_version": number,"p_request_id": string }; Returns: string
                           },
"undo_own_account_confirmation":
{ Args: { "p_identifier_id": string }; Returns: number
                           },
"undo_own_account_transfer":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"undo_pending_hold_resolution":
{ Args: { "p_resolution_id": string }; Returns: Json
                           },
"undo_planning_event":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: undefined
                           },
"undo_recurring_occurrence":
{ Args: { "p_settlement_id": string,"p_version": number }; Returns: {
              "actor_id": string,
"assumption_id": string,
"completes_occurrence": boolean,
"created_at": string,
"id": string,
"receipt": NonNullable<Json>,
"scheduled_on": string,
"transaction_id": string,
"undone_at": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "recurring_occurrence_settlements"
        isOneToOne: true
        isSetofReturn: false
      } },
"undo_scenario_record":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: undefined
                           },
"undo_transaction_batch":
{ Args: { "p_batch_id": string,"p_rows": Json }; Returns: undefined
                           },
"undo_transaction_classification":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: Json
                           },
"undo_transaction_correction":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: {
              "account_id": string,
"ai_confidence": string | null,
"ai_reason": string | null,
"amount_minor": number,
"category_id": string | null,
"created_at": string,
"currency_code": string,
"description": string,
"event_name": string | null,
"id": string,
"identity_id": string | null,
"kind": string,
"merchant_id": string | null,
"note": string | null,
"organize_op_id": string | null,
"organized_by": string | null,
"posted_at": string | null,
"posted_on": string,
"refund_of_id": string | null,
"review_reasons": (string)[],
"status": string,
"tags": (string)[],
"transfer_id": string | null,
"version": number,
"workspace_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "transactions"
        isOneToOne: true
        isSetofReturn: false
      } },
"undo_transaction_link":
{ Args: { "p_link_id": string,"p_rows": Json }; Returns: undefined
                           },
"undo_transaction_metadata":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: undefined
                           },
"undo_transaction_splits":
{ Args: { "p_expected_version": number,"p_set_id": string }; Returns: undefined
                           },
"undo_wealth_event":
{ Args: { "p_event_id": string,"p_expected_version": number }; Returns: undefined
                           },
"wealth_record":
{ Args: { "item": Omit<Database["public"]['Tables']["wealth_items"]['Row'], Database["public"]['Tables']["wealth_items"]['ComputedFields']> }; Returns: Json
                           },
"workspace_time_zone":
{ Args: { "p_workspace_id": string }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
