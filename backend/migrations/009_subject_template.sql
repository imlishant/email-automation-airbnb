-- 009 — the email subject is the host's to write, like the body.
--
-- It was fixed in code: "Guest IDs - <listing> - arriving <date>". Societies
-- ask for their own wording (a flat number, a block, a reference the desk
-- files by), and a subject they cannot change is a subject they work around.
--
-- Existing societies keep exactly what they were sending, written out as a
-- template, so nothing changes for anyone until they edit it.

ALTER TABLE societies ADD COLUMN subject_template TEXT;

UPDATE societies
   SET subject_template = 'Guest IDs - {{listing}} - arriving {{check_in}}'
 WHERE subject_template IS NULL;
