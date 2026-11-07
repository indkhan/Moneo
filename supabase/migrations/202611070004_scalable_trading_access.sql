-- Whether the Scalable login allows trading ('full') or only reads ('read'); null until a sync records it.
-- Chat offers its order cards only when this is not 'read'.
alter table public.scalable_connections add column trading_access text,
  add constraint scalable_connections_trading_access_check check (trading_access in ('full','read'));
