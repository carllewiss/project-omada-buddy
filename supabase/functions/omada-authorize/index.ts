// Omada authorization service.
//
// PRIMARY  : authorize the client MAC directly on the controller for exactly the
//            duration of the package purchased (External Portal auth, authType 4).
// SECONDARY: mint a single-use voucher via the Omada Open API (used by the portal
//            as a fallback when direct MAC authorization is unavailable).
// STATUS   : pull live client state from the Open API to confirm the MAC is still
//            connected / authorized.
//
// POST { action: 'authorize' | 'status' | 'voucher', ... }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const OMADA_URL = (Deno.env.get('OMADA_URL') ?? '').replace(/\/+$/, '');
const OMADA_HOST = OMADA_URL ? new URL(OMADA_URL).hostname : '';
const OMADA_HTTP_CLIENT = Deno.createHttpClient({
  // Trust the self-signed certificate only for this configured controller.
  unsafelyIgnoreCertificateErrors: OMADA_HOST ? [OMADA_HOST] : [],
});
const OMADAC_ID = Deno.env.get('OMADA_OMADAC_ID') ?? '';
const SITE_ID = Deno.env.get('OMADA_SITE_ID') ?? '';
const CLIENT_ID = Deno.env.get('OMADA_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('OMADA_CLIENT_SECRET') ?? '';
const OPERATOR_USER = Deno.env.get('OMADA_OPERATOR_USER') ?? '';
const OPERATOR_PASS = Deno.env.get('OMADA_OPERATOR_PASSWORD') ?? '';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const omadaFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, client: OMADA_HTTP_CLIENT } as RequestInit & { client: Deno.HttpClient });

// ---------------------------------------------------------------- Open API --
async function accessToken(): Promise<string> {
  const res = await omadaFetch(`${OMADA_URL}/openapi/authorize/token?grant_type=client_credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ omadacId: OMADAC_ID, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const data = await res.json();
  if (data?.errorCode !== 0) throw new Error(data?.msg || 'Omada token request failed');
  return data.result.accessToken as string;
}

const normMac = (m: string) => (m || '').trim().toUpperCase().replace(/:/g, '-');

/** Live client state straight from the controller. */
async function clientState(mac: string) {
  const token = await accessToken();
  const headers = { Authorization: `AccessToken=${token}` };
  const target = normMac(mac);

  // Authorization record for this MAC (present while an auth is in force).
  let authorized = false;
  let authInfo: unknown = null;
  try {
    const r = await omadaFetch(
      `${OMADA_URL}/openapi/v1/${OMADAC_ID}/sites/${SITE_ID}/clients/auth?mac=${encodeURIComponent(target)}`,
      { headers },
    );
    const d = await r.json();
    if (d?.errorCode === 0) {
      authorized = true;
      authInfo = d.result ?? null;
    }
  } catch (_) { /* treated as not authorized */ }

  // Connection state from the client list.
  let online = false;
  let client: Record<string, unknown> | null = null;
  for (let page = 1; page <= 5 && !client; page++) {
    const r = await omadaFetch(
      `${OMADA_URL}/openapi/v1/${OMADAC_ID}/sites/${SITE_ID}/clients?page=${page}&pageSize=100`,
      { headers },
    );
    const d = await r.json();
    if (d?.errorCode !== 0) break;
    const rows = (d.result?.data ?? []) as Record<string, unknown>[];
    client = rows.find((c) => normMac(String(c.mac ?? '')) === target) ?? null;
    if (rows.length < 100) break;
  }
  if (client) {
    online = Boolean(client.active);
    if (Number(client.authStatus ?? 0) > 0) authorized = true;
  }

  return { online, authorized, authInfo, client };
}

// ------------------------------------------------- External Portal auth (4) --
// Requires a Hotspot Operator account on the controller
// (Omada > Hotspot Manager > Operator).
async function operatorSession(): Promise<{ csrf: string; cookie: string }> {
  if (!OPERATOR_USER || !OPERATOR_PASS) throw new Error('operator_not_configured');
  const res = await omadaFetch(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: OPERATOR_USER, password: OPERATOR_PASS }),
  });
  const data = await res.json().catch(() => ({}));
  if (data?.errorCode !== 0) throw new Error(data?.msg || 'operator login failed');
  const cookie = (res.headers.get('set-cookie') || '')
    .split(/,(?=[^;]+?=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  return { csrf: data.result?.token as string, cookie };
}

/** Authorize a MAC for `seconds` of access. Returns true on controller success. */
async function authorizeMac(opts: {
  clientMac: string;
  apMac: string;
  ssidName: string;
  radioId: number;
  seconds: number;
}): Promise<{ ok: boolean; error?: string; raw?: unknown }> {
  try {
    const { csrf, cookie } = await operatorSession();
    const body = {
      clientMac: normMac(opts.clientMac),
      apMac: normMac(opts.apMac),
      ssidName: opts.ssidName,
      radioId: Number.isFinite(opts.radioId) ? opts.radioId : 0,
      site: SITE_ID,
      time: Math.round(opts.seconds * 1000), // milliseconds of access
      authType: 4,
    };
    const res = await omadaFetch(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/extPortal/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Csrf-Token': csrf, Cookie: cookie },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    const data = await res.json().catch(() => ({}));
    if (data?.errorCode === 0) return { ok: true, raw: data };
    return { ok: false, error: data?.msg || `controller responded ${res.status}`, raw: data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ------------------------------------------------------------- Voucher path --
async function createVoucher(durationHours: number, label: string, priceKes: number) {
  const token = await accessToken();
  const base = `${OMADA_URL}/openapi/v1/${OMADAC_ID}/sites/${SITE_ID}/hotspot/voucher-groups`;
  const headers = { 'Content-Type': 'application/json', Authorization: `AccessToken=${token}` };

  const createRes = await omadaFetch(base, {
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

  const listRes = await omadaFetch(`${base}/${groupId}?page=1&pageSize=1`, { headers });
  const list = await listRes.json();
  const code = list?.result?.data?.[0]?.code as string | undefined;
  if (!code) throw new Error('Voucher created but no code returned');
  return { code, groupId };
}

// ------------------------------------------------------------------ handler --
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (!OMADA_URL || !OMADAC_ID || !SITE_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return json({ success: false, error: 'Controller not configured' }, 500);
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = String(body.action ?? 'authorize');
    const clientMac = body.clientMac ? String(body.clientMac) : '';

    if (action === 'status') {
      if (!clientMac) return json({ success: false, error: 'clientMac required' }, 400);
      const state = await clientState(clientMac);
      return json({ success: true, ...state });
    }

    const packageType = String(body.packageType ?? '2hour');
    let durationHours = Number(body.durationHours ?? 0);
    let price = 10;

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

    // Seconds left on the package (a resuming device gets the remainder only).
    const remainingSeconds = Number(body.remainingSeconds ?? 0) > 0
      ? Math.min(Number(body.remainingSeconds), durationHours * 3600)
      : durationHours * 3600;

    if (action === 'authorize') {
      if (!clientMac) return json({ success: false, error: 'clientMac required' }, 400);

      const result = await authorizeMac({
        clientMac,
        apMac: String(body.apMac ?? ''),
        ssidName: String(body.ssidName ?? ''),
        radioId: Number(body.radioId ?? 0),
        seconds: remainingSeconds,
      });

      const expiresAt = new Date(Date.now() + remainingSeconds * 1000).toISOString();

      sb.from('session_events').insert({
        event_type: 'mac_authorization',
        package_type: packageType,
        duration_hours: durationHours,
        checkout_request_id: body.checkoutRequestId ? String(body.checkoutRequestId) : null,
        client_mac: clientMac,
        previous_mac: body.previousMac ? String(body.previousMac) : null,
        voucher_code: body.voucherCode ? String(body.voucherCode) : null,
        outcome: result.ok ? 'authorized' : 'failed',
        details: {
          method: 'ext_portal_auth',
          seconds: remainingSeconds,
          expires_at: expiresAt,
          error: result.error ?? null,
        },
      }).then(() => {}, () => {});

      if (!result.ok) return json({ success: false, error: result.error, fallback: 'voucher' });
      return json({ success: true, method: 'api', packageType, durationHours, remainingSeconds, expiresAt });
    }

    if (action === 'voucher') {
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
        client_mac: clientMac || null,
        outcome: 'issued',
        details: { groupId, source: 'omada_open_api' },
      });

      return json({ success: true, method: 'voucher', code, durationHours, packageType, groupId });
    }

    return json({ success: false, error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 200);
  }
});
