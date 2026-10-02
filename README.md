# daily-news-dashboard

毎日のニュースダッシュボード(GitHub Pages、PWA)。公開URL: https://matsuno04.github.io/daily-news-dashboard/

- **主要**: NHK・Yahoo!ニュースを突き合わせた毎日のニュース。データは daily-news-digest から `data/` に自動で同期される
- **JPYC**: 日本円ステーブルコインJPYCの新しい出来事。別リポジトリ matsuno04/jpyc-news-v2(卒業論文の研究データ)の `data/recent_events.json` を読み込むだけで、あちらには何も書き込まない

| ファイル | 内容 |
|---|---|
| `index.html` / `style.css` / `manifest.json` / `icons/` | 画面の骨組み・見た目・PWAの設定 |
| `app.js` | 主要のタブ(同じジャンルが続くように並べる) |
| `jpyc.js` | JPYCのタブ(既読の記録は出来事ごとに localStorage へ保存) |
| `tests.html` | JPYCタブの判定のテスト。`python -m http.server 8765` で起動し、http://localhost:8765/tests.html を開くと実行される |
| `worker/` | 「詳しく見る」の解説 Worker(Cloudflare) |

main に push すると `.github/workflows/pages.yml` で公開される。

## デザインを元に戻す(タグ `ui-classic`)

`ui-classic` は、デザインを「Overlap」に変える前の見た目の目印(2026-10-02)。
JPYCタブの既読の変更(出来事ごとのチェック式)までを含んでいる。

デザインの変更は1つのコミット(メッセージが「デザイン変更:」で始まるもの)にまとめ、ロジック(既読・データの読み込み)には手を入れていない。そのため、次のどちらかで元の見た目に戻せる。

デザイン変更のコミット(2026-10-02):
- `c383f89` アプリ名を Overlap にし、ヘッダー・タブ・カードの見た目を変更
- `73b30a0` ヘッダーを日付だけにし、タブ名を「主要」に、タブと要約の見やすさを調整
- `4bdc937` JPYCのタブにも今日の日付を表示し、要約の文字を大きく
- `40a4f03` 配色を変え、タブを一番上に、「詳しく見る」をClaude色に(JPYCの日付表示はなくなった)
- `08c61c6` NHK/Yahoo!のボタンをなくして見出しからYahoo!を開くようにし、「詳しく見る」を「解説」の開閉ボタンに

### 方法1: デザイン変更のコミットを打ち消す(勧める)

その後に入ったロジックの変更は残したまま、見た目だけを戻せる。

```bash
git log --oneline --grep "デザイン変更:"   # 打ち消すコミットを確かめる
git revert 08c61c6 40a4f03 4bdc937 73b30a0 c383f89  # 新しいほうから順に打ち消す
git push                                  # 数分で公開される
```

後のコミットで同じ箇所を直していて衝突した場合は、方法2を使う。

### 方法2: 見た目のファイルをタグの時点に戻す

```bash
git checkout ui-classic -- index.html style.css manifest.json
git diff --stat ui-classic -- app.js jpyc.js  # 画面を作る部分(描画)に違いがあるか確認する
git commit -m "見た目を ui-classic に戻す"
git push
```

`app.js` / `jpyc.js` は描画とロジックが同じファイルにあるため、丸ごと戻すと後のロジックの変更まで消える。違いがある場合は、描画の関数(`render…`)だけを手で戻す。

### タグの時点をそのまま見るだけなら

```bash
git switch --detach ui-classic
python -m http.server 8765   # http://localhost:8765/ で当時の画面を確認できる
git switch main              # 確認が終わったら戻る
```
