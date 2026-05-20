
CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'doorbell',
  access_code text NOT NULL UNIQUE,
  last_ring_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own devices" ON public.devices
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own devices" ON public.devices
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own devices" ON public.devices
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users delete own devices" ON public.devices
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX devices_user_id_idx ON public.devices(user_id);
CREATE INDEX devices_access_code_idx ON public.devices(access_code);
