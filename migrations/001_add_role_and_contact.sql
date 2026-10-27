-- Add role to users; add phone/email to companies.
-- Backfills existing company owners to role='company'.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'passenger';
ALTER TABLE companies ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN email TEXT NOT NULL DEFAULT '';

UPDATE users SET role = 'company'
 WHERE id IN (SELECT DISTINCT owner_id FROM companies);
