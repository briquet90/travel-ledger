/* 여행정산가계부 beta·댕가계부 공용 — 휴대폰 브라우저용. 데이터는 이 기기 localStorage, 환율은 온라인일 때 실시간 조회. */
(() => {
  "use strict";
  const L = window.Ledger;
  const $ = (id) => document.getElementById(id);
  const BASE = new URL(".", document.currentScript.src);
  // 앱마다 기록 저장소를 따로 쓴다(댕가계부는 <html data-store-key="daeng-ledger-v1">).
  const KEY = document.documentElement.dataset.storeKey || "dogi-travel-v1";
  const RATE_CACHE = "dogi-travel-rates-v1";
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- storage */
  let store = { trips: {}, current: null };
  try { store = JSON.parse(localStorage.getItem(KEY)) || store; } catch (e) { /* 새로 시작 */ }
  let rateCache = {};
  try { rateCache = JSON.parse(localStorage.getItem(RATE_CACHE)) || {}; } catch (e) { /* 없음 */ }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); }
    catch (e) { flash("저장 공간에 쓰지 못했습니다. 브라우저 설정의 사이트 데이터 허용을 확인하세요."); }
  }
  function saveTrip(trip) {
    trip.updated_at = new Date().toISOString().slice(0, 19);
    trip.updated_on = "mobile";
    store.trips[trip.id] = trip;
    store.current = trip.id;
    persist();
    if (trip.shared && Sync) {
      // 이 객체가 출발한 서버 상태(origin)와 비교해 이 기기에서 바꾼 것만 보낸다 → 다른 사람이 추가한 기록을 지우지 않는다.
      Sync.push(origins.get(trip) || null, trip);
      origins.set(trip, clone(trip));
    }
  }

  /* ---------------- 공유(동기화) */
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const origins = new WeakMap();
  const watching = {};
  const syncState = {};
  let Sync = null;
  const emuParam = new URLSearchParams(location.search).get("emu");
  const syncReady = import(new URL("firebase-config.js", BASE))
    .then((m) => (m.FIREBASE_CONFIG || emuParam ? import(new URL("sync.js", BASE)) : null))
    .then((m) => { Sync = m && m.available ? m : null; return Sync; })
    .catch(() => null);

  function watchTrip(id) {
    if (!Sync || watching[id]) return;
    watching[id] = Sync.watch(id, (r) => {
      const old = store.trips[id];
      if (r.missing || r.error) {
        syncState[id] = r.missing ? "없는 링크" : "연결 오류";
        if (r.missing && store.keyring) { Sync.keyringRemove(store.keyring.key, [id]); store.keyring.known = store.keyring.known.filter((x) => x !== id); }
        if (old && old.joining) {
          delete store.trips[id]; stopWatching(id);
          if (store.current === id) store.current = Object.keys(store.trips)[0] || null;
          persist();
          flash(r.missing ? "초대 링크의 가계부를 찾지 못했습니다. 링크를 다시 확인하세요." : "공유 가계부에 연결하지 못했습니다.");
        }
        renderAll();
        return;
      }
      const t = r.trip;
      if (old) { t.last_currency = old.last_currency; t.last_payer = old.last_payer; }
      origins.set(t, clone(t));
      store.trips[id] = t;
      syncState[id] = !navigator.onLine ? (r.pending ? "오프라인 · 연결되면 자동 전송" : "오프라인")
        : r.pending ? "보내는 중" : r.fromCache ? "연결 중" : "동기화됨";
      persist();
      renderAll();
      if (old && old.joining) ensureKeyring();
    });
  }
  function stopWatching(id) { if (watching[id]) { watching[id](); delete watching[id]; } }
  const shareLink = (id) => `${location.origin}${location.pathname}#t=${id}`;
  const placeholder = (id) => ({ id, shared: true, joining: true, name: "공유 가계부 불러오는 중…", members: [],
    base_currency: "KRW", start: null, end: null, rates: {}, expenses: [] });

  /* ---------------- 내 가계부 열쇠
   * store.keyring = { key, known: [서버 열쇠 목록에서 확인한 여행 id] }.
   * 다른 기기에서 지운 여행(known 에 있었는데 서버 목록에서 빠짐)은 이 기기에서도 뺀다.
   * 이 기기에만 있는 공유 여행(known 에 없음)은 열쇠에 올린다. */
  let keyringStop = null, keyringBusy = false, keyState = "";
  const myShared = () => Object.values(store.trips).filter((t) => t.shared && !t.joining).map((t) => t.id);
  const keyLink = (k) => `${location.origin}${location.pathname}#k=${k}`;

  async function ensureKeyring() {
    if (!Sync || keyringBusy) return;
    if (!store.keyring) {
      const ids = myShared();
      if (!ids.length) { renderKeyring(); return; }
      keyringBusy = true;
      try {
        const key = await Sync.newKeyring(ids);
        store.keyring = { key, known: ids };
        persist();
      } catch (e) {
        keyState = navigator.onLine ? "열쇠를 만들지 못했습니다. 잠시 뒤 다시 열어 주세요." : "인터넷에 연결되면 열쇠를 만듭니다.";
        renderKeyring(); return;
      } finally { keyringBusy = false; }
    }
    const known = new Set(store.keyring.known);
    const add = myShared().filter((id) => !known.has(id));
    if (add.length) { Sync.keyringAdd(store.keyring.key, add); store.keyring.known.push(...add); persist(); }
    startKeyring();
    renderKeyring();
  }

  function startKeyring() {
    if (keyringStop || !store.keyring) return;
    const key = store.keyring.key;
    keyringStop = Sync.watchKeyring(key, (r) => {
      if (!store.keyring || store.keyring.key !== key) return;
      if (r.missing) { // 서버에 없는 열쇠(잘못 붙여넣음 등): 버리고 새로 만든다
        keyringStop(); keyringStop = null; store.keyring = null; persist();
        keyState = "열쇠를 찾지 못해 새 열쇠를 만들었습니다.";
        ensureKeyring(); return;
      }
      if (r.error) { keyState = "열쇠 연결 오류"; renderKeyring(); return; }
      const remote = new Set(r.trips);
      const hadNone = !trip();
      let changed = false;
      for (const id of remote) if (!store.trips[id]) { store.trips[id] = placeholder(id); watchTrip(id); changed = true; }
      if (!r.fromCache) {
        for (const id of store.keyring.known) {
          if (remote.has(id) || !store.trips[id] || !store.trips[id].shared) continue;
          stopWatching(id); delete store.trips[id]; changed = true; // 다른 기기에서 목록에서 뺐다
        }
        store.keyring.known = [...remote];
      } else store.keyring.known = [...new Set([...store.keyring.known, ...remote])];
      if (!store.trips[store.current]) store.current = Object.keys(store.trips)[0] || null;
      keyState = r.fromCache ? "연결 중" : "동기화됨";
      persist();
      if (changed && hadNone && trip()) show("log"); // 새 브라우저에서 열쇠로 불러온 경우 바로 기록 화면
      if (changed) renderAll(); else renderKeyring();
    });
  }

  function adoptKey(key) {
    if (keyringStop) { keyringStop(); keyringStop = null; }
    store.keyring = { key, known: [] }; // known 이 비었으니 이 기기의 공유 여행은 모두 새 열쇠에 합쳐진다
    persist();
    keyState = "불러오는 중…";
    ensureKeyring();
  }

  function renderKeyring() {
    const card = $("key-card");
    card.hidden = !Sync;
    if (card.hidden) return;
    const k = store.keyring;
    $("key-on").hidden = !k;
    if (k) $("key-link").value = keyLink(k.key);
    $("key-send").hidden = !navigator.share;
    const local = Object.values(store.trips).filter((t) => !t.shared);
    $("key-local").hidden = !local.length;
    $("key-local").textContent = local.length
      ? `이 기기에만 저장된 여행 ${local.length}개(${local.map((t) => t.name).join(", ")})는 열쇠에 들어가지 않아요. 브라우저를 바꾸면 사라지니 온라인에 올려 두세요.` : "";
    $("key-upload").hidden = !local.length;
    $("key-state").textContent = k ? `상태: ${keyState || "연결 중"}` : (keyState || "온라인 여행이 생기면 열쇠가 자동으로 만들어져요.");
  }
  const trip = () => store.trips[store.current] || null;

  /* ---------------- formatting */
  function fmt(value, cur) {
    const mu = L.minorUnits(cur);
    return new Intl.NumberFormat("ko-KR", { minimumFractionDigits: mu, maximumFractionDigits: mu }).format(value);
  }
  const fmtMinor = (v, cur) => fmt(L.fromMinor(v, cur), cur);
  const curLabel = (cur) => (cur === "KRW" ? "원" : cur);
  const rateText = (r) => (r >= 100 ? r.toFixed(2) : r >= 1 ? r.toFixed(4) : r.toPrecision(4));

  /* ---------------- exchange rates */
  async function getRate(cur, base, date) {
    const tag = !date || date >= today() ? "latest:" + today() : date;
    const key = `${cur}>${base}@${tag}`;
    const hit = rateCache[key];
    if (hit && (!tag.startsWith("latest") || Date.now() - hit.at < 30 * 60 * 1000)) return hit;
    if (!navigator.onLine) throw new L.LedgerError("오프라인");
    const r = await L.fetchRate(cur, base, date);
    const entry = { ...r, at: Date.now() };
    rateCache[key] = entry;
    try { localStorage.setItem(RATE_CACHE, JSON.stringify(rateCache)); } catch (e) { /* 캐시 생략 */ }
    return entry;
  }

  async function fillPendingRates() {
    const t = trip();
    if (!t || !navigator.onLine) return 0;
    let filled = 0;
    for (const e of t.expenses) {
      if (!(e.rate_pending || L.needsDatedRate(t, e))) continue;
      try {
        const r = await getRate(e.currency, t.base_currency, e.date);
        e.rate = String(r.rate); e.rate_source = `${r.source} ${r.asOf}`; delete e.rate_pending; filled++;
      } catch (err) { e.rate_pending = true; }
    }
    if (filled) saveTrip(t);
    renderLog();
    return filled;
  }

  async function refreshTripRates(force) {
    const t = trip();
    if (!t || !navigator.onLine) return;
    const curs = tripCurrencies(t).filter((c) => c !== t.base_currency);
    let changed = false;
    for (const c of curs) {
      const old = t.rates[c];
      if (!force && old && old.as_of && old.fetched === today()) continue;
      try {
        const r = await getRate(c, t.base_currency, null);
        t.rates[c] = { rate: String(r.rate), source: r.source, as_of: r.asOf, fetched: today() };
        changed = true;
      } catch (e) { /* 다음 통화 */ }
    }
    if (changed) { saveTrip(t); }
    renderTrip();
  }

  function tripCurrencies(t) {
    return [...new Set([t.base_currency, ...t.expenses.map((e) => e.currency), ...Object.keys(t.rates)])];
  }

  /* ---------------- network badge */
  function renderNet() {
    const b = $("net-badge");
    b.textContent = navigator.onLine ? "실시간 환율" : "오프라인";
    b.className = "net" + (navigator.onLine ? "" : " off");
  }
  addEventListener("online", () => { renderNet(); fillPendingRates(); refreshTripRates(false); updateRatePreview(); });
  addEventListener("offline", () => { renderNet(); updateRatePreview(); });

  /* ---------------- header & tabs */
  function renderHeader() {
    const sel = $("trip-select");
    const ids = Object.keys(store.trips);
    sel.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(store.trips[id].name)}</option>`).join("") +
      `<option value="__new">+ 새 여행</option>`;
    const t = trip();
    if (t) sel.value = t.id; else sel.value = "__new";
    $("trip-meta").textContent = t
      ? `${t.shared ? `공유 · ${syncState[t.id] || (Sync ? "연결 중" : "공유 기능 꺼짐")}  ·  ` : ""}${t.members.join(" · ")}  ·  기준 ${t.base_currency}${t.start ? `  ·  ${t.start.slice(5)}~${(t.end || "").slice(5)}` : ""}`
      : "여행을 만들면 기록을 시작할 수 있습니다.";
  }
  $("trip-select").addEventListener("change", (ev) => {
    if (ev.target.value === "__new") { store.current = null; show("trip"); fillTripForm(null); }
    else { store.current = ev.target.value; persist(); splitValues = {}; closeForm(); }
    renderAll();
    if (trip()) { refreshTripRates(false); fillPendingRates(); }
  });

  let view = "log";
  function show(name) {
    view = name;
    for (const v of ["log", "settle", "trip"]) $("view-" + v).hidden = v !== name;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
    if (name === "settle") renderSettle();
    if (name === "trip") renderTrip();
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    if (!trip() && b.dataset.view !== "trip") { show("trip"); fillTripForm(null); return; }
    show(b.dataset.view);
  }));

  /* ---------------- currency picker (브라우저 자동완성 대신 화면 아래 시트) */
  const CURRENCIES = [
    ["KRW", "원", "대한민국"], ["JPY", "엔", "일본"], ["USD", "달러", "미국"], ["EUR", "유로", "유럽"],
    ["CNY", "위안", "중국"], ["TWD", "대만 달러", "대만"], ["HKD", "홍콩 달러", "홍콩"], ["MOP", "파타카", "마카오"],
    ["THB", "바트", "태국"], ["VND", "동", "베트남"], ["PHP", "페소", "필리핀"], ["SGD", "싱가포르 달러", "싱가포르"],
    ["MYR", "링깃", "말레이시아"], ["IDR", "루피아", "인도네시아 발리"], ["KHR", "리엘", "캄보디아"], ["LAK", "킵", "라오스"],
    ["MNT", "투그릭", "몽골"], ["INR", "루피", "인도"], ["NPR", "네팔 루피", "네팔"], ["AED", "디르함", "아랍에미리트 두바이"],
    ["TRY", "리라", "튀르키예 터키"], ["GBP", "파운드", "영국"], ["CHF", "스위스 프랑", "스위스"], ["CZK", "코루나", "체코"],
    ["HUF", "포린트", "헝가리"], ["PLN", "즐로티", "폴란드"], ["DKK", "덴마크 크로네", "덴마크"], ["NOK", "노르웨이 크로네", "노르웨이"],
    ["SEK", "스웨덴 크로나", "스웨덴"], ["ISK", "아이슬란드 크로나", "아이슬란드"], ["AUD", "호주 달러", "호주"],
    ["NZD", "뉴질랜드 달러", "뉴질랜드"], ["CAD", "캐나다 달러", "캐나다"], ["MXN", "멕시코 페소", "멕시코"],
    ["BRL", "헤알", "브라질"], ["EGP", "이집트 파운드", "이집트"], ["ZAR", "랜드", "남아공"],
  ].filter((c) => c[1]);
  const picker = { onPick: null, current: "" };

  function openPicker(current, onPick) {
    picker.onPick = onPick; picker.current = current;
    $("cur-search").value = "";
    renderPicker();
    $("cur-picker").hidden = false;
    document.body.classList.add("noscroll");
    $("cur-list").scrollTop = 0;
  }
  function closePicker() { $("cur-picker").hidden = true; document.body.classList.remove("noscroll"); }

  function renderPicker() {
    const q = $("cur-search").value.trim().toLowerCase();
    const match = (c) => !q || c[0].toLowerCase().includes(q) || c[1].includes(q) || c[2].toLowerCase().includes(q);
    const t = trip();
    const used = t ? tripCurrencies(t) : [];
    const row = (c) => `<button type="button" class="cur-item ${c[0] === picker.current ? "on" : ""}" data-code="${c[0]}"><b>${c[0]}</b><span>${esc(c[1])}</span><small>${esc(c[2])}</small></button>`;
    const known = new Map(CURRENCIES.map((c) => [c[0], c]));
    const usedRows = used.map((code) => known.get(code) || [code, "", ""]).filter(match);
    const rest = CURRENCIES.filter((c) => !used.includes(c[0]) && match(c));
    let html = "";
    const upper = q.toUpperCase();
    if (/^[A-Z]{3}$/.test(upper) && !known.has(upper) && !used.includes(upper)) html += row([upper, "직접 입력한 통화", "환율은 자동 조회를 시도합니다"]);
    if (usedRows.length) html += `<div class="cur-group">이 여행에서 쓴 통화</div>` + usedRows.map(row).join("");
    if (rest.length) html += `<div class="cur-group">${q ? "검색 결과" : "전체"}</div>` + rest.map(row).join("");
    $("cur-list").innerHTML = html || `<p class="hint">찾는 통화가 없으면 영문 3글자 코드(예: GEL)를 입력하세요.</p>`;
  }
  $("cur-search").addEventListener("input", renderPicker);
  $("cur-list").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-code]");
    if (!b) return;
    const pick = picker.onPick;
    closePicker();
    if (pick) pick(b.dataset.code);
  });
  $("cur-picker").addEventListener("click", (ev) => { if (ev.target.dataset.close) closePicker(); });
  addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("cur-picker").hidden) closePicker(); });

  function setFormCurrency(code) {
    $("f-currency").value = code;
    $("f-currency-btn").textContent = code;
    renderChips(); updateRatePreview(); renderSplitAmounts(); renderPayerHint();
  }
  $("f-currency-btn").addEventListener("click", () => openPicker($("f-currency").value, setFormCurrency));
  function setTripBase(code) { $("t-base").value = code; $("t-base-btn").textContent = code; }
  $("t-base-btn").addEventListener("click", () => openPicker($("t-base").value, setTripBase));

  /* ---------------- entry form */
  const form = { kind: "expense", payer: null, payers: [], multiPay: false, receiver: null, mode: "equal", rate: null, manual: false };
  let payValues = {};
  let payTouched = new Set(); // 직접 고친 '낸 금액'. 나머지 사람은 남은 금액을 똑같이 나눠 자동으로 채운다.
  let editing = null; // 수정 중인 기록 id

  function openForm(e) {
    const t = trip();
    if (!t) return;
    const wasEditing = editing !== null;
    editing = e ? e.id : null;
    form.kind = "expense"; form.mode = "equal"; form.manual = false; form.rate = null;
    form.payer = t.last_payer && t.members.includes(t.last_payer) ? t.last_payer : t.members[0];
    form.receiver = null;
    form.payers = [form.payer];
    form.multiPay = false;
    payValues = {};
    payTouched = new Set();
    if (e || wasEditing) splitValues = {}; // 새 기록은 지난번 나누기 설정을 이어 쓴다
    $("f-date").value = today();
    $("f-category").value = "식비";
    $("f-title").value = ""; $("f-amount").value = ""; $("f-rate").value = ""; $("f-base").value = ""; $("f-memo").value = "";
    $("f-currency").value = t.last_currency || t.base_currency;
    if (e) fillFormFrom(t, e);
    $("f-currency-btn").textContent = $("f-currency").value;
    $("form-error").textContent = "";
    $("entry-form").hidden = false;
    $("open-form").hidden = true;
    const submit = $("entry-form").querySelector("button[type=submit]");
    submit.textContent = editing ? "수정 저장" : "저장";
    $("entry-form").classList.toggle("editing", !!editing);
    renderForm();
    if (editing) $("entry-form").scrollIntoView({ behavior: "smooth", block: "start" });
    else $("f-amount").focus();
  }

  // 저장된 기록을 입력 칸에 채운다(수정).
  function fillFormFrom(t, e) {
    const transfer = e.kind === "transfer";
    form.kind = transfer ? "transfer" : "expense";
    $("f-date").value = e.date || today();
    $("f-amount").value = e.amount;
    $("f-currency").value = e.currency;
    $("f-memo").value = e.memo || "";
    if (transfer) {
      form.payer = e.payer; form.payers = [e.payer];
      form.receiver = Object.keys(e.split.weights)[0] || null;
    } else {
      $("f-title").value = e.title || "";
      if ([...$("f-category").options].some((o) => o.value === e.category)) $("f-category").value = e.category;
      if (e.payers && Object.keys(e.payers).length > 1) {
        form.multiPay = true;
        form.payers = t.members.filter((m) => e.payers[m] !== undefined);
        for (const m of form.payers) { payValues[m] = e.payers[m]; payTouched.add(m); }
      } else form.payers = [e.payer];
      form.payer = form.payers[0];
      const type = e.split.type || "equal";
      form.mode = ["equal", "shares", "exact"].includes(type) ? type : "shares";
      if (form.mode === "equal") splitValues.equal = Object.fromEntries(t.members.map((m) => [m, e.split.weights[m] !== undefined]));
      else splitValues[form.mode] = Object.fromEntries(t.members.map((m) => [m, e.split.weights[m] ?? ""]));
      if (e.base_amount) $("f-base").value = e.base_amount;
    }
    if (e.rate && e.rate_source === "직접 입력") { form.manual = true; $("f-rate").value = e.rate; }
  }

  function closeForm() {
    editing = null;
    $("entry-form").hidden = true; $("open-form").hidden = false;
    $("entry-form").classList.remove("editing");
  }
  $("open-form").addEventListener("click", () => openForm());
  $("multi-pay").addEventListener("click", () => {
    form.multiPay = !form.multiPay;
    if (!form.multiPay) form.payers = [form.payers[0]];
    form.payer = form.payers[0];
    renderForm();
  });
  $("cancel-form").addEventListener("click", closeForm);

  document.querySelectorAll("#entry-form .seg[role=tablist] button").forEach((b) => b.addEventListener("click", () => {
    form.kind = b.dataset.kind; renderForm();
  }));
  document.querySelectorAll("#split-mode button").forEach((b) => b.addEventListener("click", () => {
    form.mode = b.dataset.mode; renderSplit();
  }));
  $("rate-edit").addEventListener("click", () => {
    form.manual = !form.manual;
    if (form.manual && form.rate && !$("f-rate").value) $("f-rate").value = rateText(form.rate.rate);
    updateRatePreview();
  });
  for (const id of ["f-amount", "f-rate", "f-base"]) $(id).addEventListener("input", () => { renderSplitAmounts(); renderPayerHint(); updateRatePreview(false); });
  $("f-date").addEventListener("change", () => updateRatePreview());

  function renderForm() {
    const t = trip();
    document.querySelectorAll("#entry-form .seg[role=tablist] button").forEach((b) => b.classList.toggle("on", b.dataset.kind === form.kind));
    const transfer = form.kind === "transfer";
    document.querySelectorAll("#entry-form .expense-only").forEach((el) => { el.hidden = transfer; });
    document.querySelectorAll("#entry-form .transfer-only").forEach((el) => { el.hidden = !transfer; });
    $("payer-legend").textContent = transfer ? "보낸 사람" : form.multiPay ? "낸 사람 (나눠 낸 사람을 모두 선택)" : "낸 사람";
    $("multi-pay").hidden = transfer;
    $("multi-pay").textContent = form.multiPay ? "한 사람이 냈어요" : "여러 명이 나눠 냈어요";
    if (transfer) {
      pills("f-payer", t.members, form.payer, (m) => { form.payer = m; if (form.receiver === m) form.receiver = null; renderForm(); });
    } else {
      pills("f-payer", t.members, form.payers, (m) => {
        if (!form.multiPay) form.payers = [m]; // 기본: 누르면 그 사람으로 바뀜
        else {
          const on = form.payers.includes(m);
          if (on && form.payers.length === 1) return; // 최소 한 명
          form.payers = on ? form.payers.filter((x) => x !== m) : t.members.filter((x) => x === m || form.payers.includes(x));
        }
        form.payer = form.payers[0];
        renderForm();
      });
    }
    renderPayers();
    if (transfer) pills("f-receiver", t.members.filter((m) => m !== form.payer), form.receiver, (m) => { form.receiver = m; renderForm(); });
    renderChips();
    renderSplit();
    updateRatePreview();
  }

  function pills(id, items, selected, onPick) {
    const box = $(id);
    const isOn = (m) => (Array.isArray(selected) ? selected.includes(m) : m === selected);
    box.innerHTML = items.map((m) => `<button type="button" class="${isOn(m) ? "on" : ""}" aria-pressed="${isOn(m)}">${esc(m)}</button>`).join("");
    [...box.children].forEach((b, i) => b.addEventListener("click", () => onPick(items[i])));
  }

  // 여러 명이 나눠 낸 경우 각자 낸 금액
  function renderPayers() {
    const box = $("payer-amounts");
    const multi = form.kind === "expense" && form.payers.length > 1;
    box.hidden = !multi;
    if (!multi) { box.innerHTML = ""; $("payer-hint").textContent = ""; return; }
    const vals = autoPayValues();
    box.innerHTML = form.payers.map((m, i) => `<div class="split-row"><span class="name">${esc(m)} 낸 금액</span><input type="text" inputmode="decimal" id="pay-${i}" value="${esc(vals[m] ?? "")}" placeholder="0" aria-label="${esc(m)} 낸 금액"></div>`).join("");
    form.payers.forEach((m, i) => $("pay-" + i).addEventListener("input", (e) => {
      payValues[m] = e.target.value;
      if (e.target.value.trim()) payTouched.add(m); else payTouched.delete(m);
      renderPayerHint();
    }));
    renderPayerHint();
  }

  // 직접 고치지 않은 사람은 (총액 − 직접 넣은 금액)을 똑같이 나눈 금액. 기본은 전원 동일 금액.
  function autoPayValues() {
    const out = { ...payValues };
    const free = form.payers.filter((m) => !payTouched.has(m));
    for (const m of free) out[m] = "";
    if (!free.length) return out;
    let amount = 0;
    try { amount = L.num($("f-amount").value); } catch (e) { amount = 0; }
    if (!(amount > 0)) return out;
    const cur = /^[A-Z]{3}$/.test(($("f-currency").value || "").toUpperCase()) ? $("f-currency").value.toUpperCase() : "KRW";
    const fixed = form.payers.filter((m) => payTouched.has(m)).reduce((s, m) => s + (Number(String(payValues[m] ?? "").replace(/,/g, "")) || 0), 0);
    const rest = L.toMinor(amount - fixed, cur);
    if (rest <= 0) return out;
    const shares = L.allocate(rest, Object.fromEntries(free.map((m) => [m, 1])));
    for (const m of free) out[m] = String(L.fromMinor(shares[m], cur));
    return out;
  }
  function refreshAutoPay() {
    if (form.payers.length < 2 || $("payer-amounts").hidden) return;
    const vals = autoPayValues();
    form.payers.forEach((m, i) => { const el = $("pay-" + i); if (el && !payTouched.has(m) && el !== document.activeElement) el.value = vals[m] ?? ""; });
  }

  function payerAmounts() {
    const vals = autoPayValues();
    return Object.fromEntries(form.payers.map((m) => [m, String(vals[m] ?? "").replace(/,/g, "").trim() || "0"]));
  }

  function renderPayerHint() {
    const hint = $("payer-hint");
    if (form.payers.length < 2) { hint.textContent = ""; return; }
    refreshAutoPay();
    let amount = 0;
    try { amount = L.num($("f-amount").value); } catch (e) { amount = 0; }
    const cur = ($("f-currency").value || "KRW").toUpperCase();
    const c = /^[A-Z]{3}$/.test(cur) ? cur : "KRW";
    const sum = Object.values(payerAmounts()).reduce((s, v) => s + (Number(v) || 0), 0);
    const left = amount - sum;
    hint.textContent = !amount ? "총액을 먼저 입력하세요." :
      Math.abs(left) < 1e-9 ? `합계 ${fmt(sum, c)} ${curLabel(cur)} — 총액과 같습니다.` :
      `남은 금액 ${fmt(left, c)} ${curLabel(cur)}`;
  }

  function renderChips() {
    const t = trip();
    const curs = [...new Set([...tripCurrencies(t), "USD"])].slice(0, 6);
    const now = $("f-currency").value.toUpperCase();
    const box = $("chip-currencies");
    box.innerHTML = curs.map((c) => `<button type="button" class="${c === now ? "on" : ""}">${c}</button>`).join("");
    [...box.children].forEach((b) => b.addEventListener("click", () => setFormCurrency(b.textContent)));
  }

  // split editor
  let splitValues = {};
  function renderSplit() {
    const t = trip();
    document.querySelectorAll("#split-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === form.mode));
    const box = $("split-members");
    if (form.mode === "equal") {
      if (!splitValues.equal) splitValues.equal = Object.fromEntries(t.members.map((m) => [m, true]));
      box.innerHTML = t.members.map((m, i) => `<div class="split-row"><label class="name"><input type="checkbox" id="sp-${i}" ${splitValues.equal[m] !== false ? "checked" : ""}>${esc(m)}</label><span class="amt" data-amt="${i}"></span></div>`).join("");
      t.members.forEach((m, i) => $("sp-" + i).addEventListener("change", (e) => { splitValues.equal[m] = e.target.checked; renderSplitAmounts(); }));
    } else {
      const key = form.mode;
      if (!splitValues[key]) splitValues[key] = Object.fromEntries(t.members.map((m) => [m, key === "shares" ? "1" : ""]));
      box.innerHTML = t.members.map((m, i) => `<div class="split-row"><span class="name">${esc(m)}</span><input type="text" inputmode="decimal" id="sp-${i}" value="${esc(splitValues[key][m] ?? "")}" placeholder="${key === "shares" ? "0" : "0"}" aria-label="${esc(m)} ${key === "shares" ? "비율" : "금액"}"><span class="amt" data-amt="${i}"></span></div>`).join("");
      t.members.forEach((m, i) => $("sp-" + i).addEventListener("input", (e) => { splitValues[key][m] = e.target.value; renderSplitAmounts(); }));
    }
    renderSplitAmounts();
  }

  function currentSplit(amount) {
    const t = trip();
    if (form.mode === "equal") return L.buildSplit(t, amount, "equal", t.members.filter((m) => splitValues.equal?.[m] !== false));
    const vals = {};
    for (const m of t.members) { const v = String(splitValues[form.mode]?.[m] ?? "").replace(/,/g, "").trim(); if (v) vals[m] = Number(v); }
    return L.buildSplit(t, amount, form.mode, vals);
  }

  function renderSplitAmounts() {
    const t = trip();
    if (!t || form.kind !== "expense") return;
    const cur = ($("f-currency").value || t.base_currency).toUpperCase();
    let amount = 0;
    try { amount = L.num($("f-amount").value); } catch (e) { amount = 0; }
    const hint = $("split-hint");
    hint.textContent = "";
    document.querySelectorAll("#split-members .amt").forEach((el) => { el.textContent = ""; });
    if (form.mode === "equal") {
      const n = t.members.filter((m) => splitValues.equal?.[m] !== false).length;
      hint.textContent = n === t.members.length ? `${n}명 모두 똑같이 나눕니다. 빠질 사람은 체크를 끄세요.` : `${t.members.length}명 중 ${n}명이 똑같이 나눕니다.`;
    }
    if (!(amount > 0)) return;
    try {
      const split = currentSplit(amount);
      const weights = Object.fromEntries(Object.entries(split.weights).map(([n, w]) => [n, Number(w)]));
      const shares = L.allocate(L.toMinor(amount, /^[A-Z]{3}$/.test(cur) ? cur : "KRW"), weights);
      t.members.forEach((m, i) => {
        const el = document.querySelector(`[data-amt="${i}"]`);
        if (el && shares[m] !== undefined) el.textContent = fmtMinor(shares[m], cur);
      });
    } catch (e) {
      if (form.mode === "exact") {
        const sum = t.members.reduce((s, m) => s + (Number(String(splitValues.exact?.[m] ?? "").replace(/,/g, "")) || 0), 0);
        hint.textContent = `남은 금액 ${fmt(amount - sum, /^[A-Z]{3}$/.test(cur) ? cur : "KRW")} ${curLabel(cur)}`;
      } else hint.textContent = e.message;
    }
  }

  // live rate preview
  let rateSeq = 0;
  async function updateRatePreview(refetch = true) {
    const t = trip();
    if (!t || $("entry-form").hidden) return;
    const cur = ($("f-currency").value || "").toUpperCase();
    const base = t.base_currency;
    const box = $("rate-box");
    if (!/^[A-Z]{3}$/.test(cur) || cur === base) { box.hidden = true; form.rate = null; return; }
    box.hidden = false;
    document.querySelectorAll(".cur-a").forEach((el) => { el.textContent = cur; });
    document.querySelectorAll(".cur-b").forEach((el) => { el.textContent = base; });
    $("rate-manual").hidden = !form.manual;
    $("rate-edit").textContent = form.manual ? "자동 환율 사용" : "직접 입력";
    const text = $("rate-text");
    let amount = 0;
    try { amount = L.num($("f-amount").value); } catch (e) { amount = 0; }
    const baseAmt = $("f-base").value.trim();
    if (baseAmt && form.kind === "expense") { text.innerHTML = `실제 결제 금액 <b>${esc(baseAmt)} ${curLabel(base)}</b>으로 계산합니다.`; return; }
    if (form.manual) {
      const r = Number($("f-rate").value.replace(/,/g, ""));
      text.innerHTML = r > 0 ? `직접 입력 1 ${cur} = <b>${rateText(r)}</b> ${base}${amount ? ` · ≈ <b>${fmt(amount * r, base)}</b> ${curLabel(base)}` : ""}` : "환율을 입력하세요.";
      return;
    }
    const date = $("f-date").value || today();
    const paint = () => {
      if (!form.rate || ($("f-base").value.trim() && form.kind === "expense")) return;
      const r = form.rate;
      text.innerHTML = `1 ${cur} = <b>${rateText(r.rate)}</b> ${base} · ${esc(r.source)} ${esc(r.asOf)}` +
        (amount ? ` · ≈ <b>${fmt(amount * r.rate, base)}</b> ${curLabel(base)}` : "");
    };
    if (!refetch && form.rate && form.rate.cur === cur && form.rate.date === date) { paint(); return; }
    const seq = ++rateSeq;
    form.rate = null;
    text.textContent = `${date === today() ? "실시간" : date} 환율 확인 중…`;
    try {
      const r = await getRate(cur, base, date);
      if (seq !== rateSeq) return;
      form.rate = { ...r, cur, date };
      paint();
    } catch (e) {
      if (seq !== rateSeq) return;
      text.textContent = navigator.onLine
        ? `${cur} 환율을 찾지 못했습니다. 직접 입력하거나, 저장 후 나중에 채울 수 있습니다.`
        : "오프라인입니다. 저장해 두면 인터넷이 연결될 때 결제일 환율로 자동 계산합니다.";
    }
  }

  $("entry-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const t = trip();
    const err = $("form-error");
    err.textContent = "";
    try {
      const amount = L.num($("f-amount").value);
      const currency = L.currencyCode($("f-currency").value);
      const date = $("f-date").value || today();
      const fields = { date, amount, currency, payer: form.payer, memo: $("f-memo").value.trim() };
      if (form.kind === "transfer") {
        if (!form.receiver) throw new L.LedgerError("받은 사람을 고르세요.");
        Object.assign(fields, { kind: "transfer", title: `${form.payer} → ${form.receiver} 송금`, category: "정산 송금",
          split: { type: "exact", weights: { [form.receiver]: String(amount) } } });
      } else {
        Object.assign(fields, { title: $("f-title").value, category: $("f-category").value, split: currentSplit(amount) });
        if (form.payers.length > 1) fields.payers = payerAmounts();
        if ($("f-base").value.trim() && currency !== t.base_currency) fields.base_amount = $("f-base").value;
      }
      const old = editing !== null ? t.expenses.find((x) => String(x.id) === String(editing)) : null;
      if (editing !== null && !old) throw new L.LedgerError("수정하던 기록이 사라졌습니다(다른 사람이 지웠을 수 있어요).");
      if (currency !== t.base_currency && !fields.base_amount) {
        if (form.manual) {
          const r = L.num($("f-rate").value, "환율");
          if (!(r > 0)) throw new L.LedgerError("환율은 0보다 커야 합니다.");
          fields.rate = r; fields.rate_source = "직접 입력";
        } else if (form.rate && form.rate.cur === currency) {
          fields.rate = form.rate.rate; fields.rate_source = `${form.rate.source} ${form.rate.asOf}`;
        } else if (old && old.rate && old.currency === currency && old.date === date) {
          fields.rate = old.rate; if (old.rate_source) fields.rate_source = old.rate_source; // 오프라인 수정: 원래 환율 유지
        } else fields.rate_pending = true;
      }
      if (old) {
        // 같은 id로 바꿔 끼운다 → 공유 여행은 그 문서 하나만 갱신된다.
        const idx = t.expenses.indexOf(old);
        const rest = t.expenses.filter((x) => x !== old);
        const tmp = { ...t, expenses: [] };
        const e = L.addExpense(tmp, { ...fields, id: old.id });
        rest.splice(idx, 0, e);
        t.expenses = rest;
      } else {
        if (t.shared) fields.id = L.newId();
        L.addExpense(t, fields);
      }
      t.last_currency = currency; t.last_payer = form.payer;
      saveTrip(t);
      document.dispatchEvent(new CustomEvent("ledger:saved", { detail: { kind: fields.kind || "expense" } }));
      closeForm();
      renderLog();
      if (fields.rate_pending) fillPendingRates();
    } catch (e) {
      err.textContent = e instanceof L.LedgerError ? e.message : "저장하지 못했습니다. 입력값을 확인하세요.";
    }
  });

  /* ---------------- log */
  function convertedBase(t, e) {
    try { return L.toMinor(L.valueIn(t, e, t.base_currency), t.base_currency); } catch (err) { return null; }
  }

  function renderLog() {
    const t = trip();
    const list = $("entries");
    if (!t) { list.innerHTML = ""; return; }
    const items = [...t.expenses].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : L.compareIds(b.id, a.id)));
    let total = 0;
    for (const e of items) if (e.kind !== "transfer") total += convertedBase(t, e) || 0;
    $("total-spent").textContent = `${fmtMinor(total, t.base_currency)} ${curLabel(t.base_currency)}`;
    const pending = items.filter((e) => e.rate_pending || (L.needsDatedRate(t, e) && !t.rates[e.currency])).length;
    $("pending-banner").hidden = !pending;
    $("pending-text").textContent = `환율이 비어 있는 기록 ${pending}건`;
    $("empty-log").hidden = items.length > 0;
    const days = {};
    for (const e of items) (days[e.date] = days[e.date] || []).push(e);
    list.innerHTML = Object.entries(days).map(([day, es]) => {
      const dayTotal = es.filter((e) => e.kind !== "transfer").reduce((s, e) => s + (convertedBase(t, e) || 0), 0);
      return `<li class="day"><span>${esc(day)} (${"일월화수목금토"[new Date(day + "T00:00").getDay()]})</span><span>${fmtMinor(dayTotal, t.base_currency)}</span></li>` +
        es.map((e, i) => {
          const conv = convertedBase(t, e);
          const n = Object.keys(e.split.weights).length;
          const cls = ["entry", e.kind === "transfer" ? "transfer" : "", i === 0 ? "first" : "", i === es.length - 1 ? "last" : ""].join(" ");
          const paidBy = e.payers ? Object.entries(e.payers).map(([p, v]) => `${esc(p)} ${fmt(Number(v), e.currency)}`).join(" + ") : esc(e.payer);
          const sub = e.kind === "transfer" ? "이미 주고받은 돈" : `${esc(e.category)} · ${paidBy} 결제 · ${n}명 나눔`;
          const right = e.currency === t.base_currency && !e.base_amount ? "" :
            conv === null ? `<span class="pending">환율 대기</span>` :
            `≈ ${fmtMinor(conv, t.base_currency)}${e.base_amount ? " 실결제" : ""}`;
          return `<li class="${cls}" data-id="${e.id}"><span class="t">${esc(e.title)}</span><span class="a">${fmt(Number(e.amount), e.currency)} ${curLabel(e.currency)}</span>` +
            `<span class="s">${sub}${e.memo ? " · " + esc(e.memo) : ""}</span><span class="c">${right}</span>` +
            `<span class="acts"><button type="button" class="link edit" data-edit="${esc(e.id)}">수정</button><button type="button" class="link del" data-del="${esc(e.id)}">삭제</button></span></li>`;
        }).join("");
    }).join("");
  }

  $("entries").addEventListener("click", (ev) => {
    const ed = ev.target.closest("[data-edit]");
    if (ed) {
      const t = trip();
      const e = t && t.expenses.find((x) => String(x.id) === ed.dataset.edit);
      if (e) openForm(e);
      return;
    }
    const btn = ev.target.closest("[data-del]");
    if (!btn) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "정말 삭제"; btn.classList.add("danger-text"); return; }
    const t = trip();
    t.expenses = t.expenses.filter((e) => String(e.id) !== btn.dataset.del);
    saveTrip(t);
    renderLog();
  });
  $("fill-rates").addEventListener("click", async () => {
    $("pending-text").textContent = "환율 가져오는 중…";
    const n = await fillPendingRates();
    if (!n) $("pending-text").textContent = navigator.onLine ? "환율을 찾지 못했습니다. 여행 탭에서 환율을 확인하세요." : "오프라인입니다.";
  });

  /* ---------------- settle */
  function renderSettleOptions() {
    const t = trip();
    const sel = $("settle-currency");
    const prev = sel.value;
    const curs = tripCurrencies(t);
    sel.innerHTML = curs.map((c) => `<option value="${c}">${c}${c === t.base_currency ? " (기준)" : ""}</option>`).join("") +
      `<option value="__by">통화별 (환산 없음)</option>`;
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : t.base_currency;
  }
  $("settle-currency").addEventListener("change", () => renderSettle(false));

  async function renderSettle(rebuild = true) {
    const t = trip();
    if (!t) return;
    if (rebuild) renderSettleOptions();
    const target = $("settle-currency").value;
    const out = $("settle-out");
    $("settle-error").textContent = "";
    if (target !== "__by" && target !== t.base_currency && !t.rates[target]) {
      out.innerHTML = `<p class="hint">${target} 환율을 가져오는 중…</p>`;
      await refreshTripRates(true);
    }
    try {
      if (target === "__by") {
        const all = L.settleByCurrency(t);
        out.innerHTML = Object.entries(all).map(([c, r]) => `<h2>${c}</h2>${settleHtml(t, r)}`).join("") ||
          `<p class="empty">기록이 없습니다.</p>`;
      } else {
        out.innerHTML = settleHtml(t, L.settle(t, target));
      }
    } catch (e) {
      out.innerHTML = "";
      $("settle-error").textContent = e.missing
        ? `${e.missing.join(", ")} 환율이 없어 계산할 수 없습니다. 인터넷에 연결한 뒤 기록 탭의 "환율 채우기"를 누르거나, 해당 기록에 실제 결제 금액을 넣으세요.`
        : e.message;
    }
  }

  function settleHtml(t, r) {
    const c = r.currency;
    const transfers = r.transfers.length
      ? `<div class="transfers">${r.transfers.map((x) => {
          const line = `${x.from} → ${x.to} ${fmtMinor(x.amount, c)} ${curLabel(c)}`;
          return `<div class="transfer-card"><span class="who"><b>${esc(x.from)}</b> → <b>${esc(x.to)}</b></span><span class="amt">${fmtMinor(x.amount, c)} ${curLabel(c)}</span><button type="button" class="link copy" data-copy="${esc(line)}">복사</button></div>`;
        }).join("")}</div>`
      : `<div class="settled">정산할 금액이 없습니다.</div>`;
    const rows = t.members.map((m) => {
      const v = r.members[m];
      const net = v.net;
      return `<tr><td>${esc(m)}</td><td class="num">${fmtMinor(v.paid, c)}</td><td class="num">${fmtMinor(v.share, c)}</td>` +
        `<td class="num">${fmtMinor(v.sent - v.received, c)}</td><td class="num ${net > 0 ? "get" : net < 0 ? "owe" : ""}">${net > 0 ? "+" : ""}${fmtMinor(net, c)}</td></tr>`;
    }).join("");
    const cats = Object.entries(r.byCategory).sort((a, b) => b[1] - a[1]);
    const max = cats.length ? cats[0][1] : 1;
    const bars = cats.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><span class="track"><span class="fill" style="width:${Math.max(2, (v / max) * 100).toFixed(1)}%"></span></span><span class="v">${fmtMinor(v, c)}</span></div>`).join("");
    return `${transfers}
      <div class="card"><h2>사람별 <small>총 지출 ${fmtMinor(r.totalSpent, c)} ${curLabel(c)}</small></h2>
        <div class="tbl-wrap"><table><thead><tr><th>이름</th><th>낸 돈</th><th>부담</th><th>송금</th><th>받을(+)/낼(−)</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hint">송금 = 이미 보낸 돈 − 받은 돈. 외화 지출은 결제일 환율, 원화로 결제한 예약은 실제 결제 금액으로 계산했습니다.</p></div>
      ${bars ? `<div class="card"><h2>분류별</h2><div class="bars">${bars}</div></div>` : ""}`;
  }

  $("settle-out").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-copy]");
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "복사됨"; }
    catch (e) { b.textContent = b.dataset.copy; }
  });

  /* ---------------- trip */
  function fillTripForm(t) {
    $("trip-form-title").textContent = t ? "여행 정보" : "새 여행";
    $("t-name").value = t ? t.name : "";
    $("t-start").value = t?.start || "";
    $("t-end").value = t?.end || "";
    $("t-members").value = t ? t.members.join(", ") : "";
    setTripBase(t ? t.base_currency : "KRW");
    $("t-base-btn").disabled = !!(t && t.expenses.length);
    $("trip-error").textContent = "";
  }
  $("trip-new").addEventListener("click", () => { store.current = null; fillTripForm(null); renderHeader(); });

  $("trip-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const err = $("trip-error");
    err.textContent = "";
    try {
      const name = $("t-name").value.trim();
      if (!name) throw new L.LedgerError("여행 이름을 입력하세요.");
      const members = [...new Set($("t-members").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))];
      const base = L.currencyCode($("t-base").value);
      let t = trip();
      if (!t) {
        const slug = name.replace(/[^0-9A-Za-z가-힣._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "trip";
        let id = slug, n = 2;
        while (store.trips[id]) id = `${slug}-${n++}`;
        t = L.newTrip({ id, name, members, base });
      } else {
        const used = new Set(t.expenses.flatMap((e) => [e.payer, ...Object.keys(e.payers || {}), ...Object.keys(e.split.weights)]));
        const removed = t.members.filter((m) => !members.includes(m) && used.has(m));
        if (removed.length) throw new L.LedgerError(`기록에 쓰인 사람은 뺄 수 없습니다: ${removed.join(", ")}`);
        if (!members.length) throw new L.LedgerError("참여자를 한 명 이상 입력하세요.");
        if (base !== t.base_currency && t.expenses.length) throw new L.LedgerError("기록이 있는 여행은 기준 통화를 바꿀 수 없습니다.");
        t.name = name; t.members = members;
        if (base !== t.base_currency) { t.base_currency = base; t.rates = {}; }
      }
      t.start = $("t-start").value || null;
      t.end = $("t-end").value || null;
      const makeShared = !trip() && $("t-shared").checked;
      saveTrip(t);
      splitValues = {};
      renderAll();
      // 온라인 저장은 뒤에서 한다(공유 기능이 아직 불러지는 중이면 기다렸다가). 화면은 바로 기록으로.
      // 오프라인이거나 실패하면 이 기기 여행으로 남고, 여행 탭에서 다시 올릴 수 있다.
      if (makeShared) syncReady.then((ok) => { if (ok && store.trips[t.id] && !store.trips[t.id].shared) { store.current = t.id; shareCurrent(); } });
      show("log");
      refreshTripRates(false);
    } catch (e) { err.textContent = e.message; }
  });

  // 개인 여행을 서버에 올려 공유 여행으로 바꾼다(id 가 바뀐다).
  async function shareTrip(t) {
    const shared = await Sync.share(t, L.newId);
    shared.last_currency = t.last_currency; shared.last_payer = t.last_payer;
    const wasCurrent = store.current === t.id;
    delete store.trips[t.id];
    store.trips[shared.id] = shared;
    if (wasCurrent) store.current = shared.id;
    origins.set(shared, clone(shared));
    persist();
    watchTrip(shared.id);
    return shared;
  }

  // 붙여 넣은 열쇠 링크(#k=…)·초대 링크(#t=…)로 여행을 불러온다.
  function openLinkText(text) {
    const v = String(text || "").trim();
    const k = (v.match(/#k=([A-Za-z0-9]{22})/) || [])[1] || (/^[A-Za-z0-9]{22}$/.test(v) ? v : null);
    const id = (v.match(/#t=([A-Za-z0-9]{22})/) || [])[1];
    if (!Sync) return { ok: false, msg: "공유 기능에 연결되지 않았습니다. 인터넷 연결을 확인하세요." };
    if (k) { adoptKey(k); return { ok: true, msg: "열쇠로 내 여행을 불러오는 중이에요." }; }
    if (id) {
      if (!store.trips[id]) store.trips[id] = placeholder(id);
      store.current = id; persist(); watchTrip(id); renderAll(); show("log");
      return { ok: true, msg: "초대받은 여행을 불러오는 중이에요." };
    }
    return { ok: false, msg: "열쇠 링크(#k=…)나 초대 링크(#t=…)를 붙여 넣어 주세요." };
  }

  async function shareCurrent() {
    const t = trip();
    if (!t || t.shared || !Sync) return;
    const msg = $("share-msg");
    msg.textContent = "온라인에 올리는 중…";
    $("share-make").disabled = true;
    try {
      await shareTrip(t);
      msg.textContent = "온라인에 저장했습니다. 같이 쓰려면 초대 링크를 보내세요.";
      ensureKeyring();
    } catch (e) {
      msg.textContent = navigator.onLine ? "링크를 만들지 못했습니다. 잠시 뒤 다시 시도하세요." : "인터넷에 연결된 상태에서 만들어 주세요.";
    } finally { $("share-make").disabled = false; renderAll(); }
  }
  $("share-make").addEventListener("click", shareCurrent);

  {
    const keyMsg = (s) => { $("key-msg").textContent = s; };
    $("key-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("key-link").value); keyMsg("열쇠 링크를 복사했어요. 나만 볼 수 있는 곳(나에게 보내기 메모 등)에 보관하세요."); }
      catch (e) { $("key-link").select(); keyMsg("링크를 길게 눌러 복사하세요."); }
    });
    $("key-send").addEventListener("click", async () => {
      try { await navigator.share({ title: "가계부 열쇠", text: "내 가계부 열쇠 링크 (나만 보관)", url: $("key-link").value }); }
      catch (e) { /* 취소 */ }
    });
    $("key-upload").addEventListener("click", async () => {
      if (!navigator.onLine) { keyMsg("인터넷에 연결된 상태에서 올려 주세요."); return; }
      $("key-upload").disabled = true;
      const local = Object.values(store.trips).filter((t) => !t.shared);
      let n = 0;
      for (const t of local) { try { await shareTrip(t); n++; } catch (e) { /* 다음 */ } }
      $("key-upload").disabled = false;
      keyMsg(n === local.length ? `${n}개 여행을 온라인에 올렸어요.` : `${local.length}개 중 ${n}개만 올렸어요. 잠시 뒤 다시 눌러 주세요.`);
      await ensureKeyring();
      renderAll();
    });
    $("key-open").addEventListener("click", () => {
      const r = openLinkText($("key-input").value);
      if (r.ok) $("key-input").value = "";
      keyMsg(r.msg);
    });
  }
  $("share-copy").addEventListener("click", async () => {
    const link = $("share-link").value;
    try { await navigator.clipboard.writeText(link); $("share-msg").textContent = "링크를 복사했습니다."; }
    catch (e) { $("share-link").select(); $("share-msg").textContent = "링크를 길게 눌러 복사하세요."; }
  });
  $("share-send").addEventListener("click", async () => {
    const t = trip(); if (!t) return;
    try { await navigator.share({ title: `${t.name} 가계부`, text: `${t.name} 여행 가계부에 같이 기록해요`, url: $("share-link").value }); }
    catch (e) { /* 취소 또는 미지원 */ }
  });

  function renderShare() {
    const t = trip();
    const card = $("share-card");
    card.hidden = !t || !Sync;
    if (card.hidden) return;
    $("share-personal").hidden = !!t.shared;
    $("share-on").hidden = !t.shared;
    if (t.shared) {
      $("share-link").value = shareLink(t.id);
      $("sync-state").textContent = `상태: ${syncState[t.id] || "연결 중"}`;
      $("share-send").hidden = !navigator.share;
    }
    $("share-me-warn").hidden = !t.members.includes("나");
    $("delete-trip").textContent = !t.shared ? "이 여행 삭제"
      : store.keyring ? "내 목록에서 이 여행 빼기 (내 모든 기기에서 빠지고, 공유 기록은 남음)" : "이 기기에서 이 여행 빼기 (공유 기록은 남음)";
  }

  function renderTrip() {
    const t = trip();
    renderShare();
    renderKeyring();
    $("t-shared-row").hidden = !!t || !Sync;
    if (view === "trip" && document.activeElement?.closest?.("#trip-form") == null) fillTripForm(t);
    const body = $("rates-body");
    if (!t) { body.innerHTML = ""; return; }
    const curs = tripCurrencies(t).filter((c) => c !== t.base_currency);
    body.innerHTML = curs.length
      ? curs.map((c) => { const r = t.rates[c]; return `<tr><td>1 ${c}</td><td>${r ? rateText(Number(r.rate)) + " " + t.base_currency : "—"}</td><td>${r ? esc(r.source) + " " + esc(r.as_of) : "아직 없음"}</td></tr>`; }).join("")
      : `<tr><td colspan="3">외화 기록이 생기면 여기에 오늘 환율이 표시됩니다.</td></tr>`;
    $("rates-asof").textContent = navigator.onLine ? "" : "오프라인";
  }
  $("refresh-rates").addEventListener("click", () => refreshTripRates(true));

  // backup
  const ioMsg = (s) => { $("io-msg").textContent = s; };
  $("export").addEventListener("click", () => {
    const t = exportable(trip()); if (!t) return;
    const blob = new Blob([JSON.stringify(t, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${t.id}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    ioMsg(`${t.id}.json 을 저장했습니다. OneDrive travel-ledgers 폴더로 옮기면 PC에서도 이어집니다.`);
  });
  $("copy-json").addEventListener("click", async () => {
    const t = exportable(trip()); if (!t) return;
    try { await navigator.clipboard.writeText(JSON.stringify(t, null, 2)); ioMsg("JSON을 복사했습니다."); }
    catch (e) { ioMsg("복사가 막혀 있습니다. 파일로 내보내기를 쓰세요."); }
  });
  // PC(travel_ledger.py)는 정수 항목 번호를 쓴다. 공유 여행은 날짜순으로 1,2,3… 번호를 붙여 내보낸다.
  function exportable(t) {
    if (!t) return null;
    const out = clone(t);
    if (out.shared) {
      out.expenses.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : L.compareIds(a.id, b.id)));
      out.expenses.forEach((e, i) => { e.share_id = e.id; e.id = i + 1; });
      out.next_id = out.expenses.length + 1;
      out.share_link = shareLink(t.id);
    }
    delete out.last_currency; delete out.last_payer;
    return out;
  }
  $("import").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const t = JSON.parse(await file.text());
      if (!t.id || !Array.isArray(t.members) || !Array.isArray(t.expenses) || !t.base_currency) throw new Error();
      if (t.shared) { t.id = `${t.id.slice(0, 6)}-copy`; delete t.shared; delete t.share_link; } // 가져온 파일은 개인 사본
      t.rates = t.rates || {}; t.next_id = t.next_id || (Math.max(0, ...t.expenses.map((e) => e.id)) + 1);
      const existed = !!store.trips[t.id];
      saveTrip(t);
      renderAll();
      ioMsg(`${t.name} 을(를) ${existed ? "덮어써서 " : ""}가져왔습니다 (기록 ${t.expenses.length}건).`);
    } catch (e) { ioMsg("가계부 JSON 파일이 아닙니다."); }
  });
  $("delete-trip").addEventListener("click", () => { $("delete-confirm").hidden = false; });
  $("delete-no").addEventListener("click", () => { $("delete-confirm").hidden = true; });
  $("delete-yes").addEventListener("click", () => {
    const t = trip(); if (!t) return;
    stopWatching(t.id);
    if (t.shared && store.keyring && Sync) {
      Sync.keyringRemove(store.keyring.key, [t.id]);
      store.keyring.known = store.keyring.known.filter((x) => x !== t.id);
    }
    delete store.trips[t.id];
    store.current = Object.keys(store.trips)[0] || null;
    persist();
    $("delete-confirm").hidden = true;
    renderAll();
    if (!trip()) { show("trip"); fillTripForm(null); }
  });

  function flash(msg) { $("io-msg").textContent = msg; }

  function renderAll() {
    renderNet(); renderHeader(); renderLog(); renderTrip();
    if (view === "settle") renderSettle();
  }


  /* ---------------- 아이폰 안내
   * 아이폰은 '홈 화면에 추가'한 앱과 사파리의 저장 공간이 따로다. 링크로 들어온 사파리에서는 링크를 복사해 두라고 안내하고,
   * 홈 화면 앱을 처음(여행 없이) 열면 복사한 링크를 붙여 넣는 버튼을 보여 준다. */
  function iosTips() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!ios) return;
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const banner = (html, btnText, onClick) => {
      const box = document.createElement("div");
      box.className = "banner ios-tip";
      box.innerHTML = `<span>${html}</span><span class="ios-acts"><button type="button" class="link">${btnText}</button><button type="button" class="link" data-x>닫기</button></span>`;
      const [btn, close] = box.querySelectorAll("button");
      btn.addEventListener("click", () => onClick(box));
      close.addEventListener("click", () => box.remove());
      $("view-log").prepend(box);
      return box;
    };
    if (!standalone && (join || keyParam)) {
      banner("아이폰: 공유 버튼 → <b>홈 화면에 추가</b>하면 앱처럼 쓸 수 있어요. 추가한 앱은 사파리와 기록이 따로라서, 먼저 <b>링크 복사</b>를 누르고 앱을 처음 열 때 <b>붙여넣기</b>를 누르세요.",
        "링크 복사", async (box) => {
          const link = store.keyring ? keyLink(store.keyring.key) : join ? shareLink(join) : keyLink(keyParam);
          try { await navigator.clipboard.writeText(link); box.querySelector("span").textContent = "복사했어요. 이제 공유 버튼 → 홈 화면에 추가 → 추가한 앱을 열고 '붙여넣기'를 누르세요."; }
          catch (e) { box.querySelector("span").textContent = link; }
        });
    }
    if (standalone && !Object.keys(store.trips).length) {
      banner("사파리에서 보던 가계부가 있나요? 복사해 둔 <b>초대 링크나 열쇠 링크</b>를 붙여 넣으면 그대로 이어져요.",
        "붙여넣기", async (box) => {
          let text = "";
          try { text = await navigator.clipboard.readText(); } catch (e) { /* 권한 거절 */ }
          const r = openLinkText(text);
          if (r.ok) box.remove();
          else { box.querySelector("span").textContent = text ? r.msg : "붙여넣기가 막혔어요. 여행 탭 '불러오기' 칸에 링크를 길게 눌러 붙여 넣으세요."; show("trip"); }
        });
      show("log");
    }
  }

  /* ---------------- boot */
  if (!store.current || !store.trips[store.current]) store.current = Object.keys(store.trips)[0] || null;
  // 카카오톡 안 브라우저로 초대·열쇠 링크를 열면 기본 브라우저(아이폰은 사파리)로 넘긴다.
  // 카톡 안 브라우저는 저장 공간이 따로라 나중에 여행을 찾기 어렵다.
  if (/KAKAOTALK/i.test(navigator.userAgent) && /^#[tk]=[A-Za-z0-9]{22}$/.test(location.hash)) {
    location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href);
  }
  const join = (location.hash.match(/^#t=([A-Za-z0-9]{22})$/) || [])[1];
  if (join) {
    history.replaceState(null, "", location.pathname + location.search);
    if (!store.trips[join]) store.trips[join] = placeholder(join);
    store.current = join;
  }
  const keyParam = (location.hash.match(/^#k=([A-Za-z0-9]{22})$/) || [])[1];
  if (keyParam) history.replaceState(null, "", location.pathname + location.search);
  renderAll();
  if (!trip()) { show("trip"); fillTripForm(null); }
  else { fillPendingRates(); refreshTripRates(false); }
  syncReady.then(() => {
    for (const [id, t] of Object.entries(store.trips)) if (t.shared) watchTrip(id);
    if (join && !Sync) flash("공유 기능이 아직 설정되지 않아 초대 링크를 열 수 없습니다.");
    if (Sync && keyParam && store.keyring?.key !== keyParam) adoptKey(keyParam);
    else ensureKeyring();
    renderAll();
    iosTips();
  });
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register(new URL("sw.js", BASE), { scope: BASE.pathname }).catch(() => {});
  }
})();
