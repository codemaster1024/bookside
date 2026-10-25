CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`weread_book_id` text,
	`title` text NOT NULL,
	`author` text,
	`cover` text,
	`progress` integer,
	`finished_at` integer,
	`purpose` text,
	`category` text,
	`reading_mode` text,
	`sync_signature` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "books_source" CHECK("books"."source" in ('weread', 'kindle', 'local')),
	CONSTRAINT "books_reading_mode" CHECK("books"."reading_mode" in ('argument', 'practice', 'knowledge', 'narrative')),
	CONSTRAINT "books_progress" CHECK("books"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_weread_book_id` ON `books` (`weread_book_id`);--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`weread_chapter_uid` integer,
	`idx` integer NOT NULL,
	`title` text NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chapters_book_uid` ON `chapters` (`book_id`,`weread_chapter_uid`);--> statement-breakpoint
CREATE TABLE `guides` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` text,
	`basis` text NOT NULL,
	`depth` text DEFAULT 'full' NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guides_basis" CHECK("guides"."basis" in ('familiar', 'limited')),
	CONSTRAINT "guides_depth" CHECK("guides"."depth" in ('quick', 'full'))
);
--> statement-breakpoint
CREATE INDEX `guides_book` ON `guides` (`book_id`,`chapter_id`);--> statement-breakpoint
CREATE TABLE `highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` text,
	`source` text NOT NULL,
	`kind` text DEFAULT 'marked' NOT NULL,
	`weread_bookmark_id` text,
	`text` text NOT NULL,
	`range` text,
	`marked_at` integer NOT NULL,
	`deleted_at_source_at` integer,
	`probe_considered_at` integer,
	`activation_considered_at` integer,
	`reread_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "highlights_source" CHECK("highlights"."source" in ('weread', 'kindle', 'local')),
	CONSTRAINT "highlights_kind" CHECK("highlights"."kind" in ('marked', 'from_note'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `highlights_weread_bookmark_id` ON `highlights` (`weread_bookmark_id`);--> statement-breakpoint
CREATE INDEX `highlights_book` ON `highlights` (`book_id`);--> statement-breakpoint
CREATE TABLE `insight_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`insight_id` text NOT NULL,
	`question_id` text,
	`highlight_id` text,
	`book_id` text,
	FOREIGN KEY (`insight_id`) REFERENCES `insights`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`highlight_id`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "insight_sources_single" CHECK(("insight_sources"."question_id" is not null) + ("insight_sources"."highlight_id" is not null) + ("insight_sources"."book_id" is not null) = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insight_sources_question` ON `insight_sources` (`question_id`,`insight_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `insight_sources_highlight` ON `insight_sources` (`highlight_id`,`insight_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `insight_sources_book` ON `insight_sources` (`book_id`,`insight_id`);--> statement-breakpoint
CREATE TABLE `insight_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`insight_id` text NOT NULL,
	`content` text NOT NULL,
	`author` text NOT NULL,
	`rewrite` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`insight_id`) REFERENCES `insights`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "insight_versions_author" CHECK("insight_versions"."author" in ('me', 'ai'))
);
--> statement-breakpoint
CREATE INDEX `insight_versions_insight` ON `insight_versions` (`insight_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_type` text NOT NULL,
	`from_id` text NOT NULL,
	`to_type` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`proposed_by` text NOT NULL,
	`reason` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "links_from_type" CHECK("links"."from_type" in ('book', 'chapter', 'highlight', 'note', 'question', 'insight')),
	CONSTRAINT "links_to_type" CHECK("links"."to_type" in ('book', 'chapter', 'highlight', 'note', 'question', 'insight')),
	CONSTRAINT "links_kind" CHECK("links"."kind" in ('supports', 'conflicts', 'answers', 'extends')),
	CONSTRAINT "links_state" CHECK("links"."state" in ('proposed', 'confirmed', 'rejected')),
	CONSTRAINT "links_proposed_by" CHECK("links"."proposed_by" in ('me', 'ai')),
	CONSTRAINT "links_not_self" CHECK(not ("links"."from_type" = "links"."to_type" and "links"."from_id" = "links"."to_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_unique` ON `links` (`from_type`,`from_id`,`to_type`,`to_id`,`kind`);--> statement-breakpoint
CREATE INDEX `links_to` ON `links` (`to_type`,`to_id`);--> statement-breakpoint
CREATE TABLE `message_highlights` (
	`message_id` text NOT NULL,
	`highlight_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `highlight_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`highlight_id`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`speaker` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "messages_speaker" CHECK("messages"."speaker" in ('me', 'ai'))
);
--> statement-breakpoint
CREATE INDEX `messages_question` ON `messages` (`question_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`highlight_id` text NOT NULL,
	`source` text NOT NULL,
	`weread_review_id` text,
	`content` text NOT NULL,
	`written_at` integer NOT NULL,
	`deleted_at_source_at` integer,
	`probe_considered_at` integer,
	`activation_considered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`highlight_id`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notes_source" CHECK("notes"."source" in ('weread', 'kindle', 'local'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notes_weread_review_id` ON `notes` (`weread_review_id`);--> statement-breakpoint
CREATE INDEX `notes_highlight` ON `notes` (`highlight_id`);--> statement-breakpoint
CREATE TABLE `probes` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text,
	`chapter_id` text,
	`highlight_id` text,
	`note_id` text,
	`content` text NOT NULL,
	`promoted_question_id` text,
	`dismissed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`highlight_id`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promoted_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "probes_single_target" CHECK(("probes"."book_id" is not null) + ("probes"."chapter_id" is not null) + ("probes"."highlight_id" is not null) + ("probes"."note_id" is not null) = 1),
	CONSTRAINT "probes_promoted_or_dismissed" CHECK(("probes"."promoted_question_id" is not null) + ("probes"."dismissed_at" is not null) <= 1)
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'unexplored' NOT NULL,
	`origin_book_id` text,
	`origin_chapter_id` text,
	`origin_highlight_id` text,
	`revisit_step` integer DEFAULT 0 NOT NULL,
	`next_revisit_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`origin_book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_highlight_id`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "questions_status" CHECK("questions"."status" in ('unexplored', 'exploring', 'tentative', 'resolved', 'abandoned')),
	CONSTRAINT "questions_single_origin" CHECK(("questions"."origin_book_id" is not null) + ("questions"."origin_chapter_id" is not null) + ("questions"."origin_highlight_id" is not null) <= 1)
);
--> statement-breakpoint
CREATE INDEX `questions_next_revisit` ON `questions` (`next_revisit_at`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` text,
	`source` text NOT NULL,
	`weread_review_id` text,
	`content` text NOT NULL,
	`star` integer,
	`written_at` integer NOT NULL,
	`deleted_at_source_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_weread_review_id` ON `reviews` (`weread_review_id`);--> statement-breakpoint
CREATE INDEX `reviews_book` ON `reviews` (`book_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
