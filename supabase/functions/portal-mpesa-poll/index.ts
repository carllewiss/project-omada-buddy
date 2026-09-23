// Portal: Poll payment status; on confirmed payment, issue a voucher whose
// online time matches the package purchased, and return it.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Layer 2 helper — generate a random URL-safe token and its sha-256 hash.
async function mintResumeToken(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return { token, hash };
}

// ---- Omada Open API: mint a voucher whose online time == the package paid for ----
const OMADA_URL = (Deno.env.get('OMADA_URL') ?? '').replace(/\/+$/, '');
const OMADAC_ID = Deno.env.get('OMADA_OMADAC_ID') ?? '';
const SITE_ID = Deno.env.get('OMADA_SITE_ID') ?? '';
const OMADA_CLIENT_ID = Deno.env.get('OMADA_CLIENT_ID') ?? '';
const OMADA_CLIENT_SECRET = Deno.env.get('OMADA_CLIENT_SECRET') ?? '';

async function mintOmadaVoucher(
  durationHours: number,
  label: string,
  priceKes: number,
): Promise<{ code: string; groupId: string } | null> {
  if (!OMADA_URL || !OMADAC_ID || !SITE_ID || !OMADA_CLIENT_ID || !OMADA_CLIENT_SECRET) return null;
  try {
    const tokRes = await fetch(`${OMADA_URL}/openapi/authorize/token?grant_type=client_credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        omadacId: OMADAC_ID,
        client_id: OMADA_CLIENT_ID,
        client_secret: OMADA_CLIENT_SECRET,
      }),
    });
    const tok = await tokRes.json();
    if (tok?.errorCode !== 0) throw new Error(tok?.msg || 'token failed');
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `AccessToken=${tok.result.accessToken}`,
    };
    const base = `${OMADA_URL}/openapi/v1/${OMADAC_ID}/sites/${SITE_ID}/hotspot/voucher-groups`;
    const cRes = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: label.slice(0, 60),
        amount: 1,
        codeLength: 8,
        codeForm: [0],
        limitType: 0,     // limited number of users
        limitNum: 1,      // one device
        durationType: 0,  // countdown of online time
        duration: Math.round(durationHours * 60), // minutes
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
    const created = await cRes.json();
    if (created?.errorCode !== 0) throw new Error(created?.msg || 'create failed');
    const groupId = created.result.id as string;
    const lRes = await fetch(`${base}/${groupId}?page=1&pageSize=1`, { headers });
    const list = await lRes.json();
    const code = list?.result?.data?.[0]?.code as string | undefined;
    if (!code) throw new Error('no code returned');
    return { code, groupId };
  } catch (e) {
    console.error('[omada] voucher mint failed', e);
    return null;
  }
}

// ---- PRIMARY auth: authorize the paying device's MAC directly on the controller ----
const OPERATOR_USER = Deno.env.get('OMADA_OPERATOR_USER') ?? '';
const OPERATOR_PASS = Deno.env.get('OMADA_OPERATOR_PASSWORD') ?? '';
const normMac = (m: string) => (m || '').trim().toUpperCase().replace(/:/g, '-');

async function authorizeMacDirect(opts: {
  clientMac: string; apMac: string; ssidName: string; radioId: number; seconds: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!OMADA_URL || !OMADAC_ID || !SITE_ID || !OPERATOR_USER || !OPERATOR_PASS) {
    return { ok: false, error: 'operator_not_configured' };
  }
  try {
    const loginRes = await fetch(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: OPERATOR_USER, password: OPERATOR_PASS }),
    });
    const login = await loginRes.json().catch(() => ({}));
    if (login?.errorCode !== 0) return { ok: false, error: login?.msg || 'operator login failed' };
    const cookie = (loginRes.headers.get('set-cookie') || '')
      .split(/,(?=[^;]+?=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');

    const res = await fetch(`${OMADA_URL}/${OMADAC_ID}/api/v2/hotspot/extPortal/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Csrf-Token': login.result?.token, Cookie: cookie },
      body: JSON.stringify({
        clientMac: normMac(opts.clientMac),
        apMac: normMac(opts.apMac),
        ssidName: opts.ssidName,
        radioId: Number.isFinite(opts.radioId) ? opts.radioId : 0,
        site: SITE_ID,
        time: Math.round(opts.seconds * 1000),
        authType: 4,
      }),
      redirect: 'manual',
    });
    const data = await res.json().catch(() => ({}));
    if (data?.errorCode === 0) return { ok: true };
    return { ok: false, error: data?.msg || `controller responded ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- Anti-sharing gate (server-side) ----
const REVEAL_WINDOW_MS = 6 * 60 * 1000;
async function revealAllowedFor(supabase: any, code: string, paidAtIso: string | null): Promise<boolean> {
  if (!code || !paidAtIso) return false;
  const paidAt = new Date(paidAtIso).getTime();
  if (!paidAt || Number.isNaN(paidAt)) return false;
  if (Date.now() - paidAt >= REVEAL_WINDOW_MS) return false;
  try {
    const { data } = await supabase
      .from('session_events')
      .select('client_mac')
      .eq('voucher_code', code)
      .not('client_mac', 'is', null)
      .limit(200);
    const macs = new Set((data || []).map((r: any) => r.client_mac));
    if (macs.size >= 3) {
      supabase.from('session_events').insert({
        event_type: 'voucher_share_suspected',
        voucher_code: code,
        outcome: 'reveal_blocked',
        details: { distinct_macs: macs.size },
      }).then(() => {}, () => {});
      return false;
    }
  } catch (_) { /* fail open on logging errors only */ }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { checkoutRequestId, clientMac, apMac, ssidName, radioId } = await req.json();
    if (!checkoutRequestId) {
      return new Response(JSON.stringify({ error: 'checkoutRequestId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (!tx) {
      return new Response(JSON.stringify({ status: 'unknown' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (tx.status === 'pending') {
      return new Response(JSON.stringify({ status: 'pending' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (tx.status === 'failed' || tx.status === 'cancelled') {
      return new Response(JSON.stringify({ status: 'failed', error: tx.result_desc || 'Payment failed' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (tx.status === 'success' || tx.status === 'paid') {
      const paidAtIso = tx.updated_at || tx.created_at || new Date().toISOString();

      let code: string | null = tx.voucher_code || null;
      let durationHours: number | null = null;
      let packageType: string | null = tx.package_type || null;

      if (!code) {
        const { data: existingAuth } = await supabase
          .from('client_authorizations')
          .select('mpesa_receipt, package_type, duration_hours')
          .eq('checkout_request_id', checkoutRequestId)
          .maybeSingle();
        if (existingAuth?.mpesa_receipt?.startsWith('VC-')) {
          code = existingAuth.mpesa_receipt.substring(3);
          durationHours = existingAuth.duration_hours;
          packageType = existingAuth.package_type;
        }
      }

      // Preferred path: create the voucher on the Omada controller on demand,
      // limited to one device and to the online time of the package purchased.
      if (!code) {
        const { data: pkg } = await supabase
          .from('package_pricing')
          .select('duration_hours, price_kes')
          .eq('package_type', tx.package_type)
          .maybeSingle();
        const hours = Number(pkg?.duration_hours ?? (tx.package_type === '24hour' ? 24 : 2));
        const minted = await mintOmadaVoucher(
          hours,
          `MPESA ${tx.package_type} ${checkoutRequestId}`,
          Number(pkg?.price_kes ?? tx.amount ?? 10),
        );
        if (minted) {
          code = minted.code;
          durationHours = hours;
          packageType = tx.package_type;

          await supabase.from('vouchers').insert({
            code: minted.code,
            package_type: tx.package_type,
            duration_hours: hours,
            status: 'used',
            used_at: new Date().toISOString(),
            used_by_mac: clientMac || null,
            transaction_id: tx.id,
          });

          await supabase
            .from('client_authorizations')
            .update({
              payment_status: 'paid',
              mpesa_receipt: `VC-${minted.code}`,
              mac_address: clientMac || null,
              duration_hours: hours,
              updated_at: new Date().toISOString(),
            })
            .eq('checkout_request_id', checkoutRequestId);

          supabase.from('session_events').insert({
            event_type: 'voucher_issued',
            voucher_code: minted.code,
            package_type: tx.package_type,
            duration_hours: hours,
            transaction_id: tx.id,
            checkout_request_id: checkoutRequestId,
            client_mac: clientMac || null,
            outcome: 'issued',
            details: { source: 'omada_open_api', groupId: minted.groupId },
          }).then(() => {}, () => {});
        }
      }

      // Fallback: pre-stocked voucher pool in the database.
      if (!code) {
        const { data: claimed, error: claimErr } = await supabase
          .rpc('claim_voucher_for_transaction', {
            _transaction_id: tx.id,
            _package_type: tx.package_type,
            _client_mac: clientMac || null,
          });

        if (claimErr || !claimed || claimed.length === 0) {
          return new Response(JSON.stringify({
            status: 'no_voucher',
            error: 'Payment received but no vouchers available. Please contact support.',
          }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const v = claimed[0];
        code = v.code;
        durationHours = v.duration_hours;
        packageType = v.package_type;

        await supabase
          .from('client_authorizations')
          .update({
            payment_status: 'paid',
            mpesa_receipt: `VC-${v.code}`,
            mac_address: clientMac || null,
            updated_at: new Date().toISOString(),
          })
          .eq('checkout_request_id', checkoutRequestId);

        supabase.from('session_events').insert({
          event_type: 'voucher_issued',
          voucher_code: v.code,
          package_type: v.package_type,
          duration_hours: v.duration_hours,
          transaction_id: tx.id,
          checkout_request_id: checkoutRequestId,
          client_mac: clientMac || null,
          outcome: 'issued',
          details: { source: 'mpesa_poll' },
        }).then(() => {}, (e: unknown) => console.error('[session_events] insert failed', e));
      }

      // Fill in package details + bind the voucher to this device / transaction
      const { data: vrow } = await supabase
        .from('vouchers')
        .select('id, duration_hours, package_type, resume_token_hash, used_by_mac, transaction_id')
        .eq('code', code)
        .maybeSingle();

      if (vrow) {
        durationHours = durationHours ?? vrow.duration_hours;
        packageType = packageType ?? vrow.package_type;
        const patch: Record<string, unknown> = {};
        if (!vrow.used_by_mac && clientMac) patch.used_by_mac = clientMac;
        if (!vrow.transaction_id) patch.transaction_id = tx.id;
        if (Object.keys(patch).length) await supabase.from('vouchers').update(patch).eq('id', vrow.id);
      }

      // Layer 2 — silent resume token (mint once per voucher)
      let resumeToken: string | null = null;
      if (vrow && !vrow.resume_token_hash) {
        const minted = await mintResumeToken();
        await supabase.from('vouchers').update({ resume_token_hash: minted.hash }).eq('id', vrow.id);
        resumeToken = minted.token;
      }

      if (!tx.voucher_code) {
        await supabase.from('transactions').update({ voucher_code: code }).eq('id', tx.id);
      }

      return new Response(JSON.stringify({
        status: 'success',
        voucher: code,
        durationHours,
        packageType,
        paidAt: paidAtIso,
        revealAllowed: await revealAllowedFor(supabase, code!, paidAtIso),
        resumeToken,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ status: tx.status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('portal-mpesa-poll error', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
