// UDM (team hetoteam): Nudm_UECM + Nudm_SDM (TS 29.503) and a simulated MAP SRI-for-SM /
// ReportSM-DeliveryStatus / Alert-Service-Centre interface for the SMSC (TS 29.002, TS 29.338 S6c).
// Served at /t/hetoteam/. Contract: projects/hetoteam/CONTRACT.md

const fs = require('fs');
const path = require('path');

const TEAM = 'hetoteam';
// Peers publish public apiPrefix values, so we use the public origin too (override for local runs).
const HOST = (process.env.SMSF_BOARD_URL || 'https://smsf.torget.bjarby.com').replace(/\/$/, '');
// The NRF is the one well-known address; everything else is discovered through it.
const NRF_TEAM = process.env.NRF_TEAM || 'smsf-hao';
const NRF_NFM = `${HOST}/t/${NRF_TEAM}/nnrf-nfm/v1`;
const NRF_DISC = `${HOST}/t/${NRF_TEAM}/nnrf-disc/v1`;
const SELF_BASE = `${HOST}/t/${TEAM}`;
const NF_ID = 'a1b2c3d4-0000-4000-8000-000068657465'; // stable across restarts, so the NRF sees one UDM
const PLMN = { mcc: '001', mnc: '01' };
const LOG_MAX = 500;

// ---------- subscriber data (static, see CONTRACT.md "Test subscribers") ----------

function subscriber(n, profile, subs = {}, mng = {}) {
  return {
    supi: `imsi-00101000000000${n}`,
    gpsi: `msisdn-4670000000${n}`,
    profile,
    smsSubsData: { smsSubscribed: true, ...subs },
    smsMngData: {
      mtSmsSubscribed: true, mtSmsBarringAll: false, mtSmsBarringRoaming: false,
      moSmsSubscribed: true, moSmsBarringAll: false, moSmsBarringRoaming: false,
      ...mng,
    },
  };
}
const SUBSCRIBERS = [
  subscriber(1, 'SMS allowed'),
  subscriber(2, 'SMS allowed'),
  subscriber(3, 'SMS not allowed', { smsSubscribed: false }),
  subscriber(4, 'MT SMS barred', {}, { mtSmsBarringAll: true }),
  subscriber(5, 'MO SMS barred', {}, { moSmsBarringAll: true }),
];

const digits = s => String(s || '').replace(/^(msisdn-|imsi-|tel:)/, '').replace(/[^0-9]/g, '');

function findUe(ueId) {
  const id = String(ueId || '');
  if (id.startsWith('imsi-')) return SUBSCRIBERS.find(s => s.supi === id) || null;
  if (id.startsWith('msisdn-')) return SUBSCRIBERS.find(s => s.gpsi === id) || null;
  return null;
}
function findByMsisdn(m) {
  const d = digits(m);
  return d ? SUBSCRIBERS.find(s => digits(s.gpsi) === d) || null : null;
}

// ---------- state (persisted in ctx.dataDir) ----------

let registrations = {}; // supi -> SmsfRegistration
let mwd = {};           // supi -> { scAddresses: [..], mnrf, mcef }
let stateFile = null;
const log = [];
let logId = 0;
const nrf = { registered: false, lastHeartbeat: 0, heartBeatTimer: 60, lastError: null };
const disc = new Map(); // nfType -> { base, ts }

function loadState(dataDir) {
  if (!dataDir) return;
  stateFile = path.join(dataDir, 'state.json');
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    registrations = s.registrations || {};
    mwd = s.mwd || {};
  } catch { /* first start */ }
}
function saveState() {
  if (!stateFile) return;
  try { fs.writeFileSync(stateFile, JSON.stringify({ registrations, mwd }, null, 1)); }
  catch (e) { console.error(`[${TEAM}] save:`, e.message); }
}

function rec(entry) {
  log.push({ id: ++logId, ts: new Date().toISOString(), ...entry });
  if (log.length > LOG_MAX) log.shift();
}

// ---------- HTTP helpers ----------

function send(res, status, body, headers = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, h);
  res.end(body === undefined ? '' : JSON.stringify(body));
  return true;
}
// ProblemDetails, TS 29.571
const problem = (res, status, cause, detail, extra = {}) =>
  send(res, status, { title: cause, status, detail, cause, ...extra }, { 'content-type': 'application/problem+json' });
// Routing errors: MAP error name (TS 29.002) plus the S6c result code where one exists (TS 29.338).
const mapError = (res, status, result, detail, diameterResultCode, extra = {}) =>
  send(res, status, { status, result, ...(diameterResultCode ? { diameterResultCode } : {}), detail, ...extra });

class BadJson extends Error {}
const bodies = new WeakMap(); // req -> parsed body, for the message log

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  if (!t.trim()) { bodies.set(req, undefined); return {}; }
  let b;
  try { b = JSON.parse(t); } catch { bodies.set(req, t); throw new BadJson('body is not JSON'); }
  bodies.set(req, b);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadJson('body must be a JSON object');
  return b;
}

async function call(peer, method, url, body, contentType = 'application/json') {
  const entry = { dir: 'out', peer, method, path: url, request: body };
  try {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': contentType },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    rec({ ...entry, status: r.status, response: json });
    return { status: r.status, body: json };
  } catch (e) {
    rec({ ...entry, status: 0, response: e.message });
    return { status: 0, body: null, error: e.message };
  }
}

// ---------- NRF (TS 29.510) ----------

function nfProfile() {
  const svc = (id, name, v, full) => ({
    serviceInstanceId: id, serviceName: name, versions: [{ apiVersionInUri: v, apiFullVersion: full }],
    scheme: 'https', nfServiceStatus: 'REGISTERED', apiPrefix: SELF_BASE,
  });
  return {
    nfInstanceId: NF_ID,
    nfType: 'UDM',
    nfStatus: 'REGISTERED',
    plmnList: [PLMN],
    udmInfo: {
      supiRanges: [{ start: '001010000000000', end: '001019999999999' }],
      gpsiRanges: [{ start: '46700000000', end: '46799999999' }],
    },
    nfServices: [
      svc('nudm-uecm-1', 'nudm-uecm', 'v1', '1.0.0'),
      svc('nudm-sdm-1', 'nudm-sdm', 'v2', '2.0.0'),
      svc('sms-routing-1', 'sms-routing', 'v1', '1.0.0'),
    ],
  };
}

async function registerInNrf() {
  const r = await call('nrf', 'PUT', `${NRF_NFM}/nf-instances/${NF_ID}`, nfProfile());
  nrf.registered = r.status === 200 || r.status === 201;
  nrf.lastError = nrf.registered ? null : `register answered ${r.status || r.error}`;
  if (nrf.registered) {
    nrf.lastHeartbeat = Date.now();
    const hb = r.body && Number(r.body.heartBeatTimer);
    if (hb > 0) nrf.heartBeatTimer = hb;
  }
}

async function heartbeat() {
  const r = await call('nrf', 'PATCH', `${NRF_NFM}/nf-instances/${NF_ID}`,
    [{ op: 'replace', path: '/nfStatus', value: 'REGISTERED' }], 'application/json-patch+json');
  if (r.status === 404) { nrf.registered = false; return registerInNrf(); }
  if (r.status >= 200 && r.status < 300) { nrf.lastHeartbeat = Date.now(); nrf.lastError = null; }
  else nrf.lastError = `heartbeat answered ${r.status || r.error}`;
}

async function nrfTick() {
  if (!nrf.registered) return registerInNrf();
  // Heartbeat a bit before the NRF's timer runs out.
  if (Date.now() - nrf.lastHeartbeat >= nrf.heartBeatTimer * 800) return heartbeat();
}

// Base URL of an NF through NRF discovery (cached 60 s).
async function resolve(nfType) {
  const hit = disc.get(nfType);
  if (hit && Date.now() - hit.ts < 60000) return hit.base;
  const r = await call('nrf', 'GET', `${NRF_DISC}/nf-instances?target-nf-type=${nfType}&requester-nf-type=UDM`);
  const inst = r.body && Array.isArray(r.body.nfInstances) ? r.body.nfInstances[0] : null;
  if (!inst) return null;
  const svc = (inst.nfServices || [])[0] || {};
  const base = (svc.apiPrefix || inst.apiPrefix || '').replace(/\/$/, '') || null;
  if (base) disc.set(nfType, { base, ts: Date.now() });
  return base;
}

// ---------- Message Waiting Data and Alert-Service-Centre ----------

function mwdStatus(supi) {
  const m = mwd[supi];
  return { scAddressInMwd: !!(m && m.scAddresses.length), mnrf: !!(m && m.mnrf), mcef: !!(m && m.mcef) };
}
function addMwd(supi, scAddress, flag) {
  const m = mwd[supi] || (mwd[supi] = { scAddresses: [], mnrf: false, mcef: false });
  if (!m.scAddresses.includes(scAddress)) m.scAddresses.push(scAddress);
  m[flag] = true;
  saveState();
}
function removeMwd(supi, scAddress) {
  const m = mwd[supi];
  if (!m) return;
  m.scAddresses = m.scAddresses.filter(a => a !== scAddress);
  if (!m.scAddresses.length) delete mwd[supi];
  saveState();
}

// TS 23.040: the UE is reachable again, so alert every SMSC that has messages waiting for it.
async function alertServiceCentres(sub) {
  const m = mwd[sub.supi];
  if (!m || !m.scAddresses.length) return;
  const smsc = await resolve('CUSTOM_SMSC');
  if (!smsc) { rec({ dir: 'note', peer: 'smsc', path: 'alert-service-centre', response: 'no CUSTOM_SMSC in NRF, MWD kept' }); return; }
  for (const scAddress of [...m.scAddresses]) {
    const r = await call('smsc', 'POST', `${smsc}/smsc/alert-service-centre`,
      { msisdn: digits(sub.gpsi), scAddress, alertReason: 'UE_PRESENT' });
    if (r.status >= 200 && r.status < 300) removeMwd(sub.supi, scAddress);
  }
}

// ---------- Nudm_UECM: smsf-3gpp-access (TS 29.503 5.3) ----------

async function uecm(req, res, ueId) {
  const sub = findUe(ueId);
  if (req.method === 'PUT') {
    const b = await readJson(req);
    if (!sub) return problem(res, 404, 'USER_NOT_FOUND', `${ueId} is not provisioned`);
    const missing = ['smsfInstanceId', 'plmnId'].filter(k => !b[k]);
    if (missing.length) {
      return problem(res, 400, 'MANDATORY_IE_MISSING', `missing: ${missing.join(', ')}`,
        { invalidParams: missing.map(param => ({ param: `/${param}`, reason: 'mandatory' })) });
    }
    const existed = !!registrations[sub.supi];
    const reg = { ...b, registrationTime: new Date().toISOString() };
    registrations[sub.supi] = reg;
    saveState();
    if (mwd[sub.supi]) alertServiceCentres(sub).catch(e => console.error(`[${TEAM}] alert:`, e.message));
    if (existed) return send(res, 200, reg);
    return send(res, 201, reg, { location: `${SELF_BASE}/nudm-uecm/v1/${ueId}/registrations/smsf-3gpp-access` });
  }
  if (req.method === 'GET' || req.method === 'DELETE') {
    if (!sub) return problem(res, 404, 'USER_NOT_FOUND', `${ueId} is not provisioned`);
    const reg = registrations[sub.supi];
    if (!reg) return problem(res, 404, 'CONTEXT_NOT_FOUND', `no SMSF registered for ${ueId}`);
    if (req.method === 'GET') return send(res, 200, reg);
    delete registrations[sub.supi];
    saveState();
    return send(res, 204);
  }
  return problem(res, 405, 'METHOD_NOT_ALLOWED', 'PUT, GET or DELETE');
}

// ---------- Nudm_SDM (TS 29.503 6.1) ----------

const DATASETS = { SMS_SUB: 'smsSubsData', SMS_MNG: 'smsMngData' };

function sdm(req, res, supi, dataset, url) {
  if (req.method !== 'GET') return problem(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
  const sub = findUe(supi);
  if (!sub) return problem(res, 404, 'USER_NOT_FOUND', `${supi} is not provisioned`);
  if (dataset === 'sms-data') return send(res, 200, sub.smsSubsData);
  if (dataset === 'sms-mng-data') return send(res, 200, sub.smsMngData);
  if (dataset) return problem(res, 404, 'DATA_NOT_FOUND', `${dataset} is not served by this UDM; use sms-data or sms-mng-data`);
  const names = (url.searchParams.get('dataset-names') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) return problem(res, 400, 'MANDATORY_IE_MISSING', 'dataset-names is required');
  const unknown = names.filter(n => !DATASETS[n]);
  if (unknown.length) return problem(res, 404, 'DATA_NOT_FOUND', `data sets not served: ${unknown.join(', ')}`);
  const out = {};
  for (const n of names) out[DATASETS[n]] = sub[DATASETS[n]];
  return send(res, 200, out);
}

// ---------- simulated SRI-for-SM / ReportSM-DeliveryStatus ----------

async function sriForSm(req, res) {
  const b = await readJson(req);
  if (!b.msisdn || !b.scAddress) return mapError(res, 400, 'UNEXPECTED_DATA_VALUE', 'msisdn and scAddress are mandatory');
  const sub = findByMsisdn(b.msisdn);
  if (!sub) return mapError(res, 404, 'UNKNOWN_SUBSCRIBER', 'MSISDN not provisioned', 5001);
  if (!sub.smsSubsData.smsSubscribed || !sub.smsMngData.mtSmsSubscribed) {
    return mapError(res, 403, 'TELESERVICE_NOT_PROVISIONED', 'MT SMS is not part of the subscription');
  }
  if (sub.smsMngData.mtSmsBarringAll) return mapError(res, 403, 'CALL_BARRED', 'MT SMS barred for this subscriber');
  const reg = registrations[sub.supi];
  if (!reg) {
    addMwd(sub.supi, String(b.scAddress), 'mnrf');
    return mapError(res, 404, 'ABSENT_SUBSCRIBER_SM', 'no SMSF registered, UE not reachable; SC address stored in MWD',
      5550, { mwdStatus: mwdStatus(sub.supi) });
  }
  return send(res, 200, {
    imsi: digits(sub.supi),
    supi: sub.supi,
    servingNode: {
      nodeType: 'SMSF',
      smsfInstanceId: reg.smsfInstanceId,
      ...(reg.smsfMAPAddress ? { smsfMAPAddress: reg.smsfMAPAddress } : {}),
      ...(reg.smsfDiameterAddress ? { smsfDiameterAddress: reg.smsfDiameterAddress } : {}),
    },
    mwdStatus: mwdStatus(sub.supi),
  });
}

const OUTCOMES = ['ABSENT_SUBSCRIBER', 'SUCCESSFUL_TRANSFER', 'MEMORY_CAPACITY_EXCEEDED'];

async function reportSmDeliveryStatus(req, res) {
  const b = await readJson(req);
  if (!b.msisdn || !b.scAddress || !OUTCOMES.includes(b.deliveryOutcome)) {
    return mapError(res, 400, 'UNEXPECTED_DATA_VALUE', `msisdn, scAddress and deliveryOutcome (${OUTCOMES.join(' | ')}) are mandatory`);
  }
  const sub = findByMsisdn(b.msisdn);
  if (!sub) return mapError(res, 404, 'UNKNOWN_SUBSCRIBER', 'MSISDN not provisioned', 5001);
  const sc = String(b.scAddress);
  if (b.deliveryOutcome === 'ABSENT_SUBSCRIBER') addMwd(sub.supi, sc, 'mnrf');
  else if (b.deliveryOutcome === 'MEMORY_CAPACITY_EXCEEDED') addMwd(sub.supi, sc, 'mcef');
  else removeMwd(sub.supi, sc);
  return send(res, 200, { storedMsisdn: digits(sub.gpsi), mwdStatus: mwdStatus(sub.supi) });
}

// ---------- routing ----------

function route(req, res, p, url) {
  let m;
  if ((m = p.match(/^\/nudm-uecm\/v1\/([^/]+)\/registrations\/smsf-3gpp-access$/))) return uecm(req, res, m[1]);
  if ((m = p.match(/^\/nudm-sdm\/v2\/([^/]+)(?:\/([^/]+))?$/))) return sdm(req, res, m[1], m[2], url);
  if (p === '/sms-routing/v1/send-routing-info-for-sm' && req.method === 'POST') return sriForSm(req, res);
  if (p === '/sms-routing/v1/report-sm-delivery-status' && req.method === 'POST') return reportSmDeliveryStatus(req, res);
  return null;
}

const peerOf = p => (p.startsWith('/nudm-') ? 'smsf' : p.startsWith('/sms-routing') ? 'smsc' : '?');

module.exports = {
  init(ctx) {
    loadState(ctx && ctx.dataDir);
    const tick = () => { nrfTick().catch(e => { nrf.lastError = e.message; console.error(`[${TEAM}] nrf:`, e.message); }); };
    // The NRF may load after us: retry registration every 10 s, then heartbeat as the NRF asks.
    const t = setInterval(() => { try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); } }, 10000);
    if (t.unref) t.unref();
    const first = setTimeout(() => { try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); } }, 3000);
    if (first.unref) first.unref();
  },

  async handle(req, res, { path: p, url }) {
    if (req.method === 'GET' && (p === '/' || p === '/status')) {
      return send(res, 200, {
        nf: 'UDM', team: TEAM, nfInstanceId: NF_ID, apiPrefix: SELF_BASE, nrf: { ...nrf, base: NRF_NFM },
        registrations: Object.keys(registrations).length, mwd: Object.keys(mwd).length,
        contract: 'projects/hetoteam/CONTRACT.md',
      });
    }
    if (req.method === 'GET' && p === '/subscribers') return send(res, 200, SUBSCRIBERS);
    if (req.method === 'GET' && p === '/registrations') return send(res, 200, { registrations, mwd });
    if (req.method === 'GET' && p === '/log') {
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, log.filter(e => e.id > since).slice(-200));
    }
    if (req.method === 'POST' && p === '/admin/reset') {
      registrations = {}; mwd = {}; saveState();
      return send(res, 200, { reset: true });
    }

    // Protocol messages: log each one with its answer.
    const origEnd = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      let response = null;
      try { response = chunk && chunk.length ? JSON.parse(chunk.toString()) : null; } catch { response = String(chunk); }
      rec({ dir: 'in', peer: peerOf(p), method: req.method, path: p + (url.search || ''), status: res.statusCode, request: bodies.get(req), response });
      return origEnd(chunk, ...rest);
    };
    try {
      const r = route(req, res, p, url);
      if (r === null) { res.end = origEnd; return false; }
      await r;
      return true;
    } catch (e) {
      if (e instanceof BadJson) return problem(res, 400, 'INVALID_MSG_FORMAT', e.message);
      throw e;
    }
  },
};
