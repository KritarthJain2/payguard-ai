'use strict';
const lib = require('../_lib');
const { parseMoneyToCents, isSupportedCurrency, extractFromText, runRuleLayer, verifyGate,
  formatCents, centsToPayPalValue, validatePayPalBaseUrl, storeOrder, readJsonBody, sendJson, getConfigStatus } = lib;

async function getAccessToken(baseUrl, clientId, secret) {
  const resp = await fetch(baseUrl + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error('paypal_token_failed');
  return data.access_token;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  const body = await readJsonBody(req);
  // Client claims are ignored for the decision; they are recorded only as ignored.
  const ignoredClientClaims = Boolean(body.verified || body.approved || body.clientRiskScore !== undefined || body.payableAmount !== undefined);
  const invoiceText = String(body.invoiceText || '');
  const agreed = parseMoneyToCents(body.agreedAmount);
  const agreedCurrency = body.agreedCurrency ? String(body.agreedCurrency).toUpperCase() : null;
  const errors = {};
  if (!agreed.ok) errors.agreedAmount = 'Original agreed amount is required and must be positive with at most 2 decimal places.';
  if (!agreedCurrency || !isSupportedCurrency(agreedCurrency)) errors.agreedCurrency = 'Currency must be one of USD, INR, EUR, GBP.';
  if (Object.keys(errors).length > 0) return sendJson(res, 400, { ok: false, error: 'validation_error', errors });
  const invoiceOverride = body.invoiceAmount !== undefined && body.invoiceAmount !== null && body.invoiceAmount !== ''
    ? parseMoneyToCents(body.invoiceAmount) : null;
  if (body.invoiceAmount !== undefined && body.invoiceAmount !== null && body.invoiceAmount !== '' && !invoiceOverride.ok) {
    return sendJson(res, 400, { ok: false, error: 'validation_error', errors: { invoiceAmount: 'Invalid invoice amount.' } });
  }
  const invoiceCurrencyRaw = body.invoiceCurrency ? String(body.invoiceCurrency).toUpperCase() : null;
  if (invoiceCurrencyRaw && !isSupportedCurrency(invoiceCurrencyRaw)) {
    return sendJson(res, 400, { ok: false, error: 'validation_error', errors: { invoiceCurrency: 'Unsupported currency.' } });
  }
  const extracted = extractFromText(invoiceText);
  const invoiceCents = invoiceOverride ? invoiceOverride.cents : extracted.amount;
  const invoiceCurrency = invoiceCurrencyRaw || extracted.currency || agreedCurrency;
  // Re-run the full rule layer on the server, never trusting client flags.
  const rule = runRuleLayer({
    invoiceText, agreedCents: agreed.cents, agreedCurrency, invoiceCents, invoiceCurrency,
    senderName: body.senderName || null, expectedMerchant: body.expectedMerchant || null,
    paymentLink: body.paymentLink || null, extracted,
  });
  const criticalFlags = rule.flags.filter((f) => f.severity === 'critical');
  const missingRequired = [];
  if (invoiceCents === null || invoiceCents === undefined) missingRequired.push('invoice amount');
  const gate = verifyGate({
    agreedCents: agreed.cents, agreedCurrency, invoiceCents, invoiceCurrency,
    invoiceText, criticalFlags, missingRequired,
  });
  if (gate.blocked) {
    return sendJson(res, 403, {
      ok: false, error: 'payment_blocked', blocked: true, gate, ignoredClientClaims,
      message: 'Checkout blocked by the server verification gate. No PayPal order was created.',
    });
  }
  // Gate passed. Now check PayPal configuration — never fabricate an order.
  const cfg = getConfigStatus();
  if (!cfg.paypalConfigured) {
    return sendJson(res, 503, {
      ok: false, error: 'configuration_error',
      message: 'PayPal Sandbox is not configured. Set PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET in Vercel Environment Variables (Production) and redeploy. No order was created.',
      setupInstructions: cfg.setupInstructions,
    });
  }
  const baseCheck = validatePayPalBaseUrl(process.env.PAYPAL_SANDBOX_BASE_URL);
  if (!baseCheck.ok) return sendJson(res, 500, { ok: false, error: baseCheck.error, message: 'PayPal Sandbox base URL is not allowed. Only Sandbox hosts are permitted.' });
  const baseUrl = baseCheck.baseUrl;
  try {
    const token = await getAccessToken(baseUrl, process.env.PAYPAL_SANDBOX_CLIENT_ID, process.env.PAYPAL_SANDBOX_CLIENT_SECRET);
    const origin = req.headers && req.headers.origin ? String(req.headers.origin) : '';
    const orderResp = await fetch(baseUrl + '/v2/checkout/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: 'payguard-' + Date.now(),
          custom_id: 'PAYGUARD:' + agreedCurrency + ':' + agreed.cents,
          description: 'PayGuard AI verified Sandbox payment — test only, not real money.',
          amount: { currency_code: agreedCurrency, value: centsToPayPalValue(agreed.cents) },
        }],
        application_context: {
          brand_name: 'PayGuard AI (Sandbox)',
          landing_page: 'LOGIN',
          user_action: 'PAY_NOW',
          return_url: origin ? origin + '/?paypal=return' : undefined,
          cancel_url: origin ? origin + '/?paypal=cancelled' : undefined,
        },
      }),
    });
    const order = await orderResp.json().catch(() => ({}));
    if (!orderResp.ok || !order.id) {
      return sendJson(res, 502, { ok: false, error: 'paypal_order_failed', message: 'PayPal Sandbox order creation failed. No payment was made.' });
    }
    const approval = Array.isArray(order.links) ? order.links.find((l) => l.rel === 'approve') : null;
    storeOrder(order.id, {
      status: order.status || 'CREATED',
      agreedCents: agreed.cents, agreedCurrency,
      customId: 'PAYGUARD:' + agreedCurrency + ':' + agreed.cents,
      createdAt: new Date().toISOString(),
    });
    return sendJson(res, 200, {
      ok: true, orderId: order.id,
      approvalUrl: approval ? approval.href : null,
      status: order.status || 'CREATED',
      payable: { amountCents: agreed.cents, currency: agreedCurrency, formatted: formatCents(agreed.cents, agreedCurrency) },
      sandbox: true, testOnly: true,
      note: 'Sandbox test only. No real money is processed.',
    });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: 'paypal_error', message: 'PayPal Sandbox request failed. No payment was made.' });
  }
};
