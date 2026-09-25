CREATE TABLE "event_recurrence_occurrences" (
	"recurrence_id" integer NOT NULL,
	"occurrence_date" date NOT NULL,
	"event_id" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evt_recur_occ_pk" PRIMARY KEY("recurrence_id","occurrence_date")
);
--> statement-breakpoint
CREATE TABLE "event_template_recurrences" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_template_recurrences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"template_id" integer NOT NULL,
	"recurrence_rule" text NOT NULL,
	"start_date" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_recurrence_occurrences" ADD CONSTRAINT "evt_recur_occ_recur_fk" FOREIGN KEY ("recurrence_id") REFERENCES "public"."event_template_recurrences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_recurrence_occurrences" ADD CONSTRAINT "evt_recur_occ_event_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_template_recurrences" ADD CONSTRAINT "evt_tpl_recur_tpl_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evt_recur_occ_event_uq" ON "event_recurrence_occurrences" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evt_tpl_recur_template_uq" ON "event_template_recurrences" USING btree ("template_id");