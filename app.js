// ステップ1: 今日分の2/2記事(両ソースが報じたイベント)のみを静的に表示する。
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

async function loadMatchedSection(date) {
  const listEl = document.getElementById("matched-list");
  try {
    const [eventsData, summariesData] = await Promise.all([
      fetchJSON(`data/${date}.events.json`),
      fetchJSON(`data/${date}.summaries.json`),
    ]);

    const eventsById = Object.fromEntries(eventsData.events.map((e) => [e.event_id, e]));

    listEl.innerHTML = "";
    if (summariesData.summaries.length === 0) {
      listEl.innerHTML = `<p class="empty">この日は両ソースが共通して報じたニュースがありませんでした。</p>`;
      return;
    }

    for (const summary of summariesData.summaries) {
      const event = eventsById[summary.event_id];
      if (!event) continue;
      listEl.appendChild(renderMatchedCard(summary, event));
    }
  } catch (err) {
    listEl.innerHTML = `<p class="error">データの読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
  }
}

loadMatchedSection(DISPLAY_DATE);
