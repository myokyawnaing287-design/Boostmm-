'use strict';

const SUPPORTED_TYPES = ['Default', 'Custom Comments'];

function toNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function pricing(settings) {
  return {
    fx: toNum(settings.usd_mmk, 4700),
    markup: Math.max(0, toNum(settings.markup_percent, 30)),
  };
}

function effectiveMarkup(service, p) {
  return service.markup_override != null ? Math.max(0, service.markup_override) : p.markup;
}

// Selling price in kyat per 1000 units.
function perThousandMMK(service, p) {
  return service.rate_usd * p.fx * (1 + effectiveMarkup(service, p) / 100);
}

// Selling price for `qty` units in cents-of-a-kyat, rounded UP so we never undercharge.
function chargeCents(service, qty, p) {
  const c = Math.ceil((perThousandMMK(service, p) * qty / 1000) * 100 - 1e-6);
  return Math.max(1, c);
}

module.exports = { SUPPORTED_TYPES, pricing, effectiveMarkup, perThousandMMK, chargeCents, toNum };
