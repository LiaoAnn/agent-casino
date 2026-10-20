CREATE TABLE `match_seats` (
	`match_id` text NOT NULL,
	`seat` integer NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`final_stack` integer NOT NULL,
	`place` integer,
	`rating_name` text,
	`rating_before` integer,
	`rating_after` integer,
	PRIMARY KEY(`match_id`, `seat`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`match_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `match_hands` ADD `pots` text;--> statement-breakpoint
-- Backfill (hand-written, T40): the two seats of every earlier match.
INSERT INTO `match_seats` (`match_id`, `seat`, `name`, `display_name`, `final_stack`, `place`, `rating_name`, `rating_before`, `rating_after`)
SELECT `match_id`, 0, `player0`, `display0`, json_extract(`final_stacks`, '$[0]'),
	CASE `result` WHEN 'seat0_win' THEN 1 WHEN 'seat1_win' THEN 2 WHEN 'draw' THEN 1 END,
	json_extract(`rating_changes`, '$[0].name'), json_extract(`rating_changes`, '$[0].before'), json_extract(`rating_changes`, '$[0].after')
FROM `matches`
UNION ALL
SELECT `match_id`, 1, `player1`, `display1`, json_extract(`final_stacks`, '$[1]'),
	CASE `result` WHEN 'seat0_win' THEN 2 WHEN 'seat1_win' THEN 1 WHEN 'draw' THEN 1 END,
	json_extract(`rating_changes`, '$[1].name'), json_extract(`rating_changes`, '$[1].before'), json_extract(`rating_changes`, '$[1].after')
FROM `matches`;--> statement-breakpoint
ALTER TABLE `matches` DROP COLUMN `player0`;--> statement-breakpoint
ALTER TABLE `matches` DROP COLUMN `player1`;--> statement-breakpoint
ALTER TABLE `matches` DROP COLUMN `display0`;--> statement-breakpoint
ALTER TABLE `matches` DROP COLUMN `display1`;--> statement-breakpoint
ALTER TABLE `matches` DROP COLUMN `final_stacks`;--> statement-breakpoint
ALTER TABLE `matches` DROP COLUMN `rating_changes`;