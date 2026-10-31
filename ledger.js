/* 여행 가계부 정산 로직 — src/research_assistant/travel_ledger.py 와 같은 규칙·같은 JSON 형식.
 * 환율 우선순위: 실결제 기준통화액(base_amount) > 항목 환율(rate, 결제일 환율) > 여행 기본 환율(trip.rates).
 * 금액은 통화 최소 단위 정수로 반올림하고 큰 나머지 배분으로 순잔액 합계를 0으로 맞춘다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ZERO_DECIMAL = new Set(["KRW", "JPY", "VND", "IDR", "CLP", "ISK", "PYG", "UGX", "XAF", "XOF", "KMF", "RWF"]);

  class LedgerError extends Error {}

  const minorUnits = (c) => (ZERO_DECIMAL.has(c) ? 0 : 2);
  const toMinor = (v, c) => Math.round(v * 10 ** minorUnits(c) + 1e-9 * Math.sign(v));
  const fromMinor = (v, c) => v / 10 ** minorUnits(c);
  const fmtMinor = (v, c) => fromMinor(v, c).toFixed(minorUnits(c));

  function num(value, field = "금액") {
    const n = Number(String(value ?? "").replace(/,/g, "").trim());
    if (String(value ?? "").trim() === "" || !Number.isFinite(n)) throw new LedgerError(`${field}이(가) 숫자가 아닙니다: ${value}`);
    return n;
  }

  function currencyCode(value) {
    const code = String(value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new LedgerError(`통화 코드는 KRW, JPY 같은 3글자입니다: ${value}`);
    return code;
  }

  function newTrip({ id, name, members, base = "KRW", start = null, end = null }) {
    const clean = [...new Set(members.map((m) => m.trim()).filter(Boolean))];
    if (!clean.length) throw new LedgerError("참여자를 한 명 이상 입력하세요.");
    return { id, name: name || id, members: clean, base_currency: currencyCode(base), start, end,
      rates: {}, expenses: [], next_id: 1, version: 1 };
  }

  function rateOf(trip, currency, override) {
    if (currency === trip.base_currency) return 1;
    if (override) return Number(override);
    const entry = trip.rates[currency];
    if (!entry) throw new LedgerError(`${currency} 환율이 없습니다.`);
    return Number(entry.rate);
  }

  function baseValue(trip, e) {
    if (e.base_amount) return Number(e.base_amount);
    return Number(e.amount) * rateOf(trip, e.currency, e.rate);
  }

  function valueIn(trip, e, currency) {
    if (e.currency === currency && !e.base_amount) return Number(e.amount);
    return baseValue(trip, e) / rateOf(trip, currency);
  }

  function allocate(total, weights) {
    const names = Object.keys(weights);
    const sum = names.reduce((s, n) => s + weights[n], 0);
    const raw = {}, result = {};
    for (const n of names) { raw[n] = (total * weights[n]) / sum; result[n] = Math.trunc(raw[n]); }
    let leftover = total - names.reduce((s, n) => s + result[n], 0);
    const order = [...names].sort((a, b) =>
      (raw[b] - result[b]) - (raw[a] - result[a]) || weights[b] - weights[a]);
    for (const n of order) { if (leftover-- <= 0) break; result[n] += 1; }
    return result;
  }

  function minimalTransfers(balances) {
    const desc = (a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
    const creditors = Object.entries(balances).filter(([, v]) => v > 0).map(([n, v]) => [v, n]).sort(desc);
    const debtors = Object.entries(balances).filter(([, v]) => v < 0).map(([n, v]) => [-v, n]).sort(desc);
    const out = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const amount = Math.min(debtors[i][0], creditors[j][0]);
      if (amount) out.push({ from: debtors[i][1], to: creditors[j][1], amount });
      debtors[i][0] -= amount; creditors[j][0] -= amount;
      if (!debtors[i][0]) i++;
      if (!creditors[j][0]) j++;
    }
    return out;
  }

  function buildSplit(trip, amount, mode, values) {
    // mode: equal (values = [names]) | shares ({name: weight}) | exact ({name: amount})
    let weights = {};
    if (mode === "equal") for (const n of values) weights[n] = 1;
    else for (const [n, v] of Object.entries(values)) if (Number(v) > 0) weights[n] = Number(v);
    const names = Object.keys(weights);
    if (!names.length) throw new LedgerError("나눌 사람을 한 명 이상 고르세요.");
    const unknown = names.filter((n) => !trip.members.includes(n));
    if (unknown.length) throw new LedgerError(`참여자가 아닌 이름: ${unknown.join(", ")}`);
    if (mode === "exact") {
      const sum = names.reduce((s, n) => s + weights[n], 0);
      if (Math.abs(sum - amount) > 1e-6) throw new LedgerError(`개별 금액 합계(${sum})가 총액(${amount})과 다릅니다.`);
    }
    const out = {};
    for (const n of names) out[n] = String(weights[n]);
    return { type: mode, weights: out };
  }

  /* 여러 명이 나눠 낸 경우: payers = {이름: 낸 금액}. 합계는 총액과 같아야 하고, 한 명이면 단일 결제로 저장한다. */
  function cleanPayers(trip, payers, amount) {
    const entries = Object.entries(payers || {}).map(([n, v]) => [n.trim(), num(v, `${n} 낸 금액`)]).filter(([, v]) => v !== 0);
    if (!entries.length) throw new LedgerError("낸 사람을 고르세요.");
    for (const [n, v] of entries) {
      if (!trip.members.includes(n)) throw new LedgerError(`결제자가 참여자가 아닙니다: ${n}`);
      if (v < 0) throw new LedgerError("낸 금액은 0보다 커야 합니다.");
    }
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    if (Math.abs(sum - amount) > 1e-6) throw new LedgerError(`낸 금액 합계(${sum})가 총액(${amount})과 다릅니다.`);
    return entries.length > 1 ? Object.fromEntries(entries.map(([n, v]) => [n, String(v)])) : null;
  }

  function addExpense(trip, f) {
    const amount = num(f.amount);
    if (amount <= 0) throw new LedgerError("금액은 0보다 커야 합니다.");
    const payers = f.payers ? cleanPayers(trip, f.payers, amount) : null;
    if (f.payers) f.payer = Object.keys(f.payers).find((n) => Number(String(f.payers[n]).replace(/,/g, "")) > 0);
    if (!trip.members.includes(f.payer)) throw new LedgerError(`결제자가 참여자가 아닙니다: ${f.payer}`);
    const e = {
      id: trip.next_id, kind: f.kind || "expense", date: f.date, title: (f.title || "").trim() || f.category || "기타",
      category: f.category || "기타", amount: String(amount), currency: currencyCode(f.currency), payer: f.payer,
      split: f.split, base_amount: f.base_amount ? String(num(f.base_amount, "실결제 금액")) : null,
      rate: f.rate ? String(num(f.rate, "환율")) : null, memo: f.memo || "",
    };
    if (payers) e.payers = payers;
    if (f.rate_source) e.rate_source = f.rate_source;
    if (f.rate_pending) e.rate_pending = true;
    trip.next_id += 1;
    trip.expenses.push(e);
    return e;
  }

  function needsDatedRate(trip, e) {
    return e.currency !== trip.base_currency && !e.base_amount && !e.rate;
  }

  function settle(trip, target, { convert = true, expenses = trip.expenses } = {}) {
    target = currencyCode(target || trip.base_currency);
    const z = () => Object.fromEntries(trip.members.map((m) => [m, 0]));
    const paid = z(), owed = z(), sent = z(), received = z();
    const byCategory = {}, lines = [], missing = new Set();
    const sorted = [...expenses].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    for (const e of sorted) {
      let value;
      try { value = convert ? valueIn(trip, e, target) : Number(e.amount); }
      catch (err) {
        for (const c of [e.currency, target]) if (c !== trip.base_currency && !trip.rates[c]) missing.add(c);
        continue;
      }
      const total = toMinor(value, target);
      const weights = Object.fromEntries(Object.entries(e.split.weights).map(([n, w]) => [n, Number(w)]));
      const shares = allocate(total, weights);
      const transfer = e.kind === "transfer";
      if (transfer) sent[e.payer] += total;
      else if (e.payers) {
        const paidShares = allocate(total, Object.fromEntries(Object.entries(e.payers).map(([n, v]) => [n, Number(v)])));
        for (const [n, v] of Object.entries(paidShares)) paid[n] += v;
      } else paid[e.payer] += total;
      for (const [n, s] of Object.entries(shares)) (transfer ? received : owed)[n] += s;
      if (!transfer) byCategory[e.category] = (byCategory[e.category] || 0) + total;
      lines.push({ id: e.id, total, shares, transfer });
    }
    if (missing.size) {
      const err = new LedgerError(`환율이 없는 통화: ${[...missing].sort().join(", ")}`);
      err.missing = [...missing].sort();
      throw err;
    }
    const balances = Object.fromEntries(trip.members.map((m) => [m, paid[m] + sent[m] - owed[m] - received[m]]));
    return {
      currency: target, totalSpent: Object.values(owed).reduce((a, b) => a + b, 0),
      members: Object.fromEntries(trip.members.map((m) => [m,
        { paid: paid[m], share: owed[m], sent: sent[m], received: received[m], net: balances[m] }])),
      transfers: minimalTransfers(balances).map((t) => ({ ...t, currency: target })),
      byCategory, lines,
    };
  }

  function settleByCurrency(trip) {
    const codes = [...new Set(trip.expenses.map((e) => e.currency))].sort();
    return Object.fromEntries(codes.map((c) => [c,
      settle(trip, c, { convert: false, expenses: trip.expenses.filter((e) => e.currency === c) })]));
  }

  /* ---------- exchange rates (base per 1 unit). 무료 공개 API는 하루 1회 갱신되는 기준환율이다. */
  async function fetchRate(currency, base, date, fetcher = fetch) {
    currency = currencyCode(currency); base = currencyCode(base);
    const today = new Date().toISOString().slice(0, 10);
    const tag = !date || date >= today ? "latest" : date;
    const lc = currency.toLowerCase(), lb = base.toLowerCase();
    const sources = [
      [`https://api.frankfurter.dev/v1/${tag}?base=${currency}&symbols=${base}`, "ECB 기준환율 (frankfurter)",
        (d) => [d.rates[base], d.date]],
      [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/${lc}.json`, "currency-api",
        (d) => [d[lc][lb], d.date]],
    ];
    if (tag === "latest") sources.push([`https://open.er-api.com/v6/latest/${currency}`, "ExchangeRate-API",
      (d) => [d.rates[base], (d.time_last_update_utc || "").slice(5, 16)]]);
    const errors = [];
    for (const [url, label, pick] of sources) {
      try {
        const res = await fetcher(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const [rate, asOf] = pick(await res.json());
        if (!(Number(rate) > 0)) throw new Error("no rate");
        return { rate: Number(rate), source: label, asOf: asOf || tag };
      } catch (err) { errors.push(label); }
    }
    throw new LedgerError(`환율을 가져오지 못했습니다 (${errors.join(", ")}). 인터넷 연결을 확인하거나 직접 입력하세요.`);
  }

  return { LedgerError, minorUnits, toMinor, fromMinor, fmtMinor, num, currencyCode, newTrip, rateOf,
    valueIn, allocate, minimalTransfers, buildSplit, addExpense, needsDatedRate, settle, settleByCurrency, fetchRate };
});
