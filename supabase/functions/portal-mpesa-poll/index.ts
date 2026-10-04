// Portal: Poll payment status. On confirmed payment:
//   1. PRIMARY  — authorize the paying MAC directly on the Omada controller
//                 (External Portal auth) for exactly the package duration, and
//                 cap its speed to the package speed.
//   2. FALLBACK — hand the portal a voucher (Omada-minted, or from the pool)
//                 which the browser submits to the controller.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ============================ Omada helpers ============================
const OMADA_URL = (Deno.env.get('OMADA_URL') ?? '').replace(/\/+$/, '');
const OMADA_HOST = OMADA_URL ? new URL(OMADA_URL).hostname : '';
const OMADAC_ID = Deno.env.get('OMADA_OMADAC_ID') ?? '';
const SITE_ID = Deno.env.get('OMADA_SITE_ID') ?? '';
const OMADA_CLIENT_ID = Deno.env.get('OMADA_CLIENT_ID') ?? '';
const OMADA_CLIENT_SECRET = Deno.env.get('OMADA_CLIENT_SECRET') ?? '';
const OPERATOR_USER = Deno.env.get('OMADA_OPERATOR_USER') ?? '';
const OPERATOR_PASS = Deno.env.get('OMADA_OPERATOR_PASSWORD') ?? '';

const PACKAGES: Record<string, { hours: number; mbps: number; label: string }> = {
  '2hour': { hours: 2, mbps: 5, label: '2-Hour Package' },
  '24hour': { hours: 24, mbps: 10, label: '24-Hour Package' },
  '1week': { hours: 168, mbps: 15, label: '1-Week Package' },
  '1month': { hours: 720, mbps: 15, label: '1-Month Package' },
};
async function packageInfo(sb: any, packageType: string) {
  const fb = PACKAGES[packageType] ?? PACKAGES['2hour'];
  try {
    const { data } = await sb.from('package_pricing')
      .select('duration_hours, price_kes, speed_mbps, display_name').eq('package_type', packageType).maybeSingle();
    if (data) return {
      hours: Number(data.duration_hours ?? fb.hours), mbps: Number(data.speed_mbps ?? fb.mbps),
      price: Number(data.price_kes ?? 10), label: String(data.display_name ?? fb.label),
    };
  } catch (_) { /* fallback */ }
  return { hours: fb.hours, mbps: fb.mbps, price: 10, label: fb.label };
}

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
async function accessToken(): Promise<string> {
  const res = await fetchT(`${OMADA_URL}/openapi/authorize/token?grant_type=client_credentials`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ omadacId: OMADAC_ID, client_id: OMADA_CLIENT_ID, client_secret: OMADA_CLIENT_SECRET }),
  });
  const d = await res.json();
  if (d?.errorCode !== 0) throw new Error(d?.msg || 'Omada token request failed');
  return d.result.accessToken as string;
}
const siteBase = () => `${OMADA_URL}/openapi/v1/${OMADAC_ID}/sites/${SITE_ID}`;

async function authorizeMac(o: { clientMac: string; apMac: string; ssidName: string; radioId: number; seconds: number }):
  Promise<{ ok: boolean; error?: string; unreachable?: boolean }> {
  if (!OMADA_URL || !OMADAC_ID || !SITE_ID || !OPERATOR_USER || !OPERATOR_PASS) return { ok: false, error: 'not_configured', unreachable: true };
  let csrf = '', cookie = '';
  try {
    const lr = await fetchT(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: OPERATOR_USER, password: OPERATOR_PASS }),
    });
    const l = await lr.json().catch(() => ({}));
    if (l?.errorCode !== 0) return { ok: false, error: l?.msg || 'operator login failed', unreachable: true };
    csrf = l.result?.token;
    cookie = (lr.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  } catch (e) { return { ok: false, error: (e as Error).message, unreachable: true }; }
  try {
    const res = await fetchT(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/extPortal/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Csrf-Token': csrf, Cookie: cookie },
      body: JSON.stringify({
        clientMac: normMac(o.clientMac), apMac: normMac(o.apMac), ssidName: o.ssidName,
        radioId: Number.isFinite(o.radioId) ? o.radioId : 0, site: SITE_ID,
        time: Math.round(o.seconds) * 1_000_000, // microseconds
        authType: 4,
      }),
      redirect: 'manual',
    });
    const d = await res.json().catch(() => ({}));
    if (d?.errorCode === 0) return { ok: true };
    return { ok: false, error: d?.msg || `controller responded ${res.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message, unreachable: true }; }
}

async function applySpeed(mac: string, mbps: number): Promise<boolean> {
  if (!OMADA_URL || !mac || !(mbps > 0)) return false;
  try {
    const token = await accessToken();
    for (let i = 0; i < 3; i++) {
      const r = await fetchT(`${siteBase()}/clients/${encodeURIComponent(normMac(mac))}/ratelimit`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `AccessToken=${token}` },
        body: JSON.stringify({ mode: 0, customRateLimit: {
          downEnable: true, downLimit: Math.round(mbps), downUnit: 2,
          upEnable: true, upLimit: Math.round(mbps), upUnit: 2 } }),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.errorCode === 0) return true;
      await new Promise((res) => setTimeout(res, 1500));
    }
  } catch (e) { console.error('[omada] applySpeed failed', e); }
  return false;
}

async function speedProfileId(headers: Record<string, string>, mbps: number): Promise<string | null> {
  try {
    const r = await fetchT(`${siteBase()}/rate-limit-profiles`, { headers });
    const d = await r.json();
    const p = ((d?.result ?? []) as any[]).find((x) => Number(x.downLimit) === mbps * 1024);
    return p?.profileId ?? null;
  } catch { return null; }
}

async function mintOmadaVoucher(hours: number, mbps: number, label: string, priceKes: number) {
  if (!OMADA_URL || !OMADA_CLIENT_ID) return null;
  try {
    const token = await accessToken();
    const headers = { 'Content-Type': 'application/json', Authorization: `AccessToken=${token}` };
    const profileId = await speedProfileId(headers, mbps);
    const base = `${siteBase()}/hotspot/voucher-groups`;
    const cRes = await fetchT(base, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: label.slice(0, 60), amount: 1, codeLength: 8, codeForm: [0],
        limitType: 0, limitNum: 1, durationType: 0, duration: Math.round(hours * 60), timingType: 0,
        rateLimit: profileId
          ? { mode: 1, rateLimitProfileId: profileId }
          : { mode: 0, customRateLimit: { downLimitEnable: false, upLimitEnable: false } },
        trafficLimitEnable: false, trafficLimitFrequency: 0,
        unitPrice: Math.max(1, Math.round(priceKes)), currency: 'AUD',
        applyToAllPortals: true, validityType: 0, logout: true, description: label,
      }),
    });
    const created = await cRes.json();
    if (created?.errorCode !== 0) throw new Error(created?.msg || 'create failed');
    const groupId = created.result.id as string;
    const list = await (await fetchT(`${base}/${groupId}?page=1&pageSize=1`, { headers })).json();
    const code = list?.result?.data?.[0]?.code as string | undefined;
    if (!code) throw new Error('no code returned');
    return { code, groupId };
  } catch (e) {
    console.error('[omada] voucher mint failed', e);
    return null;
  }
}
// ======================================================================

async function mintResumeToken(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { token, hash };
}

const REVEAL_WINDOW_MS = 6 * 60 * 1000;
async function revealAllowedFor(supabase: any, code: string, paidAtIso: string | null): Promise<boolean> {
  if (!code || !paidAtIso || code.startsWith('MAC-')) return false;
  const paidAt = new Date(paidAtIso).getTime();
  if (!paidAt || Number.isNaN(paidAt) || Date.now() - paidAt >= REVEAL_WINDOW_MS) return false;
  try {
    const { data } = await supabase.from('session_events').select('client_mac')
      .eq('voucher_code', code).not('client_mac', 'is', null).limit(200);
    if (new Set((data || []).map((r: any) => r.client_mac)).size >= 3) return false;
  } catch (_) { /* ignore */ }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { checkoutRequestId, clientMac, apMac, ssidName, radioId } = await req.json();
    if (!checkoutRequestId) return json({ error: 'checkoutRequestId required' }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: tx } = await supabase.from('transactions').select('*')
      .eq('checkout_request_id', checkoutRequestId).maybeSingle();

    if (!tx) return json({ status: 'unknown' });
    if (tx.status === 'pending') return json({ status: 'pending' });
    if (tx.status === 'failed' || tx.status === 'cancelled') {
      return json({ status: 'failed', error: tx.result_desc || 'Payment failed' });
    }
    if (tx.status !== 'success' && tx.status !== 'paid') return json({ status: tx.status });

    const paidAtIso = tx.updated_at || tx.created_at || new Date().toISOString();
    const pkg = await packageInfo(supabase, tx.package_type);

    const { data: auth } = await supabase.from('client_authorizations')
      .select('authorization_status, mac_address, mpesa_receipt')
      .eq('checkout_request_id', checkoutRequestId).maybeSingle();

    // Already authorized through the API (repeat poll) — just report it.
    if (auth?.authorization_status === 'yes' && tx.voucher_code?.startsWith('MAC-')) {
      return json({
        status: 'success', method: 'api', voucher: tx.voucher_code, packageType: tx.package_type,
        packageLabel: pkg.label, durationHours: pkg.hours, paidAt: paidAtIso, revealAllowed: false,
      });
    }

    // ---------------- PRIMARY: authorize this MAC on the controller ----------------
    // Runs even when the payment callback already reserved a fallback voucher.
    // Skipped once we've already fallen back to a voucher (keeps repeat polls fast).
    if (clientMac && auth && auth.authorization_status !== 'voucher') {
      // Lock: only one poll at a time may authorize (prevents double approvals).
      const nowIso = new Date().toISOString();
      const staleIso = new Date(Date.now() - 30_000).toISOString();
      const { data: lock } = await supabase.from('client_authorizations')
        .update({ authorization_status: 'processing', updated_at: nowIso })
        .eq('checkout_request_id', checkoutRequestId)
        .or(`authorization_status.eq.no,and(authorization_status.eq.processing,updated_at.lt.${staleIso})`)
        .select('id');
      if (!lock || lock.length === 0) return json({ status: 'pending' });

      const seconds = pkg.hours * 3600;
      const granted = await authorizeMac({
        clientMac, apMac: apMac || tx.ap_mac || '', ssidName: ssidName || tx.ssid || '',
        radioId: Number(radioId ?? 0), seconds,
      });

      if (granted.ok) {
        const speedOk = await applySpeed(clientMac, pkg.mbps);

        // Return the unsubmitted fallback voucher (if any) to the pool.
        if (tx.voucher_code && !tx.voucher_code.startsWith('MAC-')) {
          await supabase.from('vouchers')
            .update({ status: 'unused', used_at: null, used_by_mac: null, transaction_id: null })
            .eq('code', tx.voucher_code);
        }

        const grantCode = `MAC-${String(tx.id).slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;
        const { token, hash } = await mintResumeToken();
        await supabase.from('vouchers').insert({
          code: grantCode, package_type: tx.package_type, duration_hours: pkg.hours,
          status: 'used', used_at: new Date().toISOString(), used_by_mac: clientMac,
          transaction_id: tx.id, resume_token_hash: hash, resume_token_macs: [clientMac], resume_token_mac_count: 1,
        });
        await supabase.from('transactions')
          .update({ voucher_code: grantCode, updated_at: new Date().toISOString() }).eq('id', tx.id);
        await supabase.from('client_authorizations').update({
          payment_status: 'paid', authorization_status: 'yes', mac_address: clientMac,
          duration_hours: pkg.hours, mpesa_receipt: `API-${grantCode}`, updated_at: new Date().toISOString(),
        }).eq('checkout_request_id', checkoutRequestId);

        await supabase.from('session_events').insert({
          event_type: 'mac_authorization', voucher_code: grantCode, package_type: tx.package_type,
          duration_hours: pkg.hours, transaction_id: tx.id, checkout_request_id: checkoutRequestId,
          client_mac: clientMac, outcome: 'authorized',
          details: { method: 'ext_portal_auth', seconds, speed_mbps: pkg.mbps, speed_applied: speedOk },
        });

        return json({
          status: 'success', method: 'api', voucher: grantCode, packageType: tx.package_type,
          packageLabel: pkg.label, durationHours: pkg.hours, paidAt: paidAtIso,
          expiresAt: new Date(Date.now() + seconds * 1000).toISOString(), revealAllowed: false, resumeToken: token,
        });
      }

      await supabase.from('session_events').insert({
        event_type: 'mac_authorization', package_type: tx.package_type, duration_hours: pkg.hours,
        transaction_id: tx.id, checkout_request_id: checkoutRequestId, client_mac: clientMac,
        outcome: 'failed', details: { method: 'ext_portal_auth', error: granted.error, unreachable: !!granted.unreachable },
      });
      console.warn('[omada] direct MAC auth failed, falling back to voucher:', granted.error);
      await supabase.from('client_authorizations')
        .update({ authorization_status: 'voucher', updated_at: new Date().toISOString() })
        .eq('checkout_request_id', checkoutRequestId);
    }

    // ---------------- FALLBACK: voucher ----------------
    let code: string | null = tx.voucher_code && !tx.voucher_code.startsWith('MAC-') ? tx.voucher_code : null;
    if (!code && auth?.mpesa_receipt?.startsWith('VC-')) code = auth.mpesa_receipt.substring(3);

    if (!code) {
      const minted = await mintOmadaVoucher(pkg.hours, pkg.mbps, `MPESA ${tx.package_type} ${checkoutRequestId}`, pkg.price);
      if (minted) {
        code = minted.code;
        await supabase.from('vouchers').insert({
          code, package_type: tx.package_type, duration_hours: pkg.hours, status: 'used',
          used_at: new Date().toISOString(), used_by_mac: clientMac || null, transaction_id: tx.id,
        });
        await supabase.from('session_events').insert({
          event_type: 'voucher_issued', voucher_code: code, package_type: tx.package_type,
          duration_hours: pkg.hours, transaction_id: tx.id, checkout_request_id: checkoutRequestId,
          client_mac: clientMac || null, outcome: 'issued', details: { source: 'omada_open_api', groupId: minted.groupId },
        });
      }
    }

    if (!code) {
      const { data: claimed, error: claimErr } = await supabase.rpc('claim_voucher_for_transaction', {
        _transaction_id: tx.id, _package_type: tx.package_type, _client_mac: clientMac || null,
      });
      if (claimErr || !claimed || claimed.length === 0) {
        return json({ status: 'no_voucher', error: 'Payment received but no vouchers available. Please contact support.' });
      }
      code = claimed[0].code;
    }

    await supabase.from('client_authorizations').update({
      payment_status: 'paid', mpesa_receipt: `VC-${code}`, mac_address: clientMac || null,
      duration_hours: pkg.hours, updated_at: new Date().toISOString(),
    }).eq('checkout_request_id', checkoutRequestId);

    const { data: vrow } = await supabase.from('vouchers')
      .select('id, resume_token_hash, used_by_mac, transaction_id').eq('code', code).maybeSingle();
    let resumeToken: string | null = null;
    if (vrow) {
      const patch: Record<string, unknown> = {};
      if (!vrow.used_by_mac && clientMac) patch.used_by_mac = clientMac;
      if (!vrow.transaction_id) patch.transaction_id = tx.id;
      if (!vrow.resume_token_hash) {
        const m = await mintResumeToken();
        patch.resume_token_hash = m.hash;
        resumeToken = m.token;
      }
      if (Object.keys(patch).length) await supabase.from('vouchers').update(patch).eq('id', vrow.id);
    }
    if (tx.voucher_code !== code) await supabase.from('transactions').update({ voucher_code: code }).eq('id', tx.id);

    return json({
      status: 'success', method: 'voucher', voucher: code, durationHours: pkg.hours,
      packageType: tx.package_type, packageLabel: pkg.label, speedMbps: pkg.mbps, paidAt: paidAtIso,
      revealAllowed: await revealAllowedFor(supabase, code!, paidAtIso), resumeToken,
    });
  } catch (e) {
    console.error('portal-mpesa-poll error', e);
    return json({ error: (e as Error).message }, 500);
  }
});
