ALTER TABLE public.package_pricing ADD COLUMN IF NOT EXISTS speed_mbps integer NOT NULL DEFAULT 5;
INSERT INTO public.package_pricing (package_type, price_kes, duration_hours, display_name, speed_mbps) VALUES
  ('2hour', 10, 2, '2-Hour Package', 5),
  ('24hour', 30, 24, '24-Hour Package', 10),
  ('1week', 180, 168, '1-Week Package', 15),
  ('1month', 720, 720, '1-Month Package', 15)
ON CONFLICT (package_type) DO UPDATE SET price_kes = EXCLUDED.price_kes, duration_hours = EXCLUDED.duration_hours,
  display_name = EXCLUDED.display_name, speed_mbps = EXCLUDED.speed_mbps, updated_at = now();