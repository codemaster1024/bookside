CREATE TABLE `question_status_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `question_status_changes_question` ON `question_status_changes` (`question_id`,`created_at`);