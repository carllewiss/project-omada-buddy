// Omada Open API — issue a single-use voucher whose online time matches the
// package the customer paid for, and (optionally) log the event.
//
// POST { packageType?: "2hour" | "24hour", durationHours?: number, clientMac?: string }
//  ->  { success: true, code, durationHours, packageType, groupId }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const OMADA_URL = (Deno.env.get('OMADA_URL') ?? '').replace(/\/+$/, '');
const OMADAC_ID = Deno.env.get('OMADA_OMADAC_ID') ?? '';
const SITE_ID = Deno.env.get('OMADA_SITE_ID') ?? '';
const CLIENT_ID = Deno.env.get('OMADA_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('OMADA_CLIENT_SECRET') ?? '';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

async function accessToken(): Promise<string> {
  const res = await fetch(`${OMADA_URL}/openapi/authorize/token?grant_type=client_credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      omadacId: OMADAC_ID,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (data?.errorCode !== 0) throw new Error(data?.msg || 'Omada token request failed');
  return data.result.accessToken as string;
}

/** 1 code, 1 device, `durationHours` of online time counted from first login. */
async function createVoucher(durationHours: number, label: string, priceKes: number) {
  const token = await accessToken();
  const base = `${OMADA_URL}/openapi/v1/${OMADAC_ID}/sites/${SITE_ID}/hotspot/voucher-groups`;
  const headers = { 'Content-Type': 'application/json', Authorization: `AccessToken=${token}` };

  const createRes = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: label.slice(0, 60),
      amount: 1,
      codeLength: 8,
      codeForm: [0],
      limitType: 0,
      limitNum: 1,
      durationType: 0,
      duration: Math.round(durationHours * 60),
      timingType: 0,
      rateLimit: { mode: 0, customRateLimit: { downLimitEnable: false, upLimitEnable: false } },
      trafficLimitEnable: false,
      trafficLimitFrequency: 0,
      unitPrice: Math.max(1, Math.round(priceKes)),
      currency: 'AUD',
      applyToAllPortals: true,
      validityType: 0,
      logout: true,
      description: label,
    }),
  });
  const created = await createRes.json();
  if (created?.errorCode !== 0) throw new Error(created?.msg || 'Voucher creation failed');
  const groupId = created.result.id as string;

  const listRes = await fetch(`${base}/${groupId}?page=1&pageSize=1`, { headers });
  const list = await listRes.json();
  const code = list?.result?.data?.[0]?.code as string | undefined;
  if (!code) throw new Error('Voucher created but no code returned');
  return { code, groupId };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (!OMADA_URL || !OMADAC_ID || !SITE_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return json({ success: false, error: 'Controller not configured' }, 500);
  }

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const packageType = String(body.packageType ?? '2hour');
    const clientMac = body.clientMac ? String(body.clientMac) : null;
    let durationHours = Number(body.durationHours ?? 0);
    let price = 10;

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (!durationHours) {
      const { data } = await sb
        .from('package_pricing')
        .select('duration_hours, price_kes')
        .eq('package_type', packageType)
        .maybeSingle();
      durationHours = Number(data?.duration_hours ?? 2);
      price = Number(data?.price_kes ?? 10);
    }

    if (!(durationHours > 0 && durationHours <= 720)) {
      return json({ success: false, error: 'Invalid duration' }, 400);
    }

    const { code, groupId } = await createVoucher(
      durationHours,
      `MPESA ${packageType} ${new Date().toISOString().slice(0, 16)}`,
      price,
    );

    await sb.from('session_events').insert({
      event_type: 'omada_voucher_created',
      voucher_code: code,
      package_type: packageType,
      duration_hours: durationHours,
      client_mac: clientMac,
      outcome: 'issued',
      details: { groupId, source: 'omada_open_api' },
    });

    return json({ success: true, code, durationHours, packageType, groupId });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 200);
  }
});
