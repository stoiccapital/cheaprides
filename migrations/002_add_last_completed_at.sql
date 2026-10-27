-- Track when each company most recently completed a ride.
-- Backfills from existing bookings.

ALTER TABLE companies ADD COLUMN last_completed_at INTEGER;

UPDATE companies
   SET last_completed_at = (
     SELECT MAX(completed_at)
       FROM bookings
      WHERE company_id = companies.id
        AND status = 'completed'
   );
