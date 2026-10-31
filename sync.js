/* 공유 가계부 동기화 (Firebase Firestore). 공유 여행에서만 불러온다.
 * - 초대 링크 = 추측할 수 없는 22자 여행 id. 링크를 가진 사람은 로그인 없이 보고 편집한다.
 * - 여행 정보는 trips/{id}, 지출은 trips/{id}/expenses/{지출id} 문서 하나씩 → 동시에 입력해도 서로 덮어쓰지 않는다.
 * - 오프라인 입력은 기기(IndexedDB)에 쌓였다가 연결되면 자동 전송된다.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, collection, onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

const META = ["name", "members", "base_currency", "start", "end", "rates"];
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// 로컬 개발에서만: ?emu=127.0.0.1:8080 이면 Firestore 에뮬레이터 사용
const emu = new URLSearchParams(location.search).get("emu");
const config = emu ? { projectId: "demo-travel-ledger", apiKey: "demo", appId: "demo" } : FIREBASE_CONFIG;

let db = null;
if (config) {
  const app = initializeApp(config);
  db = initializeFirestore(app, emu ? {} : { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  if (emu) { const [host, port] = emu.split(":"); connectFirestoreEmulator(db, host, Number(port)); }
}

export const available = !!db;

export function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return [...bytes].map((b) => ID_CHARS[b % 62]).join("");
}
export const validShareId = (id) => /^[A-Za-z0-9]{22}$/.test(id || "");

const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
function metaOf(trip) {
  const m = {};
  for (const k of META) m[k] = clean(trip[k] ?? (k === "rates" ? {} : null));
  return m;
}
function expenseDoc(e) {
  const d = clean(e);
  d.id = String(d.id);
  return d;
}

/** 개인 여행을 공유 여행으로 올린다. 지출 id는 겹치지 않는 문자열로 바꾼다. 새 여행 객체를 돌려준다. */
export async function share(trip, newExpenseId) {
  const id = newShareId();
  const expenses = trip.expenses.map((e) => ({ ...e, id: newExpenseId() }));
  const shared = { ...trip, id, shared: true, expenses };
  delete shared.next_id;
  const tripRef = doc(db, "trips", id);
  // 한 번에 최대 500건씩 기록
  const chunks = [[]];
  for (const e of expenses) { if (chunks.at(-1).length >= 450) chunks.push([]); chunks.at(-1).push(e); }
  for (let i = 0; i < chunks.length; i++) {
    const batch = writeBatch(db);
    if (i === 0) batch.set(tripRef, { ...metaOf(shared), schema: 1, created_at: serverTimestamp(), updated_at: serverTimestamp() });
    for (const e of chunks[i]) batch.set(doc(tripRef, "expenses", e.id), expenseDoc(e));
    // 첫 묶음(여행 문서)은 서버 확인을 기다려야 링크가 유효하다. 오프라인이면 기기에 쌓인다.
    const done = batch.commit();
    if (i === 0) await Promise.race([done, new Promise((r) => setTimeout(r, 4000))]);
  }
  return shared;
}

/** 서버 상태를 구독한다. cb({trip, missing, fromCache, pending}) */
export function watch(id, cb) {
  const tripRef = doc(db, "trips", id);
  let meta = null, metaMissing = false, expenses = null, flags = { metaCache: true, expCache: true, metaPending: false, expPending: false };
  const emit = () => {
    if (metaMissing && !flags.metaCache) { cb({ missing: true }); return; }
    if (!meta || !expenses) return;
    cb({
      trip: { id, shared: true, ...meta, rates: meta.rates || {}, expenses },
      fromCache: flags.metaCache || flags.expCache,
      pending: flags.metaPending || flags.expPending,
    });
  };
  const opts = { includeMetadataChanges: true };
  const u1 = onSnapshot(tripRef, opts, (snap) => {
    flags.metaCache = snap.metadata.fromCache; flags.metaPending = snap.metadata.hasPendingWrites;
    metaMissing = !snap.exists();
    if (snap.exists()) { const d = snap.data(); meta = {}; for (const k of META) meta[k] = d[k] ?? null; }
    emit();
  }, (err) => cb({ error: err.code || "error" }));
  const u2 = onSnapshot(collection(tripRef, "expenses"), opts, (snap) => {
    flags.expCache = snap.metadata.fromCache; flags.expPending = snap.metadata.hasPendingWrites;
    expenses = snap.docs.map((d) => d.data());
    emit();
  }, (err) => cb({ error: err.code || "error" }));
  return () => { u1(); u2(); };
}

/** 마지막으로 받은 서버 상태(base)와 지금 기기 상태(trip)를 비교해 바뀐 것만 보낸다. */
export function push(base, trip) {
  const tripRef = doc(db, "trips", trip.id);
  const batch = writeBatch(db);
  let n = 0;
  const before = new Map((base?.expenses || []).map((e) => [String(e.id), JSON.stringify(expenseDoc(e))]));
  const now = new Map(trip.expenses.map((e) => [String(e.id), expenseDoc(e)]));
  for (const [id, d] of now) if (before.get(id) !== JSON.stringify(d)) { batch.set(doc(tripRef, "expenses", id), d); n++; }
  if (base) for (const id of before.keys()) if (!now.has(id)) { batch.delete(doc(tripRef, "expenses", id)); n++; }
  const m = metaOf(trip);
  const changed = {};
  for (const k of META) if (!base || JSON.stringify(clean(base[k] ?? (k === "rates" ? {} : null))) !== JSON.stringify(m[k])) changed[k] = m[k];
  if (Object.keys(changed).length) { batch.set(tripRef, { ...changed, updated_at: serverTimestamp() }, { merge: true }); n++; }
  if (n) batch.commit().catch((err) => console.warn("sync", err.code));
  return n;
}
