// ステップ3: アーカイブ機能(日付セレクター)。
// data/index.json に、公開済みの日次データの日付一覧を保持する。
// daily-news-digest側からの自動連携(ステップ6)で、新しい日付が追記されていく想定。
const CATEGORY_ORDER = ["政治", "経済", "社会", "国際", "災害", "スポーツ", "エンタメ", "その他"];

// ステップ5: オンデマンドAI解説(Cloudflare Worker経由)。
// APIキーはWorker側のSecretに保持し、ここには一切含めない。
// ページ読み込み時には一切呼び出さず、各カードの「詳しく見る」ボタンが
// クリックされた時だけWorkerを呼ぶ(=Haikuが呼ばれる)。
const EXPLAIN_WORKER_URL = "https://daily-news-explain.matsuno04.workers.dev";

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

// 「詳しく見る」ボタン+解説表示欄を追加する。
// data属性はテンプレート文字列に埋め込まず、要素のプロパティとして直接設定する
// (見出しに引用符が含まれる場合のHTML属性エスケープ漏れを避けるため)。
function appendExplainSection(article, url, title) {
  const row = document.createElement("div");
  row.className = "explain-row";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "explain-btn";
  btn.textContent = "詳しく見る";
  btn.dataset.url = url;
  btn.dataset.title = title;
  row.appendChild(btn);

  const explanationEl = document.createElement("div");
  explanationEl.className = "explanation";
  explanationEl.hidden = true;

  article.appendChild(row);
  article.appendChild(explanationEl);
}

// 2/2記事: Haiku要約(headline/summary/category) + 両ソースへのリンク + 詳しく見るボタン
// (詳しく見るボタンは代表記事のリンクを使う。要約生成時と同じ記事)
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
  appendExplainSection(article, summary.representative_link, summary.representative_title);
  return article;
}

// 1/2記事: RSSタイトルそのまま(Haiku要約なし、追加コストなし)を1行リストで表示。
// セクション見出し自体(「NHKのみ」「Yahoo!のみ」)でソースは分かるため、
// 個別のタグや詳しく見るボタンは付けず、スマホで一度に多く見られる密度を優先する。
function renderUnmatchedItem(item) {
  const row = document.createElement("div");
  row.className = "brief-item";

  const link = document.createElement("a");
  link.className = "brief-link";
  link.href = item.link;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = item.title;

  row.appendChild(link);
  return row;
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

  renderList(nhkOnlyListEl, nhkOnly, renderUnmatchedItem, "この日はNHK単独の記事がありませんでした。");
  renderList(yahooOnlyListEl, yahooOnly, renderUnmatchedItem, "この日はYahoo!単独の記事がありませんでした。");
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

// 「詳しく見る」ボタンのクリックをコンテナ単位で一括処理する(イベント委任)。
// renderList()がcontainerEl.innerHTMLを日付切替のたびに差し替えるため、
// リスナーはコンテナに1回だけ登録すれば、再描画後のボタンにも効く。
async function handleExplainClick(btn) {
  const { url, title } = btn.dataset;
  const explanationEl = btn.closest(".news-card").querySelector(".explanation");

  btn.disabled = true;
  btn.textContent = "解説を生成中…";
  explanationEl.hidden = false;
  explanationEl.innerHTML = `<p class="loading">読み込み中…</p>`;

  try {
    const res = await fetch(EXPLAIN_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    explanationEl.innerHTML = `<p class="explanation-text">${escapeHtml(data.explanation)}</p>`;
    btn.remove(); // 取得済みの記事に再度リクエストされないようボタン自体を消す
  } catch (err) {
    explanationEl.innerHTML = `<p class="error">解説の取得に失敗しました: ${escapeHtml(err.message)}</p>`;
    btn.disabled = false;
    btn.textContent = "詳しく見る";
  }
}

function setupExplainDelegation(containerEl) {
  containerEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".explain-btn");
    if (btn) handleExplainClick(btn);
  });
}

async function main() {
  const matchedListEl = document.getElementById("matched-list");
  const nhkOnlyListEl = document.getElementById("nhk-only-list");
  const yahooOnlyListEl = document.getElementById("yahoo-only-list");
  // 詳しく見るボタンは2/2記事にのみ存在する(1/2記事はタイトルリンクのみ)
  setupExplainDelegation(matchedListEl);

  let manifest;
  try {
    manifest = await fetchJSON("data/index.json");
  } catch (err) {
    showError([matchedListEl, nhkOnlyListEl, yahooOnlyListEl], err.message);
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
