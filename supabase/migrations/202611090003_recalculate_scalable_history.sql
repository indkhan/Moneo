-- Trades are now priced without fees, so each connection works out its past values once more. Until a run passes its
-- check, the days already saved stay as they are.
update public.scalable_connections set history_status = null, history_checked_on = null;
