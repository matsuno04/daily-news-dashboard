// ステップ2: 1/2記事(NHK単独・Yahoo単独)をソース別セクションで表示する。
// 日付は今のところ固定。アーカイブ機能(日付セレクター)実装時に動的化する。
//
// 2026-08-05 を暫定の表示日にしている。理由: daily-news-digest側の自動実行
// (収集7:30〜21:30・突合/要約21:45 JST)はまだ当日分が生成されていないため、
// 実データでHaiku要約まで完了している最初の日である2026-08-05を使う。
const DISPLAY_DATE = "2026-08-05";

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

function showError(containerEls, message) {
  for (const el of containerEls) {
    el.innerHTML = `<p class="error">データの読み込みに失敗しました: ${escapeHtml(message)}</p>`;
  }
}

async function main(date) {
  const matchedListEl = document.getElementById("matched-list");
  const nhkOnlyListEl = document.getElementById("nhk-only-list");
  const yahooOnlyListEl = document.getElementById("yahoo-only-list");

  let eventsData;
  let summariesData;
  try {
    [eventsData, summariesData] = await Promise.all([
      fetchJSON(`data/${date}.events.json`),
      fetchJSON(`data/${date}.summaries.json`),
    ]);
  } catch (err) {
    showError([matchedListEl, nhkOnlyListEl, yahooOnlyListEl], err.message);
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

main(DISPLAY_DATE);
