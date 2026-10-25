CREATE TABLE `portraits` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`highlight_count` integer NOT NULL,
	`model` text,
	`created_at` integer NOT NULL
);
