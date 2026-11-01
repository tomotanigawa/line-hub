# line-hub — クライアント連絡の集約と振り分け

LINE・Slack・Gmail・電話でばらばらに届く案件や相談を Slack に集め、
MulmoTerminal のエージェントが中身を読んで、絵コンテ／返信文／予定・Todo に振り分けて作業する。

```
LINEグループ ─(Bot)→ Worker ─┐
クライアントのSlack ───────────┼→ Slack の監視チャンネル
電話メモ（自分で書く）──→ #受信箱 ┘        │ 2分ごと（Mac の launchd）
                                         ▼
Gmail ─(9:05/13:05/17:05)──→ hub/poller.mjs ─→ MulmoTerminal
                                                 │
                                         振り分け役（agents/router.md）
                                    ┌───────────┼───────────┐
                              絵コンテ          返信文         予定・Todo
                           storyboard.md      reply.md      schedule.md
                                    └──── 結果は #ai-desk のスレッドに ────┘
```

- **個人LINEのグループも取り込める。** 個人のトークは API で読めないので、LINE公式アカウントの Bot をグループに招待する。
  先方はいつものLINEのままでよい。Bot は受け取るだけで送らないので、公式アカウントは無料プランで足りる
- エージェントは MulmoTerminal（Claude Code）で動く。API料金はかからない（契約の利用枠を使う）。中継の Cloudflare Worker も無料枠で足りる
- **先方には何も送らない。** 返信案は #ai-desk に置くだけ（Gmail のときは下書きメールも）。送るのはオーナー本人
- 予定・Todo は #ai-desk に流すだけでなく、MulmoClaude のコレクション「仕事のやること」に1件ずつ残る。
  期限切れ・先方待ちがカンバンやカレンダーで見え、優先度「高」は期限の前日にベル通知
- 先方が連投している間は待ち、3分静かになってから1回だけ振り分ける
- オーナー本人の発言だけのときはエージェントを起こさない
- Mac がスリープ中や MulmoTerminal が閉じている間に来たものは、次に開いたときにまとめて処理する
- **返し忘れアラート**: 先方の連絡から `alertMinutes`（45分）たってもオーナーが何も書いていなければ、
  #ai-desk にメンション付きで知らせる（スマホに通知が届く）。LINEで直接返した分も転送されるので返信済みと数える
- LINE の写真・動画・ファイルは Slack に上がり、Mac にも控えが残る
- 起動に3回失敗した束は #ai-desk に「直接見てください」と出して先へ進む（同じ失敗を繰り返さない）

> **個人で作って自分の仕事で使っているものを、そのまま公開しています。** 質問や不具合報告への対応・サポートはしません。
> 使うときは自分の環境と責任で、中身を読んでから動かしてください（MIT ライセンス）。

## 先方に送らないための仕組み

指示文で「送らない」と伝えるだけでなく、仕組みでも止めている。

- エージェントはこのフォルダで動き、`.claude/settings.json` で次を使えなくしている:
  Gmail の送信・返信・転送、Slack コネクタからの投稿、Google カレンダーへの登録・変更（招待が先方に届くため）、
  `~/.credentials` の読み取り、`curl` / `wget`
- `hub/slack.mjs` は受付チャンネル（#ai-desk）にしか投稿できない
- LINE の Worker は受け取って Slack に転送するだけで、LINE に送る処理を持たない

ただし完全な隔離（サンドボックス）ではない。LINE やメールに「〜して」と書かれた文をエージェントが読む以上、
新しく別のツールをつないだときは、送信できるものを `.claude/settings.json` の `deny` に足すこと。

## 相手への配慮

- **LINEグループに Bot を入れる前に、グループの皆さんに一言伝える。** Bot はメンバー一覧に見え、発言は Slack に転送される。
  例:「やりとりの記録用に、私の記録係のアカウントをこのグループに入れさせてください。皆さんへの送信は一切しません」
- 届いたメッセージは Slack（と自分の Mac）に保存される。取引先との契約や社内規程で外部サービスへの保存が禁じられていないか確かめる

## 必要なもの

- Mac と Node.js 22 以降
- [MulmoTerminal](https://github.com/receptron/mulmoterminal)（起動中であること。`http://127.0.0.1:34567` でエージェントを起動する）
- 予定・Todo を残すなら [MulmoClaude](https://github.com/receptron/mulmoclaude)
- Gmail・Google カレンダーを使うなら、Claude にそれぞれのコネクタをつないでおく
- Slack ワークスペース（無料プランで動く）、Cloudflare アカウント（無料）、LINE公式アカウント（無料）

## ファイル

| 場所 | 役割 |
|---|---|
| `src/` | Cloudflare Worker。LINE → Slack の転送だけ |
| `hub/poller.mjs` | Slack の見張り役。新着があれば振り分け役を起動 |
| `hub/spawn.mjs` | 振り分け役が専門エージェントを起動するときに使う |
| `hub/todo.mjs` | 予定・Todo エージェントが MulmoClaude のコレクション「仕事のやること」（`~/mulmoclaude/data/shigoto-todo/items/`）に登録・追記するときに使う |
| `hub/slack.mjs` | エージェントが受付ワークスペースに投稿・読み取りするときに使う（アプリのトークンで動くので、Claude の Slack 接続先に左右されない） |
| `hub/savekey.sh` | クリップボードの鍵を `~/.credentials/` に保存する（鍵を画面やチャットに出さないため） |
| `hub/config.json` | 監視するチャンネル・受付チャンネル・メール確認時刻（`config.example.json` を写して作る） |
| `hub/files/<取引先>/<年-月>/` | LINE・Slack で届いた写真・動画・資料の控え（本人の投稿も含む）。80MBを超える動画はLINEで見る |
| `agents/*.md` | 各エージェントへの指示文。口調や手順を変えたいときはここを書き換える |
| `agents/clients.md` | 取引先ごとの決めごとと署名（`clients.example.md` を写して作る） |
| `mulmoclaude/shigoto-todo/` | MulmoClaude のコレクション「仕事のやること」の定義 |

`hub/config.json`・`hub/state.json`・`hub/files/`・`hub/poller.log`・`agents/clients.md` は Git に入らない。

## 最初の設定（1回だけ）

### 1. Slack

0. **受付専用のワークスペースを新しく作る**（無料プランで足りる。https://slack.com/get-started#/createnew ）。
   先方を招待しているワークスペースには作らない（#ai-desk の返信案が見えてしまう）
1. チャンネルを2つ作る: `#ai-desk`（エージェントの報告先）と `#受信箱`（電話メモ・手動転送）
2. https://api.slack.com/apps → Create New App → From a manifest → `hub/slack-app-manifest.yaml` の中身を貼る → Install to Workspace
3. **Bot User OAuth Token (xoxb-…)** をコピーして `sh hub/savekey.sh slack_hub_token`
   （`~/.credentials/slack_hub_token.txt` に保存される）
4. 監視したいチャンネル（クライアントとのチャンネル・LINE転送先・#受信箱・#ai-desk）で `/invite @アプリ名`
5. チャンネル名を右クリック → リンクをコピー。末尾の `C0…` がチャンネルID。
   自分のメンバーID（`U0…`）は Slack のプロフィール → ︙ → メンバーIDをコピー

### 2. hub の設定

```sh
cd line-hub
cp hub/config.example.json hub/config.json   # チャンネルIDと自分のIDを書き換える
cp agents/clients.example.md agents/clients.md
node hub/poller.mjs --dry-run                # 何を起動するかだけ表示（起動はしない）
```

動きが良さそうなら2分ごとに回す（`__ROOT__` をこのフォルダの場所に置き換えて登録する）:

```sh
sed "s|__ROOT__|$PWD|g" hub/clienthub.plist > ~/Library/LaunchAgents/local.clienthub.plist
launchctl load ~/Library/LaunchAgents/local.clienthub.plist
```

Node を Homebrew 以外で入れているときは、plist の `/opt/homebrew/bin/node` を `which node` の結果に直す。

Mac がスリープすると止まるので、システム設定 → バッテリー（または省エネルギー）→
「電源アダプタ接続時はディスプレイがオフのときに自動でスリープさせない」をオンにしておく。

止めるときは `launchctl unload ~/Library/LaunchAgents/local.clienthub.plist`。記録は `hub/poller.log`。

### 3. MulmoTerminal にこのフォルダを登録する

エージェントはこのフォルダで動く（`.claude/settings.json` の送信停止を効かせるため）。
MulmoTerminal で一度このフォルダを開くか、次を実行して登録する。登録していないと起動を断られる。

```sh
curl -s -X POST http://127.0.0.1:34567/api/config/cwd-presets/record \
  -H 'content-type: application/json' -d "{\"path\":\"$PWD\"}"
```

### 4. MulmoClaude（予定・Todo を残すとき）

```sh
mkdir -p ~/mulmoclaude/data/skills/shigoto-todo ~/mulmoclaude/.claude/skills/shigoto-todo ~/mulmoclaude/data/shigoto-todo/items
cp mulmoclaude/shigoto-todo/* ~/mulmoclaude/data/skills/shigoto-todo/
cp mulmoclaude/shigoto-todo/* ~/mulmoclaude/.claude/skills/shigoto-todo/
```

MulmoClaude の `/collections/shigoto-todo` に「仕事のやること」が出れば完了。

### 5. LINE（LINEグループも取り込むとき）

1. https://developers.line.biz/console/ で **Messaging API チャネル** を作る（名前がグループで見える）
2. LINE Official Account Manager → アカウント設定 → **グループ・複数人チャットへの参加を許可** をオン
3. 応答設定 → 応答メッセージ オフ / あいさつメッセージ オフ / Webhook オン
4. **チャネルアクセストークン（長期）** と **チャネルシークレット** を控える
5. デプロイ:

```sh
npm install
npx wrangler login
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put SLACK_BOT_TOKEN      # 上の xoxb- と同じ
# wrangler.toml の SLACK_INBOX_CHANNEL に #受信箱 のIDを入れてから
npm run deploy
```

表示された `https://line-hub.<名前>.workers.dev/webhook` を LINE の Webhook URL に貼り「検証」。

## クライアントを1社足す

- **Slack のクライアント**: そのチャンネルに `/invite @アプリ名` → `hub/config.json` の `channels` に1行
- **LINE のクライアント**: Slack に転送先チャンネルを作る → グループに一言伝えてから Bot を招待 →
  #受信箱に groupId が届く → `wrangler.toml` の `GROUPS` に1行足して `npm run deploy` →
  `hub/config.json` の `channels` にそのチャンネルを `"source": "line"` で1行
- 先方ごとの決めごと（呼び方・表記・専用の手順）があれば `agents/clients.md` に社名の見出しで足す

```toml
GROUPS = '''
{
  "C1234...": { "name": "B社 撮影", "channel": "C0ABC..." },
  "C5678...": { "name": "B社 EC運用", "channel": "C0ABC..." }
}
'''
```

1社が複数のLINEグループを持つときは、Slack のチャンネルは社名1つ（`line-B社`）にまとめ、
`name` にグループを見分けられる名前を付ける。転送されたメッセージの頭に `[B社 撮影]` のように付き、
返信案も「どのグループに返すか」つきで出る。

## 電話のとき

切ったあと #受信箱 に一言書く（音声入力でよい）。例: 「電話 A社 ○○さん 来週の撮影、火曜午後に変更したい」
→ 振り分け役が同じように予定・返信に回す。

## 変えられるところ

- 待ち時間 … `hub/config.json` の `quietMinutes`
- 返し忘れアラートまでの分数 … `hub/config.json` の `alertMinutes`
- メール確認の時刻 … `hub/config.json` の `mailCheckTimes`（空にするとメール確認はしない）
- Mac の空き容量アラート（GB）… `hub/config.json` の `diskAlertGB`（既定100。下回ると #ai-desk に1回知らせる）
- 返信の口調 … `agents/reply.md`
- 絵コンテの形 … `agents/storyboard.md`（先方専用の手順は `agents/clients.md` の「絵コンテの手順」）
- 振り分けの基準・仕事の種類 … `agents/router.md`
