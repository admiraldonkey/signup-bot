ALTER TABLE "event_template_recurrences" ADD COLUMN "next_sweep_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "event_template_recurrences" ADD COLUMN "sweep_claim_token" text;--> statement-breakpoint
ALTER TABLE "event_template_recurrences" ADD COLUMN "last_sweep_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_template_recurrences" ADD COLUMN "last_sweep_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_template_recurrences" ADD COLUMN "last_sweep_outcome" varchar(32);--> statement-breakpoint
ALTER TABLE "event_template_recurrences" ADD COLUMN "last_sweep_diagnostic" text;--> statement-breakpoint
CREATE INDEX "evt_tpl_recur_active_sweep_idx" ON "event_template_recurrences" USING btree ("active","next_sweep_at");--> statement-breakpoint
ALTER TABLE "event_template_recurrences" ADD CONSTRAINT "evt_tpl_recur_sweep_outcome_chk" CHECK ("event_template_recurrences"."last_sweep_outcome" IS NULL OR "event_template_recurrences"."last_sweep_outcome" IN ('success', 'partial_failure', 'failure', 'skipped'));