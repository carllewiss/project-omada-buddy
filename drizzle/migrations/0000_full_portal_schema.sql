-- ========== TABLES ==========
CREATE TABLE public.transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  package_type TEXT NOT NULL DEFAULT '2hour',
  checkout_request_id TEXT,
  merchant_request_id TEXT,
  mpesa_receipt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result_code TEXT,
  result_desc TEXT,
  session_id TEXT,
  client_mac TEXT,
  ap_mac TEXT,
  ssid TEXT,
  voucher_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.transactions TO anon, authenticated;
GRANT ALL ON public.transactions TO service_role;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public insert" ON public.transactions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public select" ON public.transactions FOR SELECT USING (true);
CREATE POLICY "Allow public update" ON public.transactions FOR UPDATE USING (true);
CREATE INDEX idx_transactions_checkout ON public.transactions (checkout_request_id);
CREATE INDEX idx_transactions_created_at ON public.transactions (created_at DESC);

CREATE TABLE public.client_authorizations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mac_address TEXT,
  client_ip TEXT,
  ap_mac TEXT,
  ssid TEXT,
  phone_number TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  package_type TEXT NOT NULL DEFAULT '2hour',
  duration_hours INTEGER NOT NULL DEFAULT 2,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  authorization_status TEXT NOT NULL DEFAULT 'no',
  checkout_request_id TEXT,
  mpesa_receipt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.client_authorizations TO anon, authenticated;
GRANT ALL ON public.client_authorizations TO service_role;
ALTER TABLE public.client_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public select" ON public.client_authorizations FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON public.client_authorizations FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update" ON public.client_authorizations FOR UPDATE USING (true);
CREATE INDEX idx_client_auth_checkout ON public.client_authorizations (checkout_request_id);
CREATE INDEX idx_client_auth_mac ON public.client_authorizations (mac_address);

CREATE TABLE public.vouchers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  package_type TEXT NOT NULL DEFAULT '2hour',
  duration_hours INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'unused',
  is_used BOOLEAN NOT NULL DEFAULT false,
  used_by_mac TEXT,
  used_at TIMESTAMPTZ,
  reserved_for_mac TEXT,
  reserved_until TIMESTAMPTZ,
  transaction_id UUID,
  resume_token_hash TEXT,
  resume_token_mac_count INTEGER NOT NULL DEFAULT 0,
  resume_token_macs TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.vouchers TO anon, authenticated;
GRANT ALL ON public.vouchers TO service_role;
ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public select" ON public.vouchers FOR SELECT USING (true);
CREATE POLICY "Allow public update" ON public.vouchers FOR UPDATE USING (true);
CREATE POLICY "Allow public insert" ON public.vouchers FOR INSERT WITH CHECK (true);
CREATE INDEX idx_vouchers_unused_pkg ON public.vouchers (package_type) WHERE is_used = false;
CREATE INDEX vouchers_resume_token_hash_idx ON public.vouchers (resume_token_hash) WHERE resume_token_hash IS NOT NULL;
CREATE INDEX idx_vouchers_transaction ON public.vouchers (transaction_id);

CREATE TABLE public.package_pricing (
  package_type TEXT PRIMARY KEY,
  price_kes NUMERIC NOT NULL,
  duration_hours INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.package_pricing TO anon, authenticated;
GRANT ALL ON public.package_pricing TO service_role;
ALTER TABLE public.package_pricing ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read pricing" ON public.package_pricing FOR SELECT USING (true);
INSERT INTO public.package_pricing (package_type, price_kes, duration_hours, display_name)
VALUES ('2hour', 10, 2, '2-Hour Package'), ('24hour', 30, 24, '24-Hour Package');

CREATE TABLE public.voucher_swaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_request_id TEXT,
  client_mac TEXT,
  rejected_code TEXT NOT NULL,
  new_code TEXT,
  package_type TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.voucher_swaps TO anon, authenticated;
GRANT ALL ON public.voucher_swaps TO service_role;
ALTER TABLE public.voucher_swaps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view swap logs" ON public.voucher_swaps FOR SELECT USING (true);
CREATE INDEX idx_voucher_swaps_created_at ON public.voucher_swaps (created_at DESC);
CREATE INDEX idx_voucher_swaps_checkout ON public.voucher_swaps (checkout_request_id);

CREATE TABLE public.session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  voucher_code TEXT,
  package_type TEXT,
  duration_hours INTEGER,
  transaction_id UUID,
  checkout_request_id TEXT,
  client_mac TEXT,
  previous_mac TEXT,
  resume_source TEXT,
  outcome TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.session_events TO anon, authenticated;
GRANT ALL ON public.session_events TO service_role;
ALTER TABLE public.session_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view session events" ON public.session_events FOR SELECT USING (true);
CREATE INDEX idx_session_events_created_at ON public.session_events (created_at DESC);
CREATE INDEX idx_session_events_type ON public.session_events (event_type);
CREATE INDEX idx_session_events_mac ON public.session_events (client_mac);
CREATE INDEX idx_session_events_checkout ON public.session_events (checkout_request_id);

-- ========== TRIGGERS ==========
CREATE OR REPLACE FUNCTION public.sync_voucher_is_used()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.is_used := (NEW.status = 'used');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_sync_voucher_is_used
BEFORE INSERT OR UPDATE ON public.vouchers
FOR EACH ROW EXECUTE FUNCTION public.sync_voucher_is_used();

-- ========== FUNCTIONS ==========
CREATE OR REPLACE FUNCTION public.claim_voucher_for_package(_package_type text, _client_mac text DEFAULT NULL::text)
RETURNS TABLE(code text, duration_hours integer, package_type text)
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE _claimed_id uuid;
BEGIN
  SELECT v.id INTO _claimed_id FROM public.vouchers v
  WHERE v.is_used = false AND v.package_type = _package_type
    AND (_client_mac IS NULL OR (COALESCE(v.used_by_mac,'') <> _client_mac AND COALESCE(v.reserved_for_mac,'') <> _client_mac))
  ORDER BY v.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF _claimed_id IS NULL THEN RETURN; END IF;
  UPDATE public.vouchers SET status='used', is_used=true, used_at=now(), used_by_mac=_client_mac
   WHERE id=_claimed_id
  RETURNING vouchers.code, vouchers.duration_hours, vouchers.package_type INTO code, duration_hours, package_type;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_voucher_for_transaction(_transaction_id uuid, _package_type text, _client_mac text DEFAULT NULL)
RETURNS TABLE(code text, duration_hours integer, package_type text)
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _id uuid;
BEGIN
  SELECT v.id INTO _id FROM public.vouchers v WHERE v.transaction_id = _transaction_id LIMIT 1;
  IF _id IS NULL THEN
    SELECT v.id INTO _id FROM public.vouchers v
    WHERE v.is_used = false AND v.package_type = _package_type
      AND (v.reserved_until IS NULL OR v.reserved_until < now())
      AND (_client_mac IS NULL OR (COALESCE(v.used_by_mac,'') <> _client_mac AND COALESCE(v.reserved_for_mac,'') <> _client_mac))
    ORDER BY v.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF _id IS NULL THEN RETURN; END IF;
  END IF;
  UPDATE public.vouchers v
     SET status='used', is_used=true, used_at=COALESCE(v.used_at, now()),
         used_by_mac=COALESCE(v.used_by_mac, _client_mac),
         transaction_id=_transaction_id, reserved_until=NULL
   WHERE v.id = _id
  RETURNING v.code, v.duration_hours, v.package_type INTO code, duration_hours, package_type;
  UPDATE public.transactions t SET voucher_code = code, updated_at = now()
   WHERE t.id = _transaction_id AND t.voucher_code IS DISTINCT FROM code;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.swap_voucher_for_mpesa(_checkout_request_id text, _client_mac text, _rejected_code text)
RETURNS TABLE(code text, duration_hours integer, package_type text)
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE _pkg text; _new_id uuid;
BEGIN
  UPDATE public.vouchers SET status='used', is_used=true, used_at=COALESCE(used_at, now()),
         used_by_mac=COALESCE(used_by_mac, _client_mac)
   WHERE vouchers.code = _rejected_code;
  SELECT v.package_type INTO _pkg FROM public.vouchers v WHERE v.code = _rejected_code LIMIT 1;
  IF _pkg IS NULL THEN
    SELECT t.package_type INTO _pkg FROM public.transactions t WHERE t.checkout_request_id = _checkout_request_id LIMIT 1;
  END IF;
  IF _pkg IS NULL THEN RETURN; END IF;
  SELECT v.id INTO _new_id FROM public.vouchers v
  WHERE v.is_used = false AND v.package_type = _pkg AND v.code <> _rejected_code
    AND (_client_mac IS NULL OR (COALESCE(v.used_by_mac,'') <> _client_mac AND COALESCE(v.reserved_for_mac,'') <> _client_mac))
  ORDER BY v.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF _new_id IS NULL THEN RETURN; END IF;
  UPDATE public.vouchers SET status='used', is_used=true, used_at=now(), used_by_mac=_client_mac
   WHERE id = _new_id
  RETURNING vouchers.code, vouchers.duration_hours, vouchers.package_type INTO code, duration_hours, package_type;
  UPDATE public.client_authorizations SET mpesa_receipt = 'VC-' || code, updated_at = now()
   WHERE checkout_request_id = _checkout_request_id;
  UPDATE public.transactions SET voucher_code = code, updated_at = now()
   WHERE checkout_request_id = _checkout_request_id;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resume_session_by_token(_token_hash text, _client_mac text)
RETURNS TABLE(voucher_code text, package_type text, duration_hours integer, paid_at timestamptz)
LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE _v_id uuid; _used_at timestamptz; _duration integer; _macs text[]; _mac_count integer;
BEGIN
  IF _token_hash IS NULL OR length(_token_hash) < 32 THEN RETURN; END IF;
  SELECT v.id, v.used_at, v.duration_hours, v.resume_token_macs, v.resume_token_mac_count
    INTO _v_id, _used_at, _duration, _macs, _mac_count
    FROM public.vouchers v WHERE v.resume_token_hash = _token_hash AND v.status = 'used' LIMIT 1;
  IF _v_id IS NULL THEN RETURN; END IF;
  IF _used_at IS NULL OR (_used_at + make_interval(hours => COALESCE(_duration, 2))) < now() THEN RETURN; END IF;
  IF _client_mac IS NOT NULL AND NOT (_client_mac = ANY(_macs)) THEN
    IF COALESCE(_mac_count, 0) >= 5 THEN RETURN; END IF;
    UPDATE public.vouchers
       SET resume_token_macs = array_append(_macs, _client_mac),
           resume_token_mac_count = COALESCE(_mac_count,0) + 1,
           used_by_mac = COALESCE(used_by_mac, _client_mac)
     WHERE id = _v_id;
  END IF;
  RETURN QUERY SELECT v.code, v.package_type, v.duration_hours, v.used_at FROM public.vouchers v WHERE v.id = _v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_session_for_mac(_client_mac text)
RETURNS TABLE(voucher_code text, package_type text, duration_hours integer, paid_at timestamptz)
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF _client_mac IS NULL OR length(_client_mac) = 0 THEN RETURN; END IF;
  RETURN QUERY
    SELECT v.code, v.package_type, v.duration_hours, v.used_at
      FROM public.vouchers v
     WHERE v.status = 'used'
       AND v.used_at IS NOT NULL
       AND (v.used_by_mac = _client_mac OR _client_mac = ANY(v.resume_token_macs))
       AND (v.used_at + make_interval(hours => COALESCE(v.duration_hours, 2))) > now()
     ORDER BY v.used_at DESC
     LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_voucher_for_package(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_voucher_for_transaction(uuid, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.swap_voucher_for_mpesa(text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_session_by_token(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_session_for_mac(text) TO anon, authenticated, service_role;

-- ========== REALTIME ==========
ALTER TABLE public.transactions REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='transactions') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions';
  END IF;
END $$;