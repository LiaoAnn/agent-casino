CREATE TABLE `bans` (
	`name_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`banned_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `match_events` (
	`match_id` text NOT NULL,
	`hand_number` integer NOT NULL,
	`seq` integer NOT NULL,
	`seat` integer NOT NULL,
	`street` text NOT NULL,
	`type` text NOT NULL,
	`amount` integer,
	`timeout` integer NOT NULL,
	PRIMARY KEY(`match_id`, `hand_number`, `seq`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`match_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `match_hands` (
	`match_id` text NOT NULL,
	`hand_number` integer NOT NULL,
	`button_seat` integer NOT NULL,
	`board` text NOT NULL,
	`hole_cards` text,
	`winner_seat` integer,
	`pot` integer NOT NULL,
	`ended_by` text NOT NULL,
	`stacks` text NOT NULL,
	PRIMARY KEY(`match_id`, `hand_number`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`match_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`match_id` text PRIMARY KEY NOT NULL,
	`player0` text NOT NULL,
	`player1` text NOT NULL,
	`settings` text NOT NULL,
	`seed` text NOT NULL,
	`result` text NOT NULL,
	`rated` integer NOT NULL,
	`final_stacks` text NOT NULL,
	`rating_changes` text,
	`ended_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `matches_ended_at_idx` ON `matches` (`ended_at`,`match_id`);--> statement-breakpoint
CREATE TABLE `ratings` (
	`name_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rating` real NOT NULL,
	`games` integer NOT NULL,
	`wins` integer NOT NULL,
	`losses` integer NOT NULL,
	`draws` integer NOT NULL
);
