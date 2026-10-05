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
const OMADA_HOST = OMADA_URL ? new URL(OMADA_URL).hostname : '';
const OMADAC_ID = Deno.env.get('OMADA_OMADAC_ID') ?? '';
const SITE_ID = Deno.env.get('OMADA_SITE_ID') ?? '';
const CID = Deno.env.get('OMADA_CLIENT_ID') ?? '';
const CSECRET = Deno.env.get('OMADA_CLIENT_SECRET') ?? '';
const OP_USER = Deno.env.get('OMADA_OPERATOR_USER') ?? '';
const OP_PASS = Deno.env.get('OMADA_OPERATOR_PASSWORD') ?? '';

const SPEED_BY_HOURS = (h: number) => (h <= 2 ? 5 : h <= 24 ? 10 : 15);
const PKG_BY_HOURS = (h: number) => (h <= 2 ? '2hour' : h <= 24 ? '24hour' : h <= 168 ? '1week' : '1month');

const normMac = (m: string) => (m || '').trim().toUpperCase().replace(/:/g, '-');
// Public self-signed certificate of the configured controller (pinned; not a secret).
const CONTROLLER_CERT = `-----BEGIN CERTIFICATE-----
MIIFJDCCAwygAwIBAgIRAN4hsLJDpGStagHYkxENoeEwDQYJKoZIhvcNAQELBQAw
ODESMBAGA1UEAwwJbG9jYWxob3N0MRAwDgYDVQQKDAdUUC1MaW5rMRAwDgYDVQQL
DAdUUC1MaW5rMB4XDTI1MTEwODE0MTQxM1oXDTI4MDIxMTE0MTQxM1owODESMBAG
A1UEAwwJbG9jYWxob3N0MRAwDgYDVQQKDAdUUC1MaW5rMRAwDgYDVQQLDAdUUC1M
aW5rMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr8z60pdTK+tgiP6g
3PZfyyx9HaBt19H/g+gjDeAkgOfyb7ZBm6Xk1+kZzIiuIwRTdvxIeuEoeL1SHwuJ
Tpb1vFOXKnFy2ZEAF6n82619odcigndeY7bXAR1Pfn5gOV87hyOi1jOg04FwFM8I
VTmTTXBPJwgR2xkIyFZiPFVmY5a6X8swVfqX6/nkH50Iy+GInIWgC8aUi6TS05RA
nC2upLJz464AgITwa9w0OCIkyNhj12egBe7BisnXsQobtVwI5T9ZimHQIAafPTM4
ecTQNm0tFs6At4LSOkyWcV48Vc279dNCDvHV2iRmM8oIbb7gTbVJVEeP6FFRa3Gj
H+fDXKrR1EmQqx92LqPKv6Z6xzyOj5uvvDIRL3WSQ12+ElunxvbTapXrTPEKAn45
BAp8xPH+FfsT5VG4dCq1KYVXJ8C4dhgJa+3HYr2B5U2S1xndQ1YwXczyOO80Ouw0
Zkb3Z/L8ZNKEhS2WTcxU/p64cVuu32McKxPbFdV/nJjEw6EA+LUBpLZvUnkcCnXp
r5OvLDmzovc2hGkmOWa+Dsazy5UR4ixp6qxMgyA4Xqi+5T6J19Q6huNQZZpRNFZ/
AxAfUzINUgRgBQupddba1j7tqTnxbT6JuIN/59ViGzxyWEWbIsv6TD2zf9hprifn
UIwbrcxJAxx9OhM2KCQIcmIlOC0CAwEAAaMpMCcwEwYDVR0lBAwwCgYIKwYBBQUH
AwEwEAYDVR0RBAkwB4IFT21hZGEwDQYJKoZIhvcNAQELBQADggIBAH/aDK+IWIGR
f9bxbU3jbh29of1D2anxldVeUlVPEBrGFF8dPmTnfJqIAawxY2LAyBKRcPlqi3yU
Afx3Y11EYZxVDQl4DPb0edxL3Q5LrkDnJPRgKWRRDaps1ERPBitq0pZD13omT75S
76NSnTyaT7vWYk2ZdLa35izAylskOYDbM/HPEY6d3yDKGC299yRQFPKW1ic7yGYT
RhASd/HEPW+RoYp6KLUkh/HXr3vL3aq1aJOBgQZju/LDQDpfy6F7qqACLWUApJCl
U0H14+h0qvV5EBYluCi8LsIbC6hGpGGr3a228D6ghi9YHf1K+3I9gMlMEsknN20O
lUqAKW634uRkAWBNnr6GvW1BC3rGPEu3FFSdr/p/Y2lwVMwv64YO70F/mOBb1Ip9
IHLTnAECcodjrF+dnj12oiiZOQgJIUUUTto2cPh1p/aqZ21IuwgC6iqsDB+AUEKJ
goaAH++vp6IwyYKeh5f8U846Wmh0ygYcjUmG3wOlCwEKecWZvZCRz4hkBRvkztiU
Q0jex7D6t5Wlpqdt8GFwhJB3g/97P8iCGlYsNEYoOdFdPyQtMQDnwOhD3y9oktwr
n0VxOSC5lb9117fLjcfxtDpdKVxMyTrHTwZn54ntCsGbJfSq2evlQrGIQyqvukbl
HCnM5FFcqfkA/b704+5nuuFCXxy3OBi+
-----END CERTIFICATE-----
`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function decodeChunked(body: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf(13, offset);
    if (lineEnd < 0 || body[lineEnd + 1] !== 10) break;
    const size = Number.parseInt(decoder.decode(body.slice(offset, lineEnd)).split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    chunks.push(body.slice(start, start + size));
    offset = start + size + 2;
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) { output.set(chunk, position); position += chunk.length; }
  return output;
}
async function omadaFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== OMADA_HOST) throw new Error('Refusing non-controller request');
  // Controller cert is self-signed with SAN "Omada": connect to the IP over TCP,
  // then verify TLS against the pinned cert using its own certificate name.
  const tcp = await Deno.connect({ hostname: target.hostname, port: Number(target.port || 443) });
  const conn = await Deno.startTls(tcp, { hostname: 'Omada', caCerts: [CONTROLLER_CERT] });
  try {
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    headers.set('Host', target.host); headers.set('Connection', 'close'); headers.set('Accept-Encoding', 'identity');
    if (body) headers.set('Content-Length', String(encoder.encode(body).length));
    const head = `${init.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1\r\n${Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    await conn.write(encoder.encode(head + body));
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(16384);
    while (true) {
      let n: number | null = null;
      try { n = await conn.read(buf); } catch (e) { if (chunks.length) break; throw e; }
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    const raw = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let cursor = 0; for (const chunk of chunks) { raw.set(chunk, cursor); cursor += chunk.length; }
    let boundary = -1;
    for (let i = 0; i < raw.length - 3; i++) if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) { boundary = i; break; }
    if (boundary < 0) throw new Error('Invalid controller response');
    const lines = decoder.decode(raw.slice(0, boundary)).split('\r\n');
    const responseHeaders = new Headers();
    for (const line of lines.slice(1)) { const split = line.indexOf(':'); if (split > 0) responseHeaders.append(line.slice(0, split).trim(), line.slice(split + 1).trim()); }
    const responseBody = responseHeaders.get('transfer-encoding')?.toLowerCase() === 'chunked' ? decodeChunked(raw.slice(boundary + 4)) : raw.slice(boundary + 4);
    return new Response(responseBody, { status: Number(lines[0]?.split(' ')[1] ?? 500), headers: responseHeaders });
  } finally { try { conn.close(); } catch { /* already closed */ } }
}
async function fetchT(url: string, init: RequestInit = {}, ms = 8000) {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      omadaFetch(url, init),
      new Promise<Response>((_, rej) => { t = setTimeout(() => rej(new Error('controller timeout')), ms); }),
    ]);
  } finally { clearTimeout(t); }
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
      time: Math.round(o.seconds) * 1000, authType: 4, // milliseconds
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
    const { data: local } = await sb.from('vouchers').select('*').eq('code', code).maybeSingle();
    // If we already recorded this voucher's start time, our own clock is the source of truth
    // for remaining time (controller "status 2" also covers used/in-use codes, not only expired).
    const localStillActive = !!(local?.used_at && (Date.now() - new Date(local.used_at).getTime()) < Number(local.duration_hours || 2) * 3600_000);
    let minutes = 0, source = 'omada';
    let controllerOk = true;
    try {
      const v = await findOnController(code);
      if (v) {
        if (v.expired && !localStillActive) { log({ outcome: 'expired' }); return json({ success: false, error: 'This voucher has expired.' }); }
        minutes = localStillActive ? Number(local!.duration_hours) * 60 : v.minutes;
      }
    } catch (e) { controllerOk = false; console.warn('[redeem] controller lookup failed', e); }
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
