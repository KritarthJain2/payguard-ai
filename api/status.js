'use strict';
const { getConfigStatus, sendJson } = require('./_lib');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  return sendJson(res, 200, getConfigStatus());
};
