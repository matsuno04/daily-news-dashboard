// JPYCタブ: 日本円ステーブルコインJPYCの新しい出来事を毎日少しずつ見るためのタブ。
//
// データは別リポジトリ matsuno04/jpyc-news-v2(卒業論文の研究データ)が毎日21:30頃に更新する
// data/recent_events.json(直近30日の出来事、本文なし)を読み込むだけで、あちらには何も書き込まない。
// 主要のタブ(app.js)とは独立に動き、こちらの読み込みに失敗しても主要のタブの表示には影響しない。
//
// 既読の考え方(2026-10-02〜。以前は「タブを開いた時点で全部既読」だった):
// - 既読は出来事(event_id)ごとに localStorage に記録する。既読になるのはチェックを押したときだけで、
//   タブを開いただけでは既読にしない
// - 「新しい出来事」= 記録の無い出来事。バッジはこの数(10件以上は「9+」)
// - 「続報」= 既読の出来事のうち、既読にした時点の last_collected_at より後に記事が追加されたもの。
//   行を開いたとき、またはチェックを押したときに既読にする。バッジには数えない
// - 初めて使うとき(以前の「前回開いた日時」の仕組みからの切り替えを含む)は、直近3日に初めて収集された
//   出来事だけを未読にし、それより前の出来事は自動で既読として記録する(auto)。自動の記録は
//   「既読(直近7日)」の一覧には出さない(自分で既読にしたものではないため)
// - recent_events.json に含まれなくなった出来事の記録は削除し、記録が増え続けないようにする

const JPYC_DATA_URL = "https://raw.githubusercontent.com/matsuno04/jpyc-news-v2/master/data/recent_events.json";
const JPYC_RUNS_API = "https://api.github.com/repos/matsuno04/jpyc-news-v2/actions/workflows/update.yml/runs";
const JPYC_RESEARCH_DASHBOARD_URL = "https://matsuno04.github.io/jpyc-news-v2/";

const JPYC_READ_STATE_KEY = "jpyc.readState.v1";
const JPYC_LEGACY_LAST_OPENED_KEY = "jpyc.lastOpenedAt"; // 以前の仕組み。切り替え時に削除する
const JPYC_STATUS_CACHE_KEY = "jpyc.runStatusCache";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIRST_VISIT_UNREAD_DAYS = 3;
const READ_LIST_DAYS = 7;
const UNDO_MS = 5000;
const STATUS_CACHE_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 26 * HOUR; // 最後の成功からこれ以上たったら「更新が止まっている可能性」
const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // 画面に戻ったときの読み直しの最短間隔

// ---------------------------------------------------------------------------
// 判定のロジック(画面に依存しない。tests.html から直接テストする)
// 既読の状態は { initializedAt, events: { [event_id]: { readAt, lastCollectedAt, auto? } } }。
// 状態を変える関数は元の状態を書き換えず、新しい状態を返す(「元に戻す」で前の状態に戻せるように)
// ---------------------------------------------------------------------------
const JpycLogic = {
  // recent_events.json の日時はタイムゾーンなしの日本時間 "YYYY-MM-DD HH:MM:SS"
  parseJst(s) {
    if (!s) return null;
    const t = Date.parse(String(s).replace(" ", "T") + "+09:00");
    return Number.isNaN(t) ? null : t;
  },

  // localStorage が使えない(プライベートモード、容量超過、無効化など)場合でも例外を外に出さない
  loadReadState(storage) {
    try {
      const raw = storage ? storage.getItem(JPYC_READ_STATE_KEY) : null;
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object" || !s.events || typeof s.events !== "object") return null;
      return { initializedAt: Number(s.initializedAt) || 0, events: s.events };
    } catch {
      return null;
    }
  },

  saveReadState(storage, state) {
    try {
      if (!storage) return false;
      storage.setItem(JPYC_READ_STATE_KEY, JSON.stringify(state));
      storage.removeItem(JPYC_LEGACY_LAST_OPENED_KEY);
      return true;
    } catch {
      return false;
    }
  },

  // 記録が無ければ(初回・以前の仕組みからの切り替え・保存できない環境)作る。
  // 直近3日より前に初めて収集された出来事は、自動で既読として記録する
  ensureInitialized(state, events, now) {
    if (state) return state;
    const cutoff = now - FIRST_VISIT_UNREAD_DAYS * DAY;
    const records = {};
    for (const ev of events) {
      const first = JpycLogic.parseJst(ev.first_collected_at);
      if (first !== null && first <= cutoff) {
        records[ev.event_id] = { readAt: now, lastCollectedAt: ev.last_collected_at, auto: true };
      }
    }
    return { initializedAt: now, events: records };
  },

  // recent_events.json に含まれなくなった出来事の記録を削除する。
  // データが空(取得の不具合の可能性)のときは、記録を消しすぎないよう何もしない
  prune(state, events) {
    if (!events.length) return state;
    const ids = new Set(events.map((ev) => ev.event_id));
    const kept = {};
    for (const [id, rec] of Object.entries(state.events)) if (ids.has(id)) kept[id] = rec;
    return { ...state, events: kept };
  },

  isRead(state, ev) {
    return !!(state && state.events[ev.event_id]);
  },

  // 新しい出来事(未読)。新しく収集された順
  unreadEvents(state, events) {
    return events
      .filter((ev) => !JpycLogic.isRead(state, ev))
      .sort((a, b) => (JpycLogic.parseJst(b.first_collected_at) || 0) - (JpycLogic.parseJst(a.first_collected_at) || 0));
  },

  badgeLabel(count) {
    if (count <= 0) return "";
    return count >= 10 ? "9+" : String(count);
  },

  // 続報: 既読の出来事のうち、既読にした時点の last_collected_at より後に収集された記事があるもの
  followUps(state, events) {
    const out = [];
    for (const ev of events) {
      const rec = state && state.events[ev.event_id];
      if (!rec) continue;
      const seen = JpycLogic.parseJst(rec.lastCollectedAt);
      const added = (ev.articles || []).filter((a) => {
        const t = JpycLogic.parseJst(a.collected_at);
        return t !== null && (seen === null || t > seen);
      });
      if (added.length) out.push({ event: ev, added });
    }
    out.sort((a, b) => (JpycLogic.parseJst(b.event.last_collected_at) || 0) - (JpycLogic.parseJst(a.event.last_collected_at) || 0));
    return out;
  },

  // 既読(直近7日): 自分で既読にした出来事のうち、既読にしてから7日以内のもの。最近既読にした順
  recentlyRead(state, events, now) {
    const since = now - READ_LIST_DAYS * DAY;
    return events
      .filter((ev) => {
        const rec = state && state.events[ev.event_id];
        return rec && !rec.auto && rec.readAt >= since;
      })
      .sort((a, b) => state.events[b.event_id].readAt - state.events[a.event_id].readAt);
  },

  markRead(state, evs, now) {
    const events = { ...state.events };
    for (const ev of evs) events[ev.event_id] = { readAt: now, lastCollectedAt: ev.last_collected_at };
    return { ...state, events };
  },

  markUnread(state, ev) {
    const events = { ...state.events };
    delete events[ev.event_id];
    return { ...state, events };
  },

  // 続報を既読にする: 既読の記録の last_collected_at を今の値に進める(既読にした日時は変えない)
  markFollowUpRead(state, ev) {
    const rec = state.events[ev.event_id];
    if (!rec) return state;
    return { ...state, events: { ...state.events, [ev.event_id]: { ...rec, lastCollectedAt: ev.last_collected_at } } };
  },

  // 代表記事以外の媒体の数(媒体名の重複は除く)
  otherOutletCount(ev) {
    const rep = ev.representative && ev.representative.domain;
    const domains = new Set((ev.articles || []).map((a) => a.domain).filter(Boolean));
    domains.delete(rep);
    return domains.size;
  },

  // ワークフロー実行の一覧から、表示する状態を決める。
  // GitHub APIの並び順には頼らず開始日時で並べ直す。また、APIが古い一覧を返すことがあったため
  // (2026-10-02の確認で一度だけ、9/4の実行が最新として返った)、recent_events.json に入っている
  // 記事の最も新しい収集日時(dataLastCollectedAt)も「少なくともこの時刻には収集できていた」証拠として使い、
  // 遅いほうを最終収集日時とする
  summarizeRuns(completedRuns, now, dataLastCollectedAt = null) {
    const runs = completedRuns
      .map((r) => ({ conclusion: r.conclusion, at: Date.parse(r.run_started_at) }))
      .filter((r) => !Number.isNaN(r.at))
      .sort((a, b) => b.at - a.at);
    const latest = runs[0] || null;
    const success = runs.find((r) => r.conclusion === "success") || null;
    const candidates = [success && success.at, dataLastCollectedAt].filter((t) => typeof t === "number");
    const lastSuccessAt = candidates.length ? Math.max(...candidates) : null;
    return {
      lastSuccessAt,
      lastFailed: !!latest && latest.conclusion !== "success" && !(dataLastCollectedAt && dataLastCollectedAt > latest.at),
      stale: lastSuccessAt === null || now - lastSuccessAt > STALE_AFTER_MS,
    };
  },

  // recent_events.json に入っている記事の最も新しい収集日時
  dataLastCollectedAt(events) {
    let max = null;
    for (const ev of events || []) {
      const t = JpycLogic.parseJst(ev.last_collected_at);
      if (t !== null && (max === null || t > max)) max = t;
    }
    return max;
  },
};

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------
function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function jpycEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatJstShort(ms) {
  const p = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => p.find((x) => x.type === t).value;
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

// カードには代表記事の公開日を出す(未読の判定は既読の記録で行う)。
// 時刻が 00:00:00 の記事は日付しか分からないものが多いため、日付だけを出す
function formatPublished(s) {
  const t = JpycLogic.parseJst(s);
  if (t === null) return "不明";
  return / 00:00:00$/.test(String(s)) ? formatJstShort(t).split(" ")[0] : formatJstShort(t);
}

function safeUrl(url) {
  return /^https?:\/\//.test(String(url)) ? url : "#";
}

// readState はメモリ上の既読の状態。localStorage に保存できない環境でも、開いている間は既読の操作が効く
const jpycState = { events: null, loadError: null, lastFetchAt: 0, activeTab: "daily", readState: null, undoTimer: null };

async function fetchJpycEvents() {
  // HTTPキャッシュ(raw.githubusercontent.com は max-age=300)を使わず、毎回取りにいく
  const res = await fetch(JPYC_DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`JPYCのデータを取得できませんでした (HTTP ${res.status})`);
  const data = await res.json();
  return Array.isArray(data.events) ? data.events : [];
}

async function fetchRunStatus(now) {
  const storage = safeStorage();
  try {
    const cached = JSON.parse(storage ? storage.getItem(JPYC_STATUS_CACHE_KEY) : "null");
    if (cached && now - cached.fetchedAt < STATUS_CACHE_MS) return cached.runs;
  } catch {
    // 読めなければ取り直す
  }
  // 認証なしのGitHub APIはIPアドレスごとに1時間60回まで。結果を10分保存して回数を抑える
  const res = await fetch(`${JPYC_RUNS_API}?status=completed&per_page=10`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const runs = (data.workflow_runs || []).map((r) => ({ conclusion: r.conclusion, run_started_at: r.run_started_at }));
  try {
    if (storage) storage.setItem(JPYC_STATUS_CACHE_KEY, JSON.stringify({ fetchedAt: now, runs }));
  } catch {
    // 保存できなくても表示は続ける
  }
  return runs;
}

async function renderJpycStatus() {
  const el = document.getElementById("jpyc-status");
  const now = Date.now();
  try {
    const s = JpycLogic.summarizeRuns(await fetchRunStatus(now), now, JpycLogic.dataLastCollectedAt(jpycState.events));
    const parts = [
      `<span>JPYCの最終収集: ${s.lastSuccessAt ? formatJstShort(s.lastSuccessAt) : "不明"}</span>`,
    ];
    if (s.lastFailed) parts.push(`<span class="jpyc-status-warn">⚠ 前回の更新に失敗しました</span>`);
    if (s.stale) parts.push(`<span class="jpyc-status-warn">⚠ 更新が止まっている可能性があります</span>`);
    el.innerHTML = parts.join("");
  } catch {
    el.innerHTML = `<span>JPYCの更新状況を取得できませんでした</span>`;
  }
}

function headlineOf(ev) {
  return (ev.representative && ev.representative.title) || ev.event_id;
}

function renderJpycCard(ev) {
  const rep = ev.representative || {};
  const others = JpycLogic.otherOutletCount(ev);
  const tags = (ev.tags || []).map((t) => `<span class="jpyc-tag">${jpycEscape(t)}</span>`).join("");
  return `
    <article class="news-card jpyc-card" data-event-id="${jpycEscape(ev.event_id)}">
      <div class="card-header jpyc-card-header">
        <div class="jpyc-tags">${tags}</div>
        <button type="button" class="jpyc-check" data-action="read" data-event-id="${jpycEscape(ev.event_id)}" aria-label="既読にする">✓</button>
      </div>
      <h3 class="headline"><a class="jpyc-headline-link" href="${jpycEscape(safeUrl(rep.url))}" target="_blank" rel="noopener">${jpycEscape(rep.title)}</a></h3>
      ${rep.summary ? `<p class="summary">${jpycEscape(rep.summary)}</p>` : ""}
      <p class="jpyc-meta">${jpycEscape(rep.domain)}${others > 0 ? ` 他${others}媒体` : ""} ・ 公開 ${jpycEscape(formatPublished(rep.published_at))}</p>
    </article>`;
}

function renderJpycFollowUp(f) {
  const items = f.added
    .map(
      (a) => `
        <div class="brief-item">
          <a class="brief-link" href="${jpycEscape(safeUrl(a.url))}" target="_blank" rel="noopener">${jpycEscape(a.title)}<span class="jpyc-outlet">${jpycEscape(a.domain)}</span></a>
        </div>`
    )
    .join("");
  const id = jpycEscape(f.event.event_id);
  return `
    <div class="brief-item jpyc-followup-row">
      <details class="jpyc-followup" data-event-id="${id}">
        <summary class="brief-link">${jpycEscape(headlineOf(f.event))} <span class="jpyc-followup-count">+${f.added.length}件</span></summary>
        <div class="brief-list jpyc-followup-list">${items}</div>
      </details>
      <button type="button" class="jpyc-check jpyc-check-small" data-action="followup-read" data-event-id="${id}" aria-label="続報を既読にする">✓</button>
    </div>`;
}

function renderJpycReadItem(ev) {
  const id = jpycEscape(ev.event_id);
  return `
    <div class="brief-item jpyc-read-row">
      <a class="brief-link jpyc-read-link" href="${jpycEscape(safeUrl(ev.representative && ev.representative.url))}" target="_blank" rel="noopener">${jpycEscape(headlineOf(ev))}</a>
      <button type="button" class="jpyc-check jpyc-check-small is-checked" data-action="unread" data-event-id="${id}" aria-label="未読に戻す" aria-pressed="true">✓</button>
    </div>`;
}

function renderJpycView() {
  const content = document.getElementById("jpyc-content");
  if (jpycState.loadError) {
    content.innerHTML = `<p class="error">${jpycEscape(jpycState.loadError)}</p>`;
    return;
  }
  if (!jpycState.events || !jpycState.readState) {
    content.innerHTML = `<p class="loading">読み込み中…</p>`;
    return;
  }
  const state = jpycState.readState;
  const events = jpycState.events;
  // 「既読(直近7日)」を開いて操作しているときに、描き直しで閉じてしまわないようにする
  const readWasOpen = !!content.querySelector(".jpyc-read-section[open]");
  const unread = JpycLogic.unreadEvents(state, events);
  const followUps = JpycLogic.followUps(state, events);
  const read = JpycLogic.recentlyRead(state, events, Date.now());

  const newSection = unread.length
    ? `<section class="section">
         <h2 class="section-title jpyc-section-head">
           <span>新しい出来事<span class="jpyc-section-count">${unread.length}件</span></span>
           <button type="button" class="jpyc-text-btn" data-action="read-all">すべて既読にする</button>
         </h2>
         <div class="card-list">${unread.map(renderJpycCard).join("")}</div>
       </section>`
    : "";
  const followSection = followUps.length
    ? `<section class="section">
         <h2 class="section-title">続報</h2>
         <div class="brief-list">${followUps.map(renderJpycFollowUp).join("")}</div>
       </section>`
    : "";
  const empty = !unread.length && !followUps.length ? `<p class="empty jpyc-empty">新しい出来事はありません</p>` : "";
  const readSection = read.length
    ? `<details class="section jpyc-read-section"${readWasOpen ? " open" : ""}>
         <summary class="section-title">既読(直近7日)<span class="jpyc-section-count">${read.length}件</span></summary>
         <div class="brief-list">${read.map(renderJpycReadItem).join("")}</div>
       </details>`
    : "";
  content.innerHTML = empty + newSection + followSection + readSection;
}

function updateJpycBadge() {
  const badge = document.getElementById("jpyc-badge");
  if (!jpycState.events || !jpycState.readState) {
    badge.hidden = true;
    return;
  }
  const label = JpycLogic.badgeLabel(JpycLogic.unreadEvents(jpycState.readState, jpycState.events).length);
  badge.textContent = label;
  badge.hidden = label === "";
}

// 既読の状態を変え、保存して、描き直す。undoMessage があれば「元に戻す」を数秒出す
function applyReadState(next, undoMessage) {
  const previous = jpycState.readState;
  jpycState.readState = next;
  JpycLogic.saveReadState(safeStorage(), next);
  renderJpycView();
  updateJpycBadge();
  if (undoMessage) showUndo(undoMessage, previous);
}

function showUndo(message, previous) {
  const toast = document.getElementById("jpyc-toast");
  clearTimeout(jpycState.undoTimer);
  toast.innerHTML = `<span>${jpycEscape(message)}</span><button type="button" class="jpyc-undo-btn">元に戻す</button>`;
  toast.hidden = false;
  toast.querySelector(".jpyc-undo-btn").addEventListener("click", () => {
    hideUndo();
    applyReadState(previous, null);
  });
  jpycState.undoTimer = setTimeout(hideUndo, UNDO_MS);
}

function hideUndo() {
  clearTimeout(jpycState.undoTimer);
  const toast = document.getElementById("jpyc-toast");
  toast.hidden = true;
  toast.innerHTML = "";
}

function findEvent(id) {
  return (jpycState.events || []).find((ev) => ev.event_id === id);
}

function handleJpycClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn || !jpycState.readState) return;
  const state = jpycState.readState;
  const now = Date.now();
  const ev = findEvent(btn.dataset.eventId);
  switch (btn.dataset.action) {
    case "read":
      if (ev) applyReadState(JpycLogic.markRead(state, [ev], now), "既読にしました");
      break;
    case "read-all": {
      const unread = JpycLogic.unreadEvents(state, jpycState.events);
      if (unread.length) applyReadState(JpycLogic.markRead(state, unread, now), `${unread.length}件を既読にしました`);
      break;
    }
    case "followup-read":
      if (ev) applyReadState(JpycLogic.markFollowUpRead(state, ev), "続報を既読にしました");
      break;
    case "unread":
      if (ev) applyReadState(JpycLogic.markUnread(state, ev), "未読に戻しました");
      break;
  }
}

// 続報の行を開いたら既読にする。開いている行が消えないよう、この場では描き直さず保存とバッジの更新だけ行う
// (次に描き直したときに続報の一覧から消える)
function handleJpycToggle(e) {
  const details = e.target;
  if (!details.classList || !details.classList.contains("jpyc-followup") || !details.open) return;
  const ev = findEvent(details.dataset.eventId);
  if (!ev || !jpycState.readState) return;
  jpycState.readState = JpycLogic.markFollowUpRead(jpycState.readState, ev);
  JpycLogic.saveReadState(safeStorage(), jpycState.readState);
  updateJpycBadge();
}

async function loadJpycData() {
  jpycState.lastFetchAt = Date.now();
  try {
    const events = await fetchJpycEvents();
    jpycState.events = events;
    jpycState.loadError = null;
    // 既読の記録を用意し(初回は直近3日分を未読に)、含まれなくなった出来事の記録を削除して保存する
    const storage = safeStorage();
    const base = jpycState.readState || JpycLogic.loadReadState(storage);
    const next = JpycLogic.prune(JpycLogic.ensureInitialized(base, events, Date.now()), events);
    jpycState.readState = next;
    JpycLogic.saveReadState(storage, next);
  } catch (err) {
    // 前回読めたデータがあればそれを使い続ける
    // 通信できないときのブラウザの英語のメッセージ("Failed to fetch" など)はそのまま出さない
    const message = /^JPYCの/.test(err && err.message)
      ? err.message
      : "JPYCのデータを読み込めませんでした。通信状況を確認して、あとで開き直してください";
    if (!jpycState.events) jpycState.loadError = message;
  }
}

// JPYCのタブのヘッダーに出す今日の日付(例: "10.2 金")。主要のタブと見た目をそろえるための表示だけ
function renderTodayDate() {
  const p = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t).value;
  document.getElementById("date-today").textContent = `${get("month")}.${get("day")} ${get("weekday")}`;
}

function switchTab(tab) {
  jpycState.activeTab = tab;
  document.body.classList.toggle("tab-jpyc", tab === "jpyc");
  document.getElementById("daily-view").hidden = tab !== "daily";
  document.getElementById("jpyc-view").hidden = tab !== "jpyc";
  for (const btn of document.querySelectorAll(".tab-btn")) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  if (tab === "jpyc") {
    renderTodayDate();
    renderJpycView(); // タブを開いただけでは既読にしない
    renderJpycStatus();
  } else {
    hideUndo();
  }
}

async function initJpycTab() {
  document.getElementById("jpyc-research-link").href = JPYC_RESEARCH_DASHBOARD_URL;
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }
  const content = document.getElementById("jpyc-content");
  content.addEventListener("click", handleJpycClick);
  content.addEventListener("toggle", handleJpycToggle, true); // toggle は伝わらないため capture で受ける

  await loadJpycData();
  updateJpycBadge();
  if (jpycState.activeTab === "jpyc") renderJpycView();

  // ホーム画面から開いたPWAは、裏から戻ってもページを読み直さないことがあるため、
  // 画面に戻ってきたときにデータを読み直してバッジを更新する(短い間隔での連続取得はしない)
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - jpycState.lastFetchAt < REFRESH_MIN_INTERVAL_MS) return;
    await loadJpycData();
    updateJpycBadge();
    if (jpycState.activeTab === "jpyc") {
      renderJpycView();
      renderJpycStatus();
    }
  });
}

if (typeof document !== "undefined" && document.getElementById("jpyc-view")) {
  initJpycTab();
}
