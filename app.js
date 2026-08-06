// ステップ3: アーカイブ機能(日付セレクター)。
// data/index.json に、公開済みの日次データの日付一覧を保持する。
// daily-news-digest側からの自動連携(ステップ6)で、新しい日付が追記されていく想定。
const CATEGORY_ORDER = ["政治", "経済", "社会", "国際", "災害", "スポーツ", "エンタメ", "その他"];

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${path} の取得に失敗しました (HTTP ${res.status})`);
  }
  return res.json();
}

function categoryClass(category) {
  const idx = CATEGORY_ORDER.indexOf(category);
  return `cat-${idx >= 0 ? idx + 1 : 8}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// JSTでの「今日」をYYYY-MM-DD形式で返す(サーバー/ブラウザのタイムゾーンに依存しないように)
function todayInJst() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getUTCDay()];
  return `${y}年${m}月${d}日(${weekday})`;
}

// 2/2記事: Haiku要約(headline/summary/category) + 両ソースへのリンク
function renderMatchedCard(summary, event) {
  const nhk = event.sources["NHK"];
  const yahoo = event.sources["Yahoo!ニュース"];

  const article = document.createElement("article");
  article.className = "news-card";
  article.innerHTML = `
    <div class="card-header">
      <span class="category-badge ${categoryClass(summary.category)}">${escapeHtml(summary.category)}</span>
    </div>
    <h3 class="headline">${escapeHtml(summary.headline)}</h3>
    <p class="summary">${escapeHtml(summary.summary)}</p>
    <div class="source-links">
      ${nhk ? `<a class="source-link source-nhk" href="${nhk.link}" target="_blank" rel="noopener">NHKで読む</a>` : ""}
      ${yahoo ? `<a class="source-link source-yahoo" href="${yahoo.link}" target="_blank" rel="noopener">Yahoo!で読む</a>` : ""}
    </div>
  `;
  return article;
}

// 1/2記事: RSSタイトルそのまま(Haiku要約なし、追加コストなし) + ソースタグ + 元記事リンク
function renderUnmatchedCard(item) {
  const isNhk = item.source === "NHK";
  const tagClass = isNhk ? "source-tag-nhk" : "source-tag-yahoo";
  const linkClass = isNhk ? "source-nhk" : "source-yahoo";
  const linkLabel = isNhk ? "NHKで読む" : "Yahoo!で読む";

  const article = document.createElement("article");
  article.className = "news-card";
  article.innerHTML = `
    <div class="card-header">
      <span class="source-tag ${tagClass}">${isNhk ? "NHK" : "Yahoo"}</span>
    </div>
    <h3 class="headline">${escapeHtml(item.title)}</h3>
    <div class="source-links">
      <a class="source-link ${linkClass}" href="${item.link}" target="_blank" rel="noopener">${linkLabel}</a>
    </div>
  `;
  return article;
}

function renderList(containerEl, items, renderFn, emptyMessage) {
  containerEl.innerHTML = "";
  if (items.length === 0) {
    containerEl.innerHTML = `<p class="empty">${emptyMessage}</p>`;
    return;
  }
  for (const item of items) {
    containerEl.appendChild(renderFn(item));
  }
}

function setLoading(containerEls) {
  for (const el of containerEls) {
    el.innerHTML = `<p class="loading">読み込み中…</p>`;
  }
}

function showError(containerEls, message) {
  for (const el of containerEls) {
    el.innerHTML = `<p class="error">データの読み込みに失敗しました: ${escapeHtml(message)}</p>`;
  }
}

async function loadDate(date) {
  const matchedListEl = document.getElementById("matched-list");
  const nhkOnlyListEl = document.getElementById("nhk-only-list");
  const yahooOnlyListEl = document.getElementById("yahoo-only-list");
  const sections = [matchedListEl, nhkOnlyListEl, yahooOnlyListEl];

  setLoading(sections);

  let eventsData;
  let summariesData;
  try {
    [eventsData, summariesData] = await Promise.all([
      fetchJSON(`data/${date}.events.json`),
      fetchJSON(`data/${date}.summaries.json`),
    ]);
  } catch (err) {
    showError(sections, err.message);
    return;
  }

  const eventsById = Object.fromEntries(eventsData.events.map((e) => [e.event_id, e]));
  const matchedItems = summariesData.summaries
    .map((summary) => ({ summary, event: eventsById[summary.event_id] }))
    .filter(({ event }) => event);

  renderList(
    matchedListEl,
    matchedItems,
    ({ summary, event }) => renderMatchedCard(summary, event),
    "この日は両ソースが共通して報じたニュースがありませんでした。"
  );

  const nhkOnly = eventsData.unmatched.filter((a) => a.source === "NHK");
  const yahooOnly = eventsData.unmatched.filter((a) => a.source === "Yahoo!ニュース");

  renderList(nhkOnlyListEl, nhkOnly, renderUnmatchedCard, "この日はNHK単独の記事がありませんでした。");
  renderList(yahooOnlyListEl, yahooOnly, renderUnmatchedCard, "この日はYahoo!単独の記事がありませんでした。");
}

function setupDatePicker(dates) {
  const select = document.getElementById("date-select");
  // 新しい日付が上に来るよう降順で並べる
  const sorted = [...dates].sort((a, b) => (a < b ? 1 : -1));
  select.innerHTML = sorted
    .map((d) => `<option value="${d}">${formatDateLabel(d)}</option>`)
    .join("");

  select.addEventListener("change", () => loadDate(select.value));
  return select;
}

async function main() {
  let manifest;
  try {
    manifest = await fetchJSON("data/index.json");
  } catch (err) {
    showError(
      [document.getElementById("matched-list"), document.getElementById("nhk-only-list"), document.getElementById("yahoo-only-list")],
      err.message
    );
    return;
  }

  const dates = manifest.dates;
  const today = todayInJst();
  const defaultDate = dates.includes(today) ? today : dates[dates.length - 1];

  const select = setupDatePicker(dates);
  select.value = defaultDate;

  await loadDate(defaultDate);
}

main();
