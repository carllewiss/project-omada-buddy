// Portal (External Portal): customer enters a voucher code.
// 1. Confirm the code with the Omada controller (exists, not expired).
//    Falls back to the local voucher pool if the controller can't be searched.
// 2. Block reuse on a different device.
// 3. Authorize the client MAC on the controller for the voucher's duration
//    and cap its speed to the package speed.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const OMADA_URL = (Deno.env.get('OMADA_URL') ?? '').replace(/\/+$/, '');
const OMADAC_ID = Deno.env.get('OMADA_OMADAC_ID') ?? '';
const SITE_ID = Deno.env.get('OMADA_SITE_ID') ?? '';
const CID = Deno.env.get('OMADA_CLIENT_ID') ?? '';
const CSECRET = Deno.env.get('OMADA_CLIENT_SECRET') ?? '';
const OP_USER = Deno.env.get('OMADA_OPERATOR_USER') ?? '';
const OP_PASS = Deno.env.get('OMADA_OPERATOR_PASSWORD') ?? '';

const SPEED_BY_HOURS = (h: number) => (h <= 2 ? 5 : h <= 24 ? 10 : 15);
const PKG_BY_HOURS = (h: number) => (h <= 2 ? '2hour' : h <= 24 ? '24hour' : h <= 168 ? '1week' : '1month');

const normMac = (m: string) => (m || '').trim().toUpperCase().replace(/:/g, '-');
async function fetchT(url: string, init: RequestInit = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}
const siteBase = () => `${OMADA_URL}/openapi/v1/${OMADAC_ID}/sites/${SITE_ID}`;
async function accessToken() {
  const r = await fetchT(`${OMADA_URL}/openapi/authorize/token?grant_type=client_credentials`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ omadacId: OMADAC_ID, client_id: CID, client_secret: CSECRET }),
  });
  const d = await r.json();
  if (d?.errorCode !== 0) throw new Error(d?.msg || 'token failed');
  return d.result.accessToken as string;
}

type OmadaVoucher = { code: string; minutes: number; expired: boolean; groupId: string };
/** Look the code up on the controller. null = not found; throws if the controller is unreachable. */
async function findOnController(code: string): Promise<OmadaVoucher | null> {
  const token = await accessToken();
  const headers = { Authorization: `AccessToken=${token}` };
  for (let page = 1; page <= 10; page++) {
    const gr = await (await fetchT(`${siteBase()}/hotspot/voucher-groups?page=${page}&pageSize=100`, { headers })).json();
    if (gr?.errorCode !== 0) throw new Error(gr?.msg || 'group list failed');
    const groups = (gr.result?.data ?? []) as any[];
    for (const g of groups) {
      const vr = await (await fetchT(
        `${siteBase()}/hotspot/voucher-groups/${g.id}?page=1&pageSize=20&searchKey=${encodeURIComponent(code)}`, { headers },
      )).json();
      const v = ((vr?.result?.data ?? []) as any[]).find((x) => String(x.code) === code);
      if (v) {
        const minutes = Number(v.duration ?? g.duration ?? 0) * (Number(g.durationType ?? 0) === 0 ? 1 : 1);
        // status: 0 unused, 1 in use, 2 expired (Omada)
        return { code, minutes: minutes || 120, expired: Number(v.status) === 2, groupId: String(g.id) };
      }
    }
    if (groups.length < 100) break;
  }
  return null;
}

async function authorizeMac(o: { clientMac: string; apMac: string; ssidName: string; radioId: number; seconds: number }) {
  const lr = await fetchT(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: OP_USER, password: OP_PASS }),
  });
  const l = await lr.json().catch(() => ({}));
  if (l?.errorCode !== 0) return { ok: false, error: l?.msg || 'operator login failed' };
  const cookie = (lr.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  const r = await fetchT(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/extPortal/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Csrf-Token': l.result?.token, Cookie: cookie },
    body: JSON.stringify({
      clientMac: normMac(o.clientMac), apMac: normMac(o.apMac), ssidName: o.ssidName,
      radioId: Number.isFinite(o.radioId) ? o.radioId : 0, site: SITE_ID,
      time: Math.round(o.seconds) * 1_000_000, authType: 4,
    }),
  });
  const d = await r.json().catch(() => ({}));
  return d?.errorCode === 0 ? { ok: true } : { ok: false, error: d?.msg || `controller ${r.status}` };
}

async function applySpeed(mac: string, mbps: number) {
  try {
    const token = await accessToken();
    const r = await fetchT(`${siteBase()}/clients/${encodeURIComponent(normMac(mac))}/ratelimit`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `AccessToken=${token}` },
      body: JSON.stringify({ mode: 0, customRateLimit: { downEnable: true, downLimit: mbps, downUnit: 2, upEnable: true, upLimit: mbps, upUnit: 2 } }),
    });
    return (await r.json().catch(() => ({})))?.errorCode === 0;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const code = String(body.code ?? '').trim();
    const clientMac = String(body.clientMac ?? '');
    const apMac = String(body.apMac ?? '');
    const ssidName = String(body.ssidName ?? body.ssid ?? '');
    const radioId = Number(body.radioId ?? 0);
    if (!code) return json({ success: false, error: 'Please enter a voucher code.' });
    if (!clientMac) return json({ success: false, error: 'Device not detected. Reconnect to the WiFi and try again.' });

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const log = (row: Record<string, unknown>) => sb.from('session_events').insert({ event_type: 'voucher_redeem', voucher_code: code, client_mac: clientMac, ...row }).then(() => {}, () => {});

    // 1. Validate on the controller (fallback: local pool).
    let minutes = 0, source = 'omada';
    let controllerOk = true;
    try {
      const v = await findOnController(code);
      if (v) {
        if (v.expired) { log({ outcome: 'expired' }); return json({ success: false, error: 'This voucher has expired.' }); }
        minutes = v.minutes;
      }
    } catch (e) { controllerOk = false; console.warn('[redeem] controller lookup failed', e); }

    const { data: local } = await sb.from('vouchers').select('*').eq('code', code).maybeSingle();
    if (!minutes) {
      if (!local) { log({ outcome: 'invalid', details: { controllerOk } }); return json({ success: false, error: 'Invalid voucher code.' }); }
      minutes = Number(local.duration_hours || 2) * 60; source = 'local';
    }

    // 2. One device per voucher; same device gets remaining time only.
    let seconds = minutes * 60;
    const now = Date.now();
    if (local?.used_by_mac && local.used_at) {
      const elapsed = (now - new Date(local.used_at).getTime()) / 1000;
      if (elapsed >= seconds) { log({ outcome: 'expired' }); return json({ success: false, error: 'This voucher has expired.' }); }
      const macs: string[] = local.resume_token_macs || [local.used_by_mac];
      if (normMac(local.used_by_mac) !== normMac(clientMac) && !macs.map(normMac).includes(normMac(clientMac))) {
        log({ outcome: 'reuse_blocked', previous_mac: local.used_by_mac });
        return json({ success: false, error: 'This voucher is already in use on another device.' });
      }
      seconds = Math.round(seconds - elapsed);
    }

    const hours = minutes / 60;
    const packageType = local?.package_type || PKG_BY_HOURS(hours);
    const mbps = SPEED_BY_HOURS(hours);

    // 3. Authorize the MAC.
    const granted = await authorizeMac({ clientMac, apMac, ssidName, radioId, seconds });
    if (!granted.ok) {
      log({ outcome: 'auth_failed', details: { error: granted.error } });
      return json({ success: false, error: 'Voucher is valid but the WiFi controller could not connect you. Please try again.' });
    }
    const speedOk = await applySpeed(clientMac, mbps);
    const usedAt = local?.used_at ?? new Date(now).toISOString();
    if (local) {
      await sb.from('vouchers').update({ status: 'used', used_at: usedAt, used_by_mac: local.used_by_mac ?? clientMac }).eq('id', local.id);
    } else {
      await sb.from('vouchers').insert({ code, package_type: packageType, duration_hours: Math.round(hours), status: 'used', used_at: usedAt, used_by_mac: clientMac, resume_token_macs: [clientMac] });
    }
    await sb.from('client_authorizations').insert({
      mac_address: clientMac, ap_mac: apMac || null, ssid: ssidName || null, phone_number: 'voucher', amount: 0,
      package_type: packageType, duration_hours: Math.round(hours), payment_status: 'paid', authorization_status: 'yes', mpesa_receipt: `VC-${code}`,
    });
    log({ outcome: 'authorized', package_type: packageType, duration_hours: hours, details: { source, seconds, speed_mbps: mbps, speed_applied: speedOk } });

    return json({
      success: true, method: 'api', packageType, durationHours: hours, speedMbps: mbps,
      expiresAt: new Date(now + seconds * 1000).toISOString(),
    });
  } catch (e) {
    console.error('portal-redeem-voucher error', e);
    return json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});
