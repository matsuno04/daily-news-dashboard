// ステップ5: オンデマンドAI解説機能(Cloudflare Worker)
//
// クライアント(daily-news-dashboard, GitHub Pages)から記事のURL・見出しを受け取り、
// このWorkerが記事ページを取得してHaikuに解説させる。
// ANTHROPIC_API_KEYはWorkerのSecretとして保持し、クライアントには一切渡さない。
//
// daily-news-digest/pipeline/summarize_events.py で確認済みの知見を流用している:
// - NHKの記事ページは素のUser-Agentだけだと403を返すため、ブラウザ相応のヘッダーを付ける
// - Yahoo!ニュースはデータセンターIPからのアクセスに「アクセスが集中」等の簡易ページを
//   返すことがあるため、既知のフレーズを検知して取得失敗として扱う

const ALLOWED_ORIGIN = "https://matsuno04.github.io";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_BODY_CHARS = 4000;

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

async function fetchArticleExcerpt(url) {
  const resp = await fetch(url, { headers: PAGE_HEADERS });
  if (!resp.ok) {
    throw new Error(`記事ページの取得に失敗しました (HTTP ${resp.status})`);
  }
  const html = await resp.text();
  const text = stripHtml(html);

  if (BLOCKED_PAGE_MARKERS.some((m) => text.includes(m))) {
    throw new Error("記事ページが一時的にアクセス制限されている可能性があります。時間をおいて再度お試しください。");
  }
  if (!text) {
    throw new Error("記事本文を抽出できませんでした。");
  }
  return text.slice(0, MAX_BODY_CHARS);
}

async function explainWithHaiku(apiKey, title, excerpt) {
  const prompt = `以下はニュース記事のページから抽出したテキストです(ナビゲーションや広告、関連リンクなどのノイズが混ざっている場合があります)。ノイズは無視し、記事の実際の内容について、背景や意味合いも含めて分かりやすく解説してください。

見出し: ${title}

本文(抽出):
${excerpt}

# 指示
- 200〜400文字程度で、要点だけでなく背景・意味合いも含めて解説する
- この解説は「かみ砕いて説明する」ことが目的です。記事に書かれていない一般的な知識(関連する制度・過去の経緯・専門用語の意味など)で補って構いません。読者がニュースの意味や背景を理解しやすくすることを優先してください
- 説明文以外(前置きや「以下解説します」等)は書かず、解説本文のみを出力する`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Haiku呼び出しに失敗しました (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.content[0].text.trim();
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

    const { url, title } = body;
    if (!url || typeof url !== "string") {
      return jsonResponse({ error: "url が指定されていません" }, 400);
    }

    try {
      const excerpt = await fetchArticleExcerpt(url);
      const explanation = await explainWithHaiku(env.ANTHROPIC_API_KEY, title || "", excerpt);
      return jsonResponse({ explanation });
    } catch (err) {
      return jsonResponse({ error: err.message || "解説の生成に失敗しました" }, 502);
    }
  },
};
