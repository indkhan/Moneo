CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"minor_digits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
