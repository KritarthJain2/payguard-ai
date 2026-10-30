'use strict';
/**
 * Shared server logic for PayGuard AI (Vercel version).
 * Plain Node.js, no dependencies. All money is integer minor units (cents).
 * Never trust client-supplied risk score, verified flag, payable amount
 * or approval status. The server recalculates everything on every call.
 */

const SUPPORTED_CURRENCIES = ['USD', 'INR', 'EUR', 'GBP'];
const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

function isSupportedCurrency(c) {
  return typeof c === 'string' && SUPPORTED_CURRENCIES.includes(c.toUpperCase());
}

function parseMoneyToCents(value) {
  // Returns { ok: true, cents } or { ok: false, error }
  if (value === undefined || value === null || value === '') {
    return { ok: false, error: 'empty' };
  }
  let s = String(value).trim().replace(/,/g, '');
  // Allow an optional leading currency symbol/code, then a plain number.
  s = s.replace(/^(USD|EUR|GBP|INR|Rs\.?|₹|\$|€|£)\s*/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    if (/^-/.test(s)) return { ok: false, error: 'negative' };
    if (/^\d+\.\d{3,}$/.test(s)) return { ok: false, error: 'too_many_decimals' };
    return { ok: false, error: 'invalid' };
  }
  const parts = s.split('.');
  const whole = parseInt(parts[0], 10);
  const frac = (parts[1] || '').padEnd(2, '0');
  const cents = whole * 100 + parseInt(frac, 10);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { ok: false, error: 'not_positive' };
  }
  return { ok: true, cents };
}

function formatCents(cents, currency) {
  const cur = (currency || 'USD').toUpperCase();
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return sign + cur + ' ' + whole + '.' + frac;
}

function centsToPayPalValue(cents) {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return whole + '.' + frac;
}

function getConfigStatus() {
  const aiConfigured = Boolean(process.env.PAYGUARD_AI_API_KEY);
  const paypalConfigured = Boolean(
    process.env.PAYPAL_SANDBOX_CLIENT_ID && process.env.PAYPAL_SANDBOX_CLIENT_SECRET
  );
  return {
    ok: true,
    aiConfigured,
    paypalConfigured,
    sandbox: true,
    paypalBaseUrl: process.env.PAYPAL_SANDBOX_BASE_URL || PAYPAL_SANDBOX_BASE_URL,
    aiModel: process.env.PAYGUARD_AI_MODEL || 'openai/gpt-oss-120b',
    // Never expose any secret value, only booleans and names.
    setupInstructions: [
      'Set PAYGUARD_AI_API_KEY in Vercel Environment Variables (Production) for live AI analysis, then redeploy.',
      'Set PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET in Vercel Environment Variables (Production) for live Sandbox checkout, then redeploy.',
      'Optional: PAYGUARD_AI_BASE_URL (default Groq), PAYGUARD_AI_MODEL (default openai/gpt-oss-120b), PAYPAL_SANDBOX_BASE_URL (default https://api-m.sandbox.paypal.com).',
      'Never paste keys in chat, in frontend code, or in the repo. Never use production PayPal credentials or real money.',
    ],
  };
}

function validatePayPalBaseUrl(url) {
  const u = url || PAYPAL_SANDBOX_BASE_URL;
  let parsed;
  try { parsed = new URL(u); } catch { return { ok: false, error: 'invalid_base_url' }; }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'base_url_must_be_https' };
  const host = parsed.hostname.toLowerCase();
  // Refuse production and any non-Sandbox host.
  if (host === 'api.paypal.com' || host === 'api-m.paypal.com') {
    return { ok: false, error: 'production_host_refused' };
  }
  if (host !== 'api-m.sandbox.paypal.com' && host !== 'api.sandbox.paypal.com') {
    return { ok: false, error: 'non_sandbox_host_refused' };
  }
  return { ok: true, baseUrl: parsed.origin };
}

// ---- Text-only URL inspection: never fetch or open a URL ----
function inspectUrl(rawUrl) {
  const findings = [];
  if (!rawUrl) return findings;
  const url = String(rawUrl).trim();
  if (/bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|shorturl|rb\.gy/i.test(url)) {
    findings.push({ id: 'shortened_url', severity: 'high', points: 20,
      explanation: 'The payment link is shortened, so its real destination is hidden.',
      evidence: url.slice(0, 120) });
  }
  if (/^\s*https?:\/\/\d+\.\d+\.\d+\.\d+/i.test(url)) {
    findings.push({ id: 'ip_host_url', severity: 'critical', points: 25,
      explanation: 'The link points directly to an IP address instead of a named merchant domain.',
      evidence: url.slice(0, 120) });
  }
  if (/xn--/i.test(url)) {
    findings.push({ id: 'punycode_url', severity: 'high', points: 20,
      explanation: 'The link uses punycode, which can hide a look-alike domain.',
      evidence: url.slice(0, 120) });
  }
  if (/paypa1|paypaI|pay-pal|paypal-secure|paypal\.com\.[a-z]+/i.test(url) && !/^https?:\/\/(www\.)?paypal\.com\//i.test(url)) {
    findings.push({ id: 'brand_lookalike_url', severity: 'high', points: 20,
      explanation: 'The link looks like PayPal but does not point to the real paypal.com domain.',
      evidence: url.slice(0, 120) });
  }
  return findings;
}

function extractFromText(text) {
  const t = String(text || '');
  const out = { sender: null, merchant: null, amount: null, currency: null, dueDate: null, paymentUrl: null, amounts: [] };
  const urlMatch = t.match(/https?:\/\/[^\s)>\]]+/i);
  if (urlMatch) out.paymentUrl = urlMatch[0].replace(/[.,;]+$/, '');
  // Due date first, so its day number is not mistaken for an amount.
  const dueMatch = t.match(/\b(?:due|by)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:,?\s*\d{4})?|\d{1,2}\s+[A-Za-z]+(?:\s+\d{4})?|\d{4}-\d{2}-\d{2})/i);
  let textWithoutDue = t;
  if (dueMatch) { out.dueDate = dueMatch[1]; textWithoutDue = t.replace(dueMatch[0], ' '); }
  const moneyRe = /(?:USD|EUR|GBP|INR|Rs\.?|₹|\$|€|£)\s*(\d[\d,]*(\.\d{1,2})?)/gi;
  let m;
  while ((m = moneyRe.exec(textWithoutDue)) !== null) {
    const parsed = parseMoneyToCents(m[1]);
    if (parsed.ok) out.amounts.push(parsed.cents);
  }
  // Plain numbers preceded by total/amount/pay/invoice are also amounts.
  if (out.amounts.length === 0) {
    const plain = textWithoutDue.match(/(?:total|amount|pay|invoice|price)\D{0,12}(\d[\d,]*(\.\d{1,2})?)/i);
    if (plain) { const p = parseMoneyToCents(plain[1]); if (p.ok) out.amounts.push(p.cents); }
  }
  if (out.amounts.length > 0) out.amount = out.amounts[0];
  const curMatch = t.match(/\b(USD|EUR|GBP|INR)\b/i) || t.match(/(₹|Rs\.?)/);
  if (curMatch) {
    const v = curMatch[1].toUpperCase();
    out.currency = (v === '₹' || v.startsWith('RS')) ? 'INR' : v;
  }
  const fromMatch = t.match(/(?:from|by|sender)\s*:\s*([A-Za-z][A-Za-z .'-]{1,60})/i) ||
    t.match(/invoice from ([A-Za-z][A-Za-z .'-]{1,60})/i);
  if (fromMatch) out.sender = fromMatch[1].trim().replace(/[.,;]+$/, '');
  const merchMatch = t.match(/(?:merchant|company|seller)\s*:\s*([A-Za-z][A-Za-z .'-]{1,60})/i);
  if (merchMatch) out.merchant = merchMatch[1].trim().replace(/[.,;]+$/, '');
  return out;
}

function runRuleLayer(input) {
  // input: { invoiceText, agreedCents, agreedCurrency, invoiceCents, invoiceCurrency,
  //          senderName, expectedMerchant, paymentLink, extracted }
  const flags = [];
  const push = (flag) => { if (!flags.some((f) => f.id === flag.id)) flags.push(flag); };
  const text = String(input.invoiceText || '');
  const lower = text.toLowerCase();
  const ext = input.extracted || extractFromText(text);
  const link = input.paymentLink || ext.paymentUrl || null;
  const invoiceCents = (typeof input.invoiceCents === 'number') ? input.invoiceCents : ext.amount;
  const invoiceCurrency = (input.invoiceCurrency || ext.currency || input.agreedCurrency || null);
  const agreedCents = input.agreedCents;
  const agreedCurrency = input.agreedCurrency;

  if (typeof agreedCents === 'number' && typeof invoiceCents === 'number' && agreedCents !== invoiceCents) {
    push({ id: 'amount_mismatch', severity: 'critical', points: 50,
      explanation: 'The invoice amount does not match the original agreed amount.',
      evidence: 'Agreed ' + formatCents(agreedCents, agreedCurrency) + ' vs invoice ' + formatCents(invoiceCents, invoiceCurrency || agreedCurrency) });
  }
  if (agreedCurrency && invoiceCurrency && String(agreedCurrency).toUpperCase() !== String(invoiceCurrency).toUpperCase()) {
    push({ id: 'currency_mismatch', severity: 'critical', points: 50,
      explanation: 'The invoice currency does not match the agreed currency. Equal numbers in different currencies must not pass.',
      evidence: 'Agreed ' + agreedCurrency + ' vs invoice ' + invoiceCurrency });
  }
  const sender = (input.senderName || ext.sender || '').trim();
  const merchant = (input.expectedMerchant || ext.merchant || '').trim();
  if (sender && merchant && sender.toLowerCase() !== merchant.toLowerCase()) {
    push({ id: 'merchant_mismatch', severity: 'high', points: 25,
      explanation: 'The sender name does not match the expected merchant name.',
      evidence: 'Sender "' + sender + '" vs expected merchant "' + merchant + '"' });
  }
  if (/\b(urgent|immediately|right now|within (an? )?hour|act now|last chance)\b/i.test(text)) {
    const ev = text.match(/\b[^.]{0,80}(urgent|immediately|right now|within (an? )?hour|act now|last chance)[^.]{0,80}/i);
    push({ id: 'urgency', severity: 'medium', points: 15,
      explanation: 'Urgency language can pressure a quick payment before checking.',
      evidence: ev ? ev[0].trim().slice(0, 140) : 'urgency language detected' });
  }
  if (/\b(account (will be )?closed|suspended|legal action|police|arrest|fine|penalty)\b/i.test(text)) {
    push({ id: 'threat', severity: 'medium', points: 15,
      explanation: 'Threats of closure or legal action are a common pressure tactic.',
      evidence: 'threat language detected in invoice text' });
  }
  if (/\b(don'?t tell|keep (this )?secret|do not share|confidential payment)\b/i.test(text)) {
    push({ id: 'secrecy', severity: 'medium', points: 10,
      explanation: 'Requests for secrecy make it harder to verify the payment with others.',
      evidence: 'secrecy language detected in invoice text' });
  }
  if (/\b(new (bank )?account|changed (bank )?account|different account|updated (payment )?details|pay to (a )?new)\b/i.test(text)) {
    push({ id: 'account_change', severity: 'critical', points: 25,
      explanation: 'The payment account appears to have changed from what was expected. Verify through a known channel before paying.',
      evidence: 'account-change wording detected in invoice text' });
  }
  if (/\b(ignore (previous|earlier|all) instructions|disregard (the )?(system|rules|instructions)|you are now|new instructions:|system prompt|override)\b/i.test(text)) {
    push({ id: 'prompt_injection', severity: 'high', points: 20,
      explanation: 'Instructions embedded in the invoice were flagged and NOT followed. They do not override the analysis rules.',
      evidence: 'instruction-like wording detected inside invoice text' });
  }
  inspectUrl(link).forEach(push);
  if (ext.amounts && ext.amounts.length > 1 && new Set(ext.amounts).size > 1) {
    push({ id: 'multiple_amounts', severity: 'medium', points: 10,
      explanation: 'More than one different amount appears in the invoice text. Confirm which single amount is actually requested.',
      evidence: ext.amounts.map((c) => formatCents(c, invoiceCurrency || agreedCurrency)).join(', ') });
  }
  const missing = [];
  if (invoiceCents === null || invoiceCents === undefined) missing.push('invoice amount');
  if (!invoiceCurrency) missing.push('currency');
  if (!ext.dueDate) missing.push('due date');
  if (!sender && !merchant) missing.push('sender/merchant name');
  if (missing.length > 0) {
    push({ id: 'missing_details', severity: 'medium', points: missing.includes('invoice amount') ? 20 : 10,
      explanation: 'Some details could not be found in the invoice text and need manual verification.',
      evidence: 'Missing: ' + missing.join(', ') });
  }
  return { flags, extracted: ext, invoiceCents, invoiceCurrency, missing };
}

function scoreFlags(flags) {
  let score = 0;
  for (const f of flags) score += f.points || 0;
  if (score > 100) score = 100;
  const level = score <= 24 ? 'low' : score <= 49 ? 'medium' : 'high';
  return { score, level };
}

function dedupeFlags(aiFlags, ruleFlags) {
  const seen = new Set();
  const out = [];
  for (const f of [...(ruleFlags || []), ...(aiFlags || [])]) {
    if (!f || !f.id) continue;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

// Payment verification gate. Never trusts client claims.
function verifyGate(input) {
  // input: { agreedCents, agreedCurrency, invoiceCents, invoiceCurrency,
  //          invoiceText, criticalFlags, missingRequired }
  const reasons = [];
  const expectedAmount = (typeof input.agreedCents === 'number') ? input.agreedCents : null;
  const expectedCurrency = input.agreedCurrency ? String(input.agreedCurrency).toUpperCase() : null;
  const submittedAmount = (typeof input.invoiceCents === 'number') ? input.invoiceCents : null;
  const submittedCurrency = input.invoiceCurrency ? String(input.invoiceCurrency).toUpperCase() : null;

  if (expectedAmount === null || !expectedCurrency) {
    reasons.push({ code: 'missing_quote', message: 'Original agreed amount and currency are required.' });
  }
  if (submittedAmount === null) {
    reasons.push({ code: 'missing_invoice_amount', message: 'Invoice amount is missing.' });
  }
  if (expectedAmount !== null && submittedAmount !== null && expectedAmount !== submittedAmount) {
    reasons.push({ code: 'amount_mismatch', message: 'Invoice amount differs from the original agreed amount.',
      expectedAmount, submittedAmount, expectedCurrency, submittedCurrency,
      differenceCents: submittedAmount - expectedAmount });
  }
  if (expectedCurrency && submittedCurrency && expectedCurrency !== submittedCurrency) {
    reasons.push({ code: 'currency_mismatch', message: 'Invoice currency differs from the agreed currency.',
      expectedAmount, submittedAmount, expectedCurrency, submittedCurrency,
      differenceCents: (submittedAmount !== null && expectedAmount !== null) ? submittedAmount - expectedAmount : null });
  }
  const critical = (input.criticalFlags || []).filter((f) => f && f.severity === 'critical');
  for (const f of critical) {
    reasons.push({ code: 'critical_finding', message: 'Critical finding remains unresolved: ' + (f.id || 'unknown'), flagId: f.id });
  }
  if (input.missingRequired && input.missingRequired.length > 0) {
    reasons.push({ code: 'missing_data', message: 'Required data is missing: ' + input.missingRequired.join(', ') });
  }
  const blocked = reasons.length > 0;
  return {
    verified: !blocked,
    blocked,
    reasons,
    expectedAmount, expectedCurrency, submittedAmount, submittedCurrency,
    differenceCents: (expectedAmount !== null && submittedAmount !== null) ? submittedAmount - expectedAmount : null,
    payableAmount: !blocked ? expectedAmount : null,
    payableCurrency: !blocked ? expectedCurrency : null,
    disclaimer: 'A successful verification means only that the required checks passed. It does not prove the seller is legitimate.',
  };
}

// In-memory order store for this Vercel version. Documented as non-durable:
// Vercel serverless instances may be recycled, so a stored order may not be
// available to a later capture call. Capture also verifies the PayPal order's
// custom_id (PAYGUARD:<CURRENCY>:<CENTS>) so association can be re-checked
// from PayPal itself when the in-memory record is gone.
const orderStore = new Map();
function storeOrder(orderId, record) { orderStore.set(orderId, record); }
function getStoredOrder(orderId) { return orderStore.get(orderId) || null; }
function markCaptured(orderId, captureId) {
  const r = orderStore.get(orderId);
  if (r) { r.status = 'COMPLETED'; r.captureId = captureId; orderStore.set(orderId, r); }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); }
    }
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = {
  SUPPORTED_CURRENCIES, PAYPAL_SANDBOX_BASE_URL,
  isSupportedCurrency, parseMoneyToCents, formatCents, centsToPayPalValue,
  getConfigStatus, validatePayPalBaseUrl, inspectUrl, extractFromText,
  runRuleLayer, scoreFlags, dedupeFlags, verifyGate,
  storeOrder, getStoredOrder, markCaptured, readJsonBody, sendJson,
};
