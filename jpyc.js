// JPYCタブ: 日本円ステーブルコインJPYCの新しい出来事を毎日少しずつ見るためのタブ。
//
// データは別リポジトリ matsuno04/jpyc-news-v2(卒業論文の研究データ)が毎日21:30頃に更新する
// data/recent_events.json(直近30日の出来事、本文なし)を読み込むだけで、あちらには何も書き込まない。
// デイリーのタブ(app.js)とは独立に動き、こちらの読み込みに失敗してもデイリーの表示には影響しない。
//
// 未読の考え方:
// - 「新しい出来事」= 最後にJPYCタブを開いた日時より後に初めて収集された出来事(first_collected_at)。バッジはこの数
// - 「続報」= 前回開いた日時より前に初出で、その後に記事が追加された出来事。バッジには数えない
// - 既読の日時は localStorage に保存(端末ごと)。初めて開くときは直近3日分を未読として扱う
// - タブを開いた時点で既読の日時を更新するが、その回の表示は開く前の日時を基準に「新着」の印を付ける

const JPYC_DATA_URL = "https://raw.githubusercontent.com/matsuno04/jpyc-news-v2/master/data/recent_events.json";
const JPYC_RUNS_API = "https://api.github.com/repos/matsuno04/jpyc-news-v2/actions/workflows/update.yml/runs";
const JPYC_RESEARCH_DASHBOARD_URL = "https://matsuno04.github.io/jpyc-news-v2/";

const JPYC_LAST_OPENED_KEY = "jpyc.lastOpenedAt";
const JPYC_STATUS_CACHE_KEY = "jpyc.runStatusCache";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIRST_VISIT_UNREAD_DAYS = 3;
const CARD_MIN_DAYS = 7;
const STATUS_CACHE_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 26 * HOUR; // 最後の成功からこれ以上たったら「更新が止まっている可能性」
const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // 画面に戻ったときの読み直しの最短間隔

// ---------------------------------------------------------------------------
// 判定のロジック(画面に依存しない。tests.html から直接テストする)
// ---------------------------------------------------------------------------
const JpycLogic = {
  // recent_events.json の日時はタイムゾーンなしの日本時間 "YYYY-MM-DD HH:MM:SS"
  parseJst(s) {
    if (!s) return null;
    const t = Date.parse(String(s).replace(" ", "T") + "+09:00");
    return Number.isNaN(t) ? null : t;
  },

  // localStorage が使えない(プライベートモード、容量超過、無効化など)場合でも例外を外に出さない
  readLastOpened(storage) {
    try {
      const v = storage ? storage.getItem(JPYC_LAST_OPENED_KEY) : null;
      const t = v === null ? NaN : Number(v);
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  },

  writeLastOpened(storage, now) {
    try {
      if (storage) storage.setItem(JPYC_LAST_OPENED_KEY, String(now));
      return true;
    } catch {
      return false;
    }
  },

  // 未読の基準となる日時。保存された値が無ければ(初回・保存できない環境)直近3日分を未読にする
  baseline(lastOpened, now) {
    return lastOpened === null ? now - FIRST_VISIT_UNREAD_DAYS * DAY : lastOpened;
  },

  isNewEvent(ev, baseline) {
    const t = JpycLogic.parseJst(ev.first_collected_at);
    return t !== null && t > baseline;
  },

  unreadCount(events, baseline) {
    return events.filter((ev) => JpycLogic.isNewEvent(ev, baseline)).length;
  },

  badgeLabel(count) {
    if (count <= 0) return "";
    return count >= 10 ? "9+" : String(count);
  },

  // 続報: 前回開いた日時より前に初出で、その後に記事が追加された出来事。追加された記事だけを返す
  followUps(events, baseline) {
    const out = [];
    for (const ev of events) {
      const first = JpycLogic.parseJst(ev.first_collected_at);
      if (first === null || first > baseline) continue;
      const added = (ev.articles || []).filter((a) => {
        const t = JpycLogic.parseJst(a.collected_at);
        return t !== null && t > baseline;
      });
      if (added.length) out.push({ event: ev, added });
    }
    out.sort((a, b) => JpycLogic.parseJst(b.event.last_collected_at) - JpycLogic.parseJst(a.event.last_collected_at));
    return out;
  },

  // カードにする出来事: 初出が「直近7日」と「前回開いた日時以降」の長いほうの範囲に入るもの。新しい順。
  // 続報に回した出来事はカードにしない
  cardEvents(events, baseline, now) {
    const since = Math.min(now - CARD_MIN_DAYS * DAY, baseline);
    const followUpIds = new Set(JpycLogic.followUps(events, baseline).map((f) => f.event.event_id));
    return events
      .filter((ev) => {
        const t = JpycLogic.parseJst(ev.first_collected_at);
        return t !== null && t >= since && !followUpIds.has(ev.event_id);
      })
      .sort((a, b) => JpycLogic.parseJst(b.first_collected_at) - JpycLogic.parseJst(a.first_collected_at));
  },

  // 代表記事以外の媒体の数(媒体名の重複は除く)
  otherOutletCount(ev) {
    const rep = ev.representative && ev.representative.domain;
    const domains = new Set((ev.articles || []).map((a) => a.domain).filter(Boolean));
    domains.delete(rep);
    return domains.size;
  },

  // タブを開いたときの処理。表示に使う基準(開く前の日時)を返し、保存する既読の日時は「今」に進める
  openTab(storage, now) {
    const shownBaseline = JpycLogic.baseline(JpycLogic.readLastOpened(storage), now);
    JpycLogic.writeLastOpened(storage, now);
    return shownBaseline;
  },

  // ワークフロー実行の一覧から、表示する状態を決める
  summarizeRuns(completedRuns, now) {
    const latest = completedRuns[0] || null;
    const success = completedRuns.find((r) => r.conclusion === "success") || null;
    const lastSuccessAt = success ? Date.parse(success.run_started_at) : null;
    return {
      lastSuccessAt,
      lastFailed: !!latest && latest.conclusion !== "success",
      stale: lastSuccessAt === null || now - lastSuccessAt > STALE_AFTER_MS,
    };
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

// カードには代表記事の公開日を出す(新着の判定は初出=first_collected_at のまま)。
// 時刻が 00:00:00 の記事は日付しか分からないものが多いため、日付だけを出す
function formatPublished(s) {
  const t = JpycLogic.parseJst(s);
  if (t === null) return "不明";
  return / 00:00:00$/.test(String(s)) ? formatJstShort(t).split(" ")[0] : formatJstShort(t);
}

function safeUrl(url) {
  return /^https?:\/\//.test(String(url)) ? url : "#";
}

const jpycState = { events: null, loadError: null, lastFetchAt: 0, activeTab: "daily", shownBaseline: null };

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
    const s = JpycLogic.summarizeRuns(await fetchRunStatus(now), now);
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

function renderJpycCard(ev, isUnread) {
  const rep = ev.representative || {};
  const others = JpycLogic.otherOutletCount(ev);
  const tags = (ev.tags || []).map((t) => `<span class="jpyc-tag">${jpycEscape(t)}</span>`).join("");
  return `
    <article class="news-card jpyc-card${isUnread ? " is-unread" : ""}">
      <div class="card-header jpyc-card-header">
        ${isUnread ? `<span class="jpyc-unread-dot" aria-label="新着"></span>` : ""}
        ${tags}
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
  const title = (f.event.representative && f.event.representative.title) || f.event.event_id;
  return `
    <details class="brief-item jpyc-followup">
      <summary class="brief-link">${jpycEscape(title)} <span class="jpyc-followup-count">+${f.added.length}件</span></summary>
      <div class="brief-list jpyc-followup-list">${items}</div>
    </details>`;
}

function renderJpycView(shownBaseline) {
  const content = document.getElementById("jpyc-content");
  if (jpycState.loadError) {
    content.innerHTML = `<p class="error">${jpycEscape(jpycState.loadError)}</p>`;
    return;
  }
  if (!jpycState.events) {
    content.innerHTML = `<p class="loading">読み込み中…</p>`;
    return;
  }
  const now = Date.now();
  const events = jpycState.events;
  const unread = JpycLogic.unreadCount(events, shownBaseline);
  const followUps = JpycLogic.followUps(events, shownBaseline);
  if (unread === 0 && followUps.length === 0) {
    content.innerHTML = `<p class="empty">新しい出来事はありません</p>`;
    return;
  }
  const cards = JpycLogic.cardEvents(events, shownBaseline, now);
  content.innerHTML = `
    <section class="section">
      <h2 class="section-title">新しい出来事${unread ? `<span class="jpyc-section-count">新着 ${unread}件</span>` : ""}</h2>
      <div class="card-list">${cards.map((ev) => renderJpycCard(ev, JpycLogic.isNewEvent(ev, shownBaseline))).join("")}</div>
    </section>
    ${
      followUps.length
        ? `<section class="section">
             <h2 class="section-title">続報</h2>
             <div class="brief-list">${followUps.map(renderJpycFollowUp).join("")}</div>
           </section>`
        : ""
    }`;
}

function updateJpycBadge() {
  const badge = document.getElementById("jpyc-badge");
  if (!jpycState.events) {
    badge.hidden = true;
    return;
  }
  const now = Date.now();
  const base = JpycLogic.baseline(JpycLogic.readLastOpened(safeStorage()), now);
  const label = JpycLogic.badgeLabel(JpycLogic.unreadCount(jpycState.events, base));
  badge.textContent = label;
  badge.hidden = label === "";
}

async function loadJpycData() {
  jpycState.lastFetchAt = Date.now();
  try {
    jpycState.events = await fetchJpycEvents();
    jpycState.loadError = null;
  } catch (err) {
    // 前回読めたデータがあればそれを使い続ける
    // 通信できないときのブラウザの英語のメッセージ("Failed to fetch" など)はそのまま出さない
    const message = /^JPYCの/.test(err && err.message)
      ? err.message
      : "JPYCのデータを読み込めませんでした。通信状況を確認して、あとで開き直してください";
    if (!jpycState.events) jpycState.loadError = message;
  }
}

function openJpycTab() {
  const shownBaseline = JpycLogic.openTab(safeStorage(), Date.now());
  jpycState.shownBaseline = shownBaseline;
  renderJpycView(shownBaseline);
  updateJpycBadge();
  renderJpycStatus();
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
  if (tab === "jpyc") openJpycTab();
}

async function initJpycTab() {
  document.getElementById("jpyc-research-link").href = JPYC_RESEARCH_DASHBOARD_URL;
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }
  await loadJpycData();
  updateJpycBadge();
  // データが届く前にJPYCタブを開いていた場合は、開いたときの基準で描き直す
  if (jpycState.activeTab === "jpyc") renderJpycView(jpycState.shownBaseline);

  // ホーム画面から開いたPWAは、裏から戻ってもページを読み直さないことがあるため、
  // 画面に戻ってきたときにデータを読み直してバッジを更新する(短い間隔での連続取得はしない)
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - jpycState.lastFetchAt < REFRESH_MIN_INTERVAL_MS) return;
    await loadJpycData();
    if (jpycState.activeTab === "jpyc") openJpycTab();
    else updateJpycBadge();
  });
}

if (typeof document !== "undefined" && document.getElementById("jpyc-view")) {
  initJpycTab();
}
