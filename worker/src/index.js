// ステップ5: オンデマンドAI解説機能(Cloudflare Worker)
//
// クライアント(daily-news-dashboard, GitHub Pages)から記事のURL・見出しを受け取り、
// このWorkerが記事ページを取得してSonnetに解説させる。
//
// 解説は「記事の焼き直し」ではなく「記事に書かれていない基礎知識・経緯・構図」を補うのが目的。
// 読者はカードの要約を既に読んでいるので、要約もプロンプトに渡して繰り返さないようにする。
// モデルは2026-09-27の比較(政治・国際の3記事)で決めた:
// - Haiku: 構成は良いが、知らない最近の経緯を作り話で埋めた(2026年の米中会談を「就任後の初期接触」等)
// - Sonnet 5 + Web検索: 最も詳しいが1回$0.10〜0.23・最長4分。軽い検索は古い記事の日付を取り違えた
// - Sonnet 5(検索なし): 1回約$0.01・約10秒。基礎知識と構図が的確で、知らない最近の事実は断定しない
// ANTHROPIC_API_KEYはWorkerのSecretとして保持し、クライアントには一切渡さない。
//
// daily-news-digest/pipeline/summarize_events.py で確認済みの知見を流用している:
// - NHKの記事ページは素のUser-Agentだけだと403を返すため、ブラウザ相応のヘッダーを付ける
// - Yahoo!ニュースはデータセンターIPからのアクセスに「アクセスが集中」等の簡易ページを
//   返すことがあるため、既知のフレーズを検知して取得失敗として扱う

const ALLOWED_ORIGIN = "https://matsuno04.github.io";
const MODEL = "claude-sonnet-5";
const MAX_BODY_CHARS = 3000;

// Yahoo!のRSSリンク(pickupページ)は見出し+リード1文しか無いので、「記事全文を読む」の
// リンク先まで辿る。pickupには/articles/へのリンクが関連記事含め十数個あるため、
// 必ずこのアンカーに限定する(daily-news-digest/pipeline/summarize_events.pyと同じ方式)。
const YAHOO_FULL_ARTICLE_RE =
  /<a\s[^>]*href="(https:\/\/news\.yahoo\.co\.jp\/articles\/[0-9a-f]+)"[^>]*>記事全文を読む<\/a>/;
// Yahoo!記事ページの本文段落。これ以外(関連記事・ランキング等)はノイズなので使わない
const YAHOO_BODY_RE = /<p\b[^>]*class="[^"]*\bhighLightSearchTarget\b[^"]*"[^>]*>([\s\S]*?)<\/p>/g;

const PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  "Referer": "https://www.google.com/",
};

const BLOCKED_PAGE_MARKERS = [
  "アクセスが集中",
  "アクセス集中のため",
  "JavaScriptの設定が無効",
  "JavaScriptを有効にする必要",
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function stripHtml(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  // 主要なHTMLエンティティのみ変換する簡易処理(完全なデコードは行わない)
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.replace(/\s+/g, " ").trim();
}

async function fetchHtml(url) {
  const resp = await fetch(url, { headers: PAGE_HEADERS });
  if (!resp.ok) {
    throw new Error(`記事ページの取得に失敗しました (HTTP ${resp.status})`);
  }
  return resp.text();
}

function extractYahooBody(html) {
  const paragraphs = [];
  for (const m of html.matchAll(YAHOO_BODY_RE)) {
    // 本文中に埋め込まれた「【写真特集】…」等の関連リンクはリンク文字列ごと除く
    const t = stripHtml(m[1].replace(/<a\b[\s\S]*?<\/a>/gi, " "));
    if (t) paragraphs.push(t);
  }
  return paragraphs.join("\n");
}

async function fetchArticleExcerpt(url) {
  let html = await fetchHtml(url);
  if (url.includes("news.yahoo.co.jp/pickup/")) {
    const m = html.match(YAHOO_FULL_ARTICLE_RE);
    if (m) {
      try {
        html = await fetchHtml(m[1]);
      } catch {
        // 全文ページが取れなければpickupページの内容で続行する
      }
    }
  }
  const text = extractYahooBody(html) || stripHtml(html);

  if (BLOCKED_PAGE_MARKERS.some((m) => text.includes(m))) {
    throw new Error("記事ページが一時的にアクセス制限されている可能性があります。時間をおいて再度お試しください。");
  }
  if (!text) {
    throw new Error("記事本文を抽出できませんでした。");
  }
  return text.slice(0, MAX_BODY_CHARS);
}

function buildPrompt(title, summary, excerpt) {
  return `あなたは日本の一般読者向けに、ニュースの背景を解説する担当です。
読者はすでに下の「要約」を読んでいます。記事の内容を繰り返す必要はありません。
このニュースを理解するうえで必要なのに記事には書かれていない、基礎知識と背景を補ってください。

見出し: ${title}
要約: ${summary}

記事本文:
${excerpt}

# 書く内容(該当するものだけ。無理に全部埋めない)
【基礎知識】記事に出てくる制度・組織・用語のうち、一般読者がよく知らなそうなものの意味
【経緯】この出来事に至るまでの主な流れ(いつ・何があったか)
【構図】関係する国・政党・勢力それぞれの立場や利害
【注目点】今後の焦点、この出来事が持つ意味

# ルール
- 記事本文に書かれている事実の言い換えは書かない
- 事実と見方を区別し、確かでないことは断定しない
- あなたの知識には期限があり、最近の出来事は知らない可能性がある。最近の経緯で確かでないことは書かない
- 各見出しの下は「・」で始まる箇条書き2〜4項目。全体で600字程度まで
- 前置きや締めの言葉は書かず、上の見出し付きの解説だけを出力する`;
}

async function explainWithClaude(apiKey, title, summary, excerpt) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    // Sonnet 5は temperature 等のサンプリング指定を受け付けない(400になる)。
    // 思考は既定で有効なので、effortで深さ(=コストと待ち時間)を抑える
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: buildPrompt(title, summary, excerpt) }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`解説の生成に失敗しました (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.stop_reason === "refusal") {
    throw new Error("この記事の解説は生成できませんでした。");
  }
  // 思考ブロック等が先頭に来るので、textブロックだけをつなげる
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/\*\*/g, "") // 表示はプレーンテキストなのでMarkdownの太字記号は落とす
    .trim();
  if (!text) {
    throw new Error("解説の生成結果が空でした。");
  }
  return text;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // CORS用のOriginチェック(ブラウザ経由の呼び出しに限定する簡易的な防御。
    // curl等の非ブラウザからの直接呼び出しは防げない点に注意)
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: "許可されていないOriginです" }, 403);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "POSTメソッドのみ対応しています" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "リクエストボディがJSONとして不正です" }, 400);
    }

    const { url, title, summary } = body;
    if (!url || typeof url !== "string") {
      return jsonResponse({ error: "url が指定されていません" }, 400);
    }

    try {
      const excerpt = await fetchArticleExcerpt(url);
      const explanation = await explainWithClaude(env.ANTHROPIC_API_KEY, title || "", summary || "", excerpt);
      return jsonResponse({ explanation });
    } catch (err) {
      return jsonResponse({ error: err.message || "解説の生成に失敗しました" }, 502);
    }
  },
};
