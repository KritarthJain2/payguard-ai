'use strict';
const lib = require('../_lib');
const { parseMoneyToCents, isSupportedCurrency, validatePayPalBaseUrl,
  getStoredOrder, markCaptured, readJsonBody, sendJson, getConfigStatus, formatCents } = lib;

async function paypalFetch(baseUrl, token, path, method, body, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(extraHeaders || {}) };
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(baseUrl + path, opts);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  const body = await readJsonBody(req);
  // Never trust a frontend redirect or query parameter as proof of payment.
  // Only the expected order ID is accepted, and everything is re-verified with PayPal.
  const orderId = String(body.orderId || '').trim();
  if (!orderId) return sendJson(res, 400, { ok: false, error: 'validation_error', errors: { orderId: 'Expected PayPal order ID is required.' } });
  const stored = getStoredOrder(orderId);
  if (stored && stored.status === 'COMPLETED') {
    return sendJson(res, 200, { ok: true, alreadyCaptured: true, orderId, captureId: stored.captureId || null,
      message: 'This order was already captured. No duplicate capture was made.' });
  }
  const expected = body.expectedQuote || null;
  let expectedCents = null;
  let expectedCurrency = null;
  if (expected) {
    const p = parseMoneyToCents(expected.amount);
    if (p.ok) expectedCents = p.cents;
    if (expected.currency && isSupportedCurrency(expected.currency)) expectedCurrency = String(expected.currency).toUpperCase();
  }
  if (stored) {
    expectedCents = stored.agreedCents;
    expectedCurrency = stored.agreedCurrency;
  }
  const cfg = getConfigStatus();
  if (!cfg.paypalConfigured) {
    return sendJson(res, 503, { ok: false, error: 'configuration_error',
      message: 'PayPal Sandbox is not configured. Set PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET in Vercel Environment Variables (Production) and redeploy.',
      setupInstructions: cfg.setupInstructions });
  }
  const baseCheck = validatePayPalBaseUrl(process.env.PAYPAL_SANDBOX_BASE_URL);
  if (!baseCheck.ok) return sendJson(res, 500, { ok: false, error: baseCheck.error });
  const baseUrl = baseCheck.baseUrl;
  try {
    const tokenResp = await fetch(baseUrl + '/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(process.env.PAYPAL_SANDBOX_CLIENT_ID + ':' + process.env.PAYPAL_SANDBOX_CLIENT_SECRET).toString('base64') },
      body: 'grant_type=client_credentials',
    });
    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenData.access_token) return sendJson(res, 502, { ok: false, error: 'paypal_token_failed' });
    const token = tokenData.access_token;
    const orderRes = await paypalFetch(baseUrl, token, '/v2/checkout/orders/' + encodeURIComponent(orderId), 'GET');
    if (!orderRes.ok || !orderRes.data || orderRes.data.id !== orderId) {
      return sendJson(res, 403, { ok: false, error: 'order_not_found_or_not_created_by_this_server',
        message: 'Order could not be verified with PayPal, or was not created by this server. No capture was made.' });
    }
    const order = orderRes.data;
    const unit = Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
    const amt = unit && unit.amount ? unit.amount : null;
    if (!amt || !amt.value || !amt.currency_code) {
      return sendJson(res, 502, { ok: false, error: 'paypal_order_invalid', message: 'PayPal order has no verifiable amount. No capture was made.' });
    }
    const paypalCents = parseMoneyToCents(amt.value);
    const paypalCurrency = String(amt.currency_code).toUpperCase();
    if (!paypalCents.ok) return sendJson(res, 502, { ok: false, error: 'paypal_order_invalid' });
    // Quote association: stored record wins; otherwise the order custom_id must match the expected quote.
    if (stored) {
      if (stored.agreedCents !== paypalCents.cents || stored.agreedCurrency !== paypalCurrency) {
        return sendJson(res, 403, { ok: false, error: 'quote_association_mismatch', message: 'PayPal order amount/currency does not match the stored verified quote. No capture was made.' });
      }
    } else if (unit.custom_id) {
      const expectedCustom = 'PAYGUARD:' + expectedCurrency + ':' + expectedCents;
      if (expectedCents === null || unit.custom_id !== expectedCustom) {
        return sendJson(res, 403, { ok: false, error: 'quote_association_mismatch', message: 'PayPal order could not be associated with the expected quote. No capture was made.' });
      }
    } else if (expectedCents !== null && (paypalCents.cents !== expectedCents || paypalCurrency !== expectedCurrency)) {
      return sendJson(res, 403, { ok: false, error: 'amount_mismatch', message: 'PayPal order amount/currency does not match the expected quote.' });
    }
    if (expectedCents !== null && (paypalCents.cents !== expectedCents || paypalCurrency !== expectedCurrency)) {
      return sendJson(res, 403, { ok: false, error: 'amount_mismatch',
        expectedAmount: expectedCents, submittedAmount: paypalCents.cents,
        expectedCurrency, submittedCurrency: paypalCurrency,
        differenceCents: paypalCents.cents - expectedCents });
    }
    if (order.status === 'VOIDED') {
      return sendJson(res, 200, { ok: false, error: 'cancelled', message: 'Order was cancelled/voided. No payment was made.' });
    }
    if (order.status === 'COMPLETED') {
      markCaptured(orderId, null);
      return sendJson(res, 200, { ok: true, alreadyCaptured: true, orderId, message: 'Order was already completed. No duplicate capture was made.' });
    }
    if (order.status !== 'APPROVED') {
      return sendJson(res, 200, { ok: false, error: 'not_approved',
        message: 'Order is not approved yet (status: ' + order.status + '). No capture was made.' });
    }
    // Deterministic idempotency: PayPal deduplicates by this header value.
    const captureRes = await paypalFetch(baseUrl, token, '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', 'POST', {},
      { 'PayPal-Request-Id': 'capture-' + orderId });
    const capData = captureRes.data || {};
    let capture = null;
    if (Array.isArray(capData.purchase_units)) {
      const payments = capData.purchase_units[0] && capData.purchase_units[0].payments;
      if (payments && Array.isArray(payments.captures) && payments.captures[0]) capture = payments.captures[0];
    }
    if (!captureRes.ok) {
      return sendJson(res, 502, { ok: false, error: 'capture_failed', message: 'PayPal capture failed. No success is shown.' });
    }
    if (capture && capture.status === 'DECLINED') {
      return sendJson(res, 200, { ok: false, error: 'declined', message: 'PayPal declined the capture. No payment was made.' });
    }
    if (capData.status === 'COMPLETED' || (capture && capture.status === 'COMPLETED')) {
      markCaptured(orderId, capture ? capture.id : null);
      return sendJson(res, 200, { ok: true, captured: true, orderId,
        captureId: capture ? capture.id : null,
        amount: formatCents(paypalCents.cents, paypalCurrency), amountCents: paypalCents.cents, currency: paypalCurrency,
        sandbox: true, testOnly: true,
        message: 'Sandbox capture confirmed by PayPal. This is a test only; no real money was processed.' });
    }
    return sendJson(res, 200, { ok: false, error: 'capture_not_completed',
      message: 'PayPal did not confirm a completed capture. No success is shown.' });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: 'paypal_error', message: 'PayPal Sandbox request failed. No payment was made.' });
  }
};
