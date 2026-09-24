# OMP Cloud IDEの設計思想・構成・IaC・外部モジュール

最終更新: 2026-09-24
対象: `code-server/`配下の個人用OMP Cloud IDE実装
基準コミット: `6c46d65`以降

この文書は、システムの目的、設計原則、AWS構成、データフロー、状態管理、セキュリティ境界、IaCと外部モジュールをまとめたアーキテクチャ資料である。利用手順ではなく、「なぜこの構成なのか」と「どこが責任境界なのか」を説明する。

## 1. 目的とスコープ

### 1.1 目的

必要なときだけ起動できる個人用Cloud IDEをAWS Lambda MicroVM上に構築し、ブラウザからcode-serverを利用する。IDE内ではOMPを中心に、Claude、OpenAI Codex、OpenCode Go、GitHub、Node/Bun/Pythonなどを使って開発できるようにする。

### 1.2 主な要件

- MicroVMと主要データプレーンは東京リージョンに置く。
- 常駐EC2を必要としない。
- CloudFront URLを知っているだけではMicroVMを起動できない。
- 通常GitHubへOAuthで接続し、PATを使わない。
- OMP/GitHubの認証状態はMicroVM終了後も引き継ぐ。
- code-serverとOMP、主要CLI、headless browserをImageへ事前導入する。
- 作業終了時に明示Suspendできる。
- Cookieを失っても、生存している既存MicroVMへ再接続できる。
- IaCはAWS CDK TypeScript、デプロイエンジンはOSSの`cdkd`を使う。

### 1.3 非目標

- 複数ユーザー向けSaaS
- 24時間常駐する永続VM
- MicroVMローカルworkspaceの恒久保存
- GitHub Enterprise固有対応
- PAT配布
- 複数MicroVMによる同時OAuth refreshの完全な整合性保証
- OMP Computer toolによるGUI desktop操作

## 2. 設計原則

### 2.1 常駐物を最小化する

常駐Auth BrokerやEC2を置かず、CloudFront、Lambda@Edge、DynamoDB、S3、Secrets Managerなどのmanaged/serverless要素で構成する。computeが必要なときだけMicroVMを起動する。

### 2.2 認証・セッション・作業データを分離する

| 層 | 保持対象 | 保存先 |
| --- | --- | --- |
| 利用者認証 | Cloud IDEを利用できるか | 署名付きbrowser Cookie、Secrets Manager |
| 接続セッション | どのMicroVMへ接続するか | browser Cookie、DynamoDB |
| OMP/GitHub認証 | provider OAuth/GitHub OAuth | MicroVMローカル + KMS暗号化S3 |
| 作業成果 | source code、変更 | GitHub repository |
| 一時実行状態 | RAM、ローカルdisk、process | 生存中のMicroVM |

### 2.3 ブラウザへ内部tokenを渡さない

MicroVM endpointと`X-aws-proxy-auth`はLambda@Edgeが管理し、ブラウザはCloudFrontだけを見る。tokenはport 8080だけを許可し、短い期限で更新する。

### 2.4 Imageへ再現性を高めた実行環境を含める

起動後のdownloadを減らし、主要なtop-level ARM64ツールのversionを固定してImageへ入れる。MicroVM起動後は認証状態の復元とproject固有セットアップだけを行う。ただし`dnf` package、VS Code extension、base image、transitive dependencyまで完全に固定したImageではない。

### 2.5 破棄されるcomputeを前提にする

MicroVMはRUNNINGとSUSPENDEDを合わせて最大8時間であり、workspaceの恒久保存先ではない。認証だけを外部化し、成果物はGitを正とする。

### 2.6 状態変更は明示操作にする

ログイン画面表示、セッション一覧表示、通常GETでは新規MicroVMを起動しない。新規作成、Suspend、ResumeはPOSTで明示する。

## 3. システムコンテキスト

```text
┌─────────────────────────────────────────────────────────────────────┐
│ User device                                                         │
│                                                                     │
│  Browser / code-server UI                                           │
│      ├─ access cookie                                               │
│      └─ mvm-session cookie                                          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS / WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ us-east-1: Edge control plane                                       │
│                                                                     │
│  CloudFront                                                         │
│    ├─ Lambda@Edge origin-request                                    │
│    │    ├─ login/authentication                                     │
│    │    ├─ session chooser                                          │
│    │    ├─ Run/Get/Suspend/Resume MicroVM                           │
│    │    └─ origin/token injection                                   │
│    ├─ Lambda@Edge origin-response                                   │
│    │    └─ transient 502/504 recovery                               │
│    ├─ DynamoDB: session metadata + proxy token                      │
│    └─ Secrets Manager: access password                              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS + X-aws-proxy-auth
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ap-northeast-1: IDE data plane                                      │
│                                                                     │
│  AWS managed Lambda MicroVM endpoint                                │
│       │ port 8080 only                                              │
│       ▼                                                             │
│  Lambda MicroVM (ARM64 / AL2023 / UID 1000)                         │
│    ├─ code-server :8080                                             │
│    ├─ lifecycle hook server :9000                                   │
│    ├─ OMP + headless Chromium                                       │
│    ├─ git / gh / Node / Bun / Python / uv / AWS CLI / LSP          │
│    └─ /home/vscode/workspace (ephemeral)                            │
│             │                                                       │
│             ├─ S3 + KMS: OMP/GitHub auth state                     │
│             └─ CloudWatch Logs                                      │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                       GitHub.com repositories
```

## 4. AWSリソース構成

### 4.1 `OmpCloudIdeMicrovmStack`（`ap-northeast-1`）

| リソース | 役割 | 主要設定 | 削除方針 |
| --- | --- | --- | --- |
| KMS Key | 認証状態暗号化 | rotation有効 | RETAIN |
| S3 Bucket | OMP/GitHub認証状態 | KMS、Versioning、SSL必須、Public Block | RETAIN |
| CloudWatch Log Group | Image build/runtime log | 1週間保持、削除保護 | RETAIN |
| S3 Asset | Image build context | `artifact/base-image` | cdkd/CDK管理 |
| Build Role | MicroVM Image build | build artifact read、log write | Delete |
| Execution Role | MicroVM runtime | S3/bucket、KMS、logに限定 | Delete |
| `AWS::Lambda::MicrovmImage` | 実行Image | ARM64、AL2023、hook、2GiB minimum | Delete |

MicroVM Imageは現時点でL2 Constructが十分でないため、`cdk.CfnResource`で`AWS::Lambda::MicrovmImage`を定義している。

### 4.2 `OmpCloudIdeEdgeStack`（`us-east-1`）

| リソース | 役割 | 主要設定 | 削除方針 |
| --- | --- | --- | --- |
| Secrets Manager Secret | Cloud IDEアクセスパスワード | 32文字、記号除外 | Delete |
| DynamoDB Table | セッション状態 | partition key `sessionId`、PAY_PER_REQUEST、TTL | Delete |
| Edge IAM Role | origin-request処理 | MicroVM API、DDB、Secret、PassRole、Logs | Delete |
| origin-request Lambda | 認証・セッション・proxy | Node.js 24、256MiB、30秒 | FunctionはDelete、公開VersionはRETAIN |
| origin-response Lambda | 一時障害復旧 | Node.js 24、128MiB、5秒 | FunctionはDelete、公開VersionはRETAIN |
| Response Headers Policy | security headers | CSP、HSTS、nosniff等 | Delete |
| CloudFront Distribution | browser入口 | cache無効、ALLOW_ALL、HTTP/2/3 | Delete |

保持方針は非対称である。destroyやLogical ID置換でDynamoDB/Secretが消えると、生存MicroVMとの関連付けや既存access Cookieを失う一方、S3/KMS/旧Lambda Versionは残る。destroy前のcleanup順序と、DDB PITR/Secret RETAINの要否を別途決める必要がある。

### 4.3 2スタックに分ける理由

Lambda@Edgeは`us-east-1`へ置く必要がある一方、MicroVMは利用者に近い東京へ置きたい。Cross-region参照を複雑にしないため、安定した命名規則からImage ARN、Role ARN、Bucket名などを組み立てる。

Edge StackはMicroVM Stackへstack dependencyを持ち、Image側を先にデプロイする。

## 5. ネットワークとリクエスト経路

### 5.1 通常リクエスト

```text
Browser
  │ GET /?folder=/home/vscode/workspace
  ▼
CloudFront
  │ origin-request event
  ▼
Lambda@Edge
  ├─ access cookieを検証
  ├─ mvm-sessionでDynamoDB GetItem
  ├─ token期限を確認・必要なら更新
  ├─ originをMicroVM endpointへ変更
  ├─ Host/Originをendpointへ変更
  ├─ X-aws-proxy-authを追加
  └─ 現状はEdge専用Cookieをrequestから除去しない
  │
  ▼
AWS managed MicroVM endpoint :443
  │ tokenが許可したport 8080へ転送
  ▼
code-server :8080
```

CloudFrontの設定上は`example.com`がoriginだが、認証済み通常通信ではEdgeが上書きする。

### 5.2 code-serverのport proxy

MicroVM内アプリを`localhost:3000`などで起動した場合、browserからはcode-serverの`/proxy/3000/`を通してアクセスできる。

```text
Browser → CloudFront → MicroVM endpoint → code-server :8080
                                           └─ localhost:3000
```

3000番をMicroVM ingress tokenへ直接追加しているわけではない。外部からの入口は引き続き8080だけである。

### 5.3 WebSocket

CloudFrontはALL_VIEWER_EXCEPT_HOST_HEADERを使い、code-serverのWebSocketを含むviewer情報をoriginへ転送する。`Host`と`Origin`はEdgeでMicroVM endpointへ合わせる。

### 5.4 Network connectorと脅威モデル

MicroVMには`ALL_INGRESS`と`INTERNET_EGRESS` network connectorを渡す。ingressはAWS managed endpoint経由の通信、egressはOMP provider、GitHub、package registry、S3/AWS APIなどへの外向き通信を可能にする。

現行設計が信頼するもの:

- Cloud IDE利用者
- OMP本体とprovider SDK
- cloneして実行するrepository
- `npm`/`bun`/`pip`等のdependency install script
- Imageへ導入したVS Code extensionと外部binary

守る境界:

- AWSホストと他MicroVMからの分離
- root権限の不使用
- 広いAWSアカウント権限をExecution Roleへ与えない
- browserへMicroVM proxy tokenを渡さない

守らない境界:

- 同一MicroVM内の未信頼コードからOMP/GitHub OAuth情報を隠すこと
- 同一UID 1000内でExecution Role資格情報を分離すること
- `INTERNET_EGRESS`を使ったsecret exfiltration
- 同一CloudFront originの`/proxy/<port>/`アプリからsession制御routeを隔離すること
- code-server originへ転送されたEdge専用Cookieを同一VM内のserver-side appから隠すこと

code-serverのWorkspace Trustは無効、OMP approvalは`yolo`であるため、未知repoを安全に実行するsandboxとはみなさない。強い分離が必要ならcredential-free Image/Session、Auth Broker/別UID、egress proxy/allowlist、Workspace Trustを導入する。

## 6. 認証設計

### 6.1 ログインシーケンス

```text
Browser                    Lambda@Edge                  Secrets Manager
   │ GET /login                 │                              │
   │───────────────────────────>│                              │
   │ HTML login form            │                              │
   │<───────────────────────────│                              │
   │ POST username/password     │                              │
   │───────────────────────────>│ GetSecretValue               │
   │                            │─────────────────────────────>│
   │                            │ current password             │
   │                            │<─────────────────────────────│
   │ 303 + signed access cookie │                              │
   │<───────────────────────────│                              │
   │ GET /session/select        │                              │
```

ログイン成功だけでは`RunMicrovm`しない。

### 6.2 2種類のCookie

| Cookie | 値 | 用途 | 寿命 |
| --- | --- | --- | --- |
| `omp-cloud-ide-auth` | `expiresAt.HMAC` | 利用者認証 | 8時間 |
| `mvm-session` | random UUID | DynamoDBセッション参照 | 8時間 |

共通属性:

```text
Path=/; Secure; HttpOnly; SameSite=Strict
```

アクセスCookieのHMAC keyはSecrets Managerのパスワードで、Edge execution environment内では5分キャッシュする。パスワード値はブラウザCookieに入らない。

### 6.3 Basic認証互換

ブラウザはHTMLフォームを使うが、`Authorization: Basic`もEdgeで受け付ける。これは非ブラウザのsmoke requestなどの互換用であり、通常UIはネイティブBasicダイアログに依存しない。

### 6.4 code-server認証

code-serverは`--auth none`である。セキュリティ境界は次の二段階で構成する。

1. CloudFront/Lambda@Edgeの利用者認証
2. AWS managed MicroVM endpointの短命proxy token

MicroVM endpointを直接知っても、port 8080を許可した有効なtokenがなければ到達できない。

### 6.5 同一originに関する制約

IDE、code-server port proxy、ログイン、selector、Suspend/Resumeは同じCloudFront origin上にある。`SameSite=Strict`は外部siteからの一般的なCSRFを減らすが、`/proxy/<port>/`で動く同一originアプリからの状態変更requestは防がない。

さらにEdgeは認証後もviewer requestの`Cookie` headerから`omp-cloud-ide-auth`と`mvm-session`を除去せず、code-server originへ転送する。`HttpOnly`はbrowser JavaScriptからの読取りを防ぐ属性であり、origin serverへ届くrequest headerを隠さない。code-server proxyが内側appへCookieを引き継ぐかは実E2Eで固定すべき契約で、引き継ぐ場合はserver-side appから値を取得できる可能性がある。

現状はproxy先アプリも信頼する前提である。将来はcontrol/authを別hostnameへ分離し、状態変更Cookieをそのhostだけへ限定する。移行前でも、Edgeで検証後にEdge専用の2 Cookieだけをorigin requestから除去し、code-server自身に必要なCookieは維持する。Origin/Referer検証と再確認画面は軽減策だが、同一originコードに対する完全な境界ではない。

## 7. セッション管理設計

### 7.1 DynamoDB schema

| 属性 | 型 | 内容 |
| --- | --- | --- |
| `sessionId` | String | partition key、Cookieが参照するUUID |
| `microvmId` | String | AWS Lambda MicroVM ID |
| `endpoint` | String | AWS managed HTTPS endpoint |
| `token` | String | `X-aws-proxy-auth`値 |
| `tokenExpiry` | Number | token失効時刻、epoch milliseconds |
| `createdAt` | Number | 作成時刻、epoch milliseconds |
| `paused` | Boolean | 明示Suspendによる通信遮断状態 |
| `ttl` | Number | DynamoDB TTL、epoch seconds |

TTLはMicroVM最大時間に1時間の余裕を足して設定する。TTL削除は遅延し得るため、一覧表示ではAWS APIの状態も確認する。

`sessionId`の入力検査は現状`hex`とhyphenからなる36文字の簡易検査で、UUIDのhyphen位置、version、variantまで厳密に検証しない。値は`randomUUID()`で生成されDynamoDB照合も行うが、厳密UUID validationへ改善できる。

### 7.2 新規セッション作成

```text
POST /session/select action=new
  ↓
RunMicrovm
  ├─ Image ARN
  ├─ Execution Role ARN
  ├─ ingress/egress connector
  ├─ autoResumeEnabled=true
  ├─ idle=300秒
  ├─ suspended retention=28800秒
  └─ max duration=28800秒
  ↓
CreateMicrovmAuthToken (port 8080, 60分)
  ↓
DynamoDB PutItem
  ↓
mvm-session Cookie
  ↓
8秒後にeditorへ遷移
```

`RunMicrovm`、`CreateMicrovmAuthToken`、`PutItem`は独立したAPI呼び出しである。後半が失敗した場合のcompensationは現状なく、一覧へ載らないorphan MicroVMが残る可能性がある。

`maximumDurationInSeconds=28800`はRUNNINGとSUSPENDEDを含む総寿命である。`suspendedDurationSeconds=28800`は連続Suspend側の上限だが、起動から8時間の総寿命を延長しない。

### 7.3 既存セッション選択

`GET /session/select`はDynamoDBを任意の最大25件Scanし、各候補へ並列`GetMicrovm`を実行する。新しい25件を保証するQueryではなく、N+1 API call、30秒Edge timeout、throttle、partial failureの制約を持つ。

```text
RUNNING     → Connect
SUSPENDED   → Resume and connect
SUSPENDING  → 待機して再試行
PENDING     → 現状はConnect扱い。ready polling未実装
UNKNOWN     → 現状はConnect扱い。stateReason表示未実装
TERMINATED  → 一覧から除外または復旧不可
NotFound    → 一覧から除外
```

選択POSTではDynamoDBをconsistent readし、session IDの簡易形式とMicroVM実状態を再検証する。ただし`GetMicrovm`成功はendpoint/code-serverのreadyを保証せず、AWS側状態のeventual consistencyも考慮が必要である。

### 7.4 token更新

token寿命は60分で、残り15分未満になると`CreateMicrovmAuthToken`を呼び、DynamoDBのtoken/expiryを更新する。更新失敗時はエラー名だけをログに出し、既存tokenで処理を継続する。既存tokenが失効済みなら後段で失敗する。

分散Lambda@Edgeから条件なし`UpdateItem`を行うため、同時refreshの競合は未検証である。短命化、conditional update、single-flight相当の制御が改善候補となる。

### 7.5 一時的origin障害

HTMLナビゲーションが`502`または`504`になり、requestに`mvm-session`がある場合、origin-response LambdaはCookieを消さず`/session/select`へリダイレクトする。

CSS、JS、WebSocketなどの非HTMLレスポンスはそのまま返す。すべてのsubrequestをリダイレクトして壊すことを避けるためである。

一方、現在はpathを限定しないため、`/proxy/<port>/`のアプリ自身が返したHTML 502/504もMicroVM障害と誤認する可能性がある。専用error markerまたは対象route限定が必要である。

## 8. Suspend/Resume設計

### 8.1 なぜ制御画面をEdge側に置くか

MicroVM自身を止める操作をMicroVM内だけで完結させると、応答途中で自分自身が停止したり、code-server再接続で即Resumeしたりする。外部control planeであるLambda@EdgeからAWS APIを呼ぶ方が状態を一貫して制御できる。

code-server extensionは固定HTTPS URLの`/session/control`をエディタ内タブで開く。extension自身にAWS権限はない。

### 8.2 Suspendシーケンス

```text
User                Lambda@Edge           DynamoDB           Lambda MicroVM API
 │ POST /suspend         │                    │                      │
 │──────────────────────>│                    │                      │
 │                       │ paused=true        │                      │
 │                       │───────────────────>│                      │
 │                       │ GetMicrovm         │                      │
 │                       │──────────────────────────────────────────>│
 │                       │ SuspendMicrovm     │                      │
 │                       │──────────────────────────────────────────>│
 │ paused control page   │                    │                      │
 │<──────────────────────│                    │                      │
```

`paused=true`を先に書くため、その後のWebSocket再接続をEdgeで止められる。

### 8.3 paused中のrequest

- HTML navigation: `/session/control`へ302
- WebSocket/APIなど: `409 Conflict`と`Retry-After: 5`

### 8.4 Resumeシーケンス

```text
POST /session/resume または selectorのattach
  ↓
GetMicrovm
  ↓
SUSPENDEDならResumeMicrovm
  ↓
paused=false
  ↓
5秒refresh page
  ↓
editor
```

## 9. 認証状態永続化設計

### 9.1 永続対象

```text
s3://<auth-bucket>/personal/
├─ omp/agent.db
├─ omp/install-id
└─ github/hosts.yml
```

保存対象を認証状態に限定し、workspaceや任意のhome directory全体は保存しない。

### 9.2 lifecycle hook server

MicroVM内のPython HTTP serverがport 9000でAWS lifecycle hookを受ける。

| Hook | 処理 | timeout |
| --- | --- | --- |
| Image `ready` | code-server `/healthz`確認 | 120秒 |
| Image `validate` | code-server `/healthz`確認 | 30秒 |
| MicroVM `/run` | S3から認証状態復元 | 30秒 |
| MicroVM `/resume` | 即時200 | 10秒 |
| MicroVM `/suspend` | S3へsnapshot保存 | 45秒 |
| MicroVM `/terminate` | S3へsnapshot保存 | 45秒 |

daemonは5分間隔でも保存する。`persist-auth-state`コマンドは同じ保存処理をone-shotで呼ぶ。

現行実装は「保存・復元を試みる」best-effort方式であり、hookの成功が全ファイルのS3反映を保証しない。

- AWS CLIは1ファイルごとに最大25秒待ち、最大3ファイルを逐次処理する。理論上は`/run`の30秒や`/suspend`・`/terminate`の45秒を超え得る。
- 定期syncとhookは同じprocess-local lockを使うため、hook開始前のlock待ちもdeadlineを消費する。
- 保存側は個々の失敗をlogへ記録して続行し、hookは最終的に200、手動`persist-auth-state`は通常0を返す。呼出側だけでは部分失敗を判定できない。
- 復元側はS3 CLIのnon-zeroを「そのobjectは復元しなかった」として続行する。subprocess timeoutなどの例外時には200を返せない可能性がある。
- Edgeが`/run`へ送るpayloadは`sessionId`だが、hookは`microvmId`を参照しており、現状はどちらも保存keyや競合制御に使われていない。
- `/resume`は即時200のみで、credential、S3到達性、code-server health、periodic threadを再検証しない。

堅牢化時はhook全体のdeadline、ファイル別結果、last-success、非2xx/非zero終了、lock優先順位を設計し、制御画面とmetricへ状態を出す。

### 9.3 SQLite整合性

`agent.db`はPython SQLite backup APIで一時DBへsnapshotし、そのsnapshotをアップロードする。ほかのファイルは一時directoryへcopyして`0600`にする。

復元は一時ファイルへS3 downloadし、`0600`へ変更後に`os.replace`する。途中失敗で既存ファイルを半端に上書きしない。

### 9.4 暗号化と保持

- S3 SSE-KMS
- KMS rotation
- S3 Versioning
- noncurrent Version lifecycleは未設定
- Public Access Block
- SSL強制
- Bucket/Keyは`RETAIN`
- Execution Roleは`personal/*`のobject read/write/delete、bucket-level access、S3暗号化に必要なKMS操作を持つ

現在は変更検知なしで最大3ファイルを5分ごとに再uploadするため、総寿命8時間の1台では定期syncだけで最大約288 object versions、1日を3台で連続利用すれば約864 versions/日が増え得る。Suspend、Terminate、手動保存分はさらに加算される。hash/mtimeで未変更uploadをskipし、復旧要件に合わせてnoncurrent Versionの保持期間・世代数を定める。

Versioningは通常の上書き事故への復旧余地を作るが、Execution Roleの`DeleteObject*`による明示的なVersion削除からは保護しない。削除耐性が必要なら、削除権限の分離、Object Lock、別account backupを検討する。

## 10. MicroVM Image設計

### 10.1 ベースと実行ユーザー

- Base: `public.ecr.aws/lambda/microvms:al2023-minimal`
- Architecture: ARM64
- Minimum memory: 2048MiB
- User: `vscode`、UID/GID 1000
- Workspace: `/home/vscode/workspace`
- OMP state: `/home/vscode/.omp/agent`

### 10.2 pinしている主要コンポーネント

| コンポーネント | version |
| --- | --- |
| code-server | 4.126.0 |
| Bun | 1.3.14 |
| OMP (`@oh-my-pi/pi-coding-agent`) | 18.2.11 |
| GitHub CLI | 2.96.0 |
| AWS CLI | 2.34.45 |
| Node.js | 24.21.0 |
| uv | 0.12.18 |
| ripgrep | 15.2.0 |
| Chromium pack | 149.0.0 |
| TypeScript CLI | 7.0.2 |
| TypeScript Language Server | 6.0.0 |
| Pyright | 1.1.414 |
| Bash Language Server | 5.8.1 |
| YAML Language Server | 1.24.0 |

versionはDockerfileのbuild args/npm installで固定する。ripgrepとChromium packはSHA-256も検証する。

### 10.3 VS Code extension

- Japanese Language Pack
- Red Hat YAML
- Microsoft Python
- Microsoft Docker
- 自作`har1101.omp-cloud-ide-controls`

自作extensionはstatus barに`Suspend Cloud IDE`を表示し、HTTPSのcontrol URLだけをcode-server内タブで開く。現状の`settings.json`とextension manifestのdefaultには実Distribution URLが固定されているため、Distribution置換やstaging/prod並行環境では誤った環境を操作し得る。現在のbrowser originからの相対URL導出、または起動時のruntime injectionへ変更するのが望ましい。

### 10.4 OMP設定

Imageへ`~/.omp/agent/config.yml`として配置する。

```yaml
tools:
  approvalMode: yolo

goal:
  enabled: true
  continuationModes: [interactive]

ask:
  enabled: true

browser:
  enabled: true
  headless: true
  screenshotDir: /home/vscode/workspace/.artifacts/screenshots
```

`rm -rf *`と`git push --force*`はOMPのbash approval patternでdenyする。

### 10.5 OMP Browser

Linux arm64向けGoogle Chrome for Testingの通常配布に依存せず、Sparticuz Chromium arm64 packをImage build時に展開する。

```text
/opt/chromium/chromium
/opt/chromium/al2023/lib
/opt/chromium/fonts
```

OMPのPuppeteer browserは同一MicroVM内の`localhost`アプリへ直接アクセスできる。アプリを外部公開せずにUI E2Eを実行できる。

Image build時の`chromium --version`と設定契約はテスト済みだが、OMPから`browser.open`、操作、screenshotまで通す再現可能なdeployed E2Eはまだ未実装である。

## 11. IAM設計

### 11.1 Build Role

許可:

- Image build用S3 asset read
- 専用Log Group write

Trust:

- `lambda.amazonaws.com`
- `aws:SourceAccount`
- MicroVM Image source ARN pattern

### 11.2 Execution Role

許可:

- auth Bucketの`personal/*` object read/write/deleteとbucket-level access
- S3 SSE-KMSに必要な対象Keyのencrypt/decrypt/data-key操作
- 専用Log Group write

開発対象AWSへのAdministrator権限は持たせない。

Trust policyは`aws:SourceAccount`で対象accountへ絞る一方、Source ARNは同account・同regionの`microvm-image:*`であり、この専用Imageだけに限定してはいない。

### 11.3 Edge Role

| Action | Resource scope |
| --- | --- |
| `lambda:RunMicrovm` | 対象Image ARN |
| `lambda:CreateMicrovmAuthToken` | 対象Image ARN |
| `lambda:Get/Suspend/ResumeMicrovm` | 対象Image ARN + account-local MicroVM ARN |
| `lambda:PassNetworkConnector` | ALL_INGRESS / INTERNET_EGRESS connector |
| `iam:PassRole` | 専用Execution Role |
| DynamoDB Get/Put/Scan/Update | session table |
| Secrets Manager Get/Describe | access password Secret |
| CloudWatch Logs write | Lambda log groups |

### 11.4 Origin-response Role

ログ書き込みだけを許可する。DynamoDBやMicroVM APIは呼ばない。

## 12. Security header設計

CloudFront共通Policy:

- HSTS 365日、includeSubDomains、preload
- X-Content-Type-Options
- SAMEORIGIN
- Referrer-Policy: no-referrer
- XSS protection
- code-server互換のCSP

ログイン・session selector・control pageはLambda@Edge自身がより厳しいCSPを返す。

```text
default-src 'none'
style-src 'unsafe-inline'
form-action 'self'
base-uri 'none'
frame-ancestors 'none' または control pageのみ 'self'
```

code-serverが独自CSPを返す場合を壊さないよう、CloudFront CSPは`override: false`である。

## 13. IaC・ビルド・デプロイツール

### 13.1 主要ツール

| ツール/Module | version | 用途 |
| --- | --- | --- |
| AWS CDK CLI | 2.1142.0 | synth互換、CDK application |
| `aws-cdk-lib` | 2.270.0 | AWS resource定義 |
| `constructs` | lock上10.6.0 | Construct tree |
| `@go-to-k/cdkd` | 0.291.0 | 通常のsynth/diff/deploy/destroy |
| TypeScript | 5.9.3 | IaC source type check |
| ts-node | 10.9.2 | CDK app実行 |
| Jest | 30.4.2 | unit/IaC assertion |
| ts-jest | 29.4.11 | TypeScript test bridge |
| Biome | 2.5.1 | lint/format |

Edge bundle:

| Module | version | 用途 |
| --- | --- | --- |
| `@aws-sdk/client-lambda-microvms` | 3.1075.0 | Run/Get/Suspend/Resume/token |
| `@aws-sdk/client-dynamodb` | 3.1075.0 | session table |
| `@aws-sdk/client-secrets-manager` | 3.1075.0 | access password |

### 13.2 Imageへ取り込む主な外部成果物

| 成果物 | 取得元 | 現在の固定・検証 | 運用上の責任 |
| --- | --- | --- | --- |
| Lambda MicroVM AL2023 base | AWS Public ECR | Image ARN/version指定、digest未固定 | AWS release noteとbase更新、脆弱性確認 |
| code-server RPM | coder GitHub Releases | version固定、checksum未検証 | release署名/checksum、license、更新評価 |
| Node.js tarball | nodejs.org | version固定、checksum未検証 | SHASUM/署名検証、LTS更新 |
| Bun archive | oven-sh GitHub Releases | version固定、checksum未検証 | checksum/署名、更新評価 |
| ripgrep archive | BurntSushi GitHub Releases | versionとSHA-256固定 | version・checksum同時更新 |
| Sparticuz Chromium arm64 pack | Sparticuz GitHub Releases | versionとSHA-256固定、起動version確認 | Chromium CVE追従、pack/runtime互換性、license確認 |
| GitHub CLI archive | cli/cli GitHub Releases | version固定、checksum未検証 | checksum/署名、OAuth挙動確認 |
| AWS CLI archive | awscli.amazonaws.com | version固定、checksum未検証 | AWS署名/checksum、更新評価 |
| uv archive | astral-sh GitHub Releases | version固定、checksum未検証 | checksum/署名、更新評価 |
| OMP/LSP npm packages | npm registry | top-level version固定 | transitive dependency、license、provider仕様追従 |
| VS Code extensions | Marketplace/Open VSX経由のcode-server | extension IDのみ、version未固定 | version pin、publisher/権限/CVE確認 |

各外部成果物のlicense一覧と更新担当・更新頻度は現在リポジトリ内で一元管理していない。SBOM、license inventory、定期脆弱性scan、Renovate/Dependabot相当の更新PRを追加する余地がある。

### 13.3 npm scripts

```text
npm run build          tsc
npm run lint           biome lint .
npm test               jest
npm run synth          cdkd synth
npm run diff           cdkd diff --all
npm run deploy:dry-run cdkd deploy --all --dry-run
npm run deploy         cdkd deploy --all --full-wait
npm run destroy        cdkd destroy --all
npm run bootstrap      東京とus-east-1をcdkd bootstrap
```

`--full-wait`により、MicroVM Image buildとCloudFront反映の安定化まで待つ。

### 13.4 deployment flow

現在はCI/CDではなく、開発端末からAWS SSOで手動実行する。

```text
aws sso login --profile <aws-profile>
  ↓
npm ci
  ↓
npm run build / lint / test
  ↓
npm run diff
  ↓
npm run deploy
  ↓
実ブラウザE2E
  ↓
npm run diff（差分ゼロ確認）
  ↓
commit / push to GitHub
```

Node SDK/cdkdがprofileの古いSSO tokenを見る場合は、AWS CLIの`export-credentials`を一時環境変数として渡す。資格情報は表示・保存しない。

現在のStack名、DynamoDB table名、Secret名、IAM Role名、Image名は固定であり、同一accountへstaging/prodを並行deployできない。さらにsynthは`artifact/edge/config.json`という共有source pathへ環境値を書き込むため、同じcheckoutでの並列synthはraceになり得る。`CDK_DEFAULT_ACCOUNT`も必須なので、PR synthでは非secretな対象account IDを明示する必要がある。

GitHub Actions化する場合、`cdkd`がdeploy中に直接AWS APIを呼ぶ前提で環境別OIDC Roleを用意し、permission boundaryと対象resourceを限定する。環境suffix、生成物の一時directory化、control URLのruntime注入を先に解消する。

### 13.5 現在存在しないCI/CD要素

- `.github/workflows`
- GitHub OIDC Role
- GitHub Environments
- staging branch/environment
- prod approval
- branch protection
- required status checks
- 自動E2E

### 13.6 Logと可観測性の配置

- MicroVM Image build/runtime用Log GroupはCDKで明示し、1週間保持、削除保護、`RETAIN`である。
- source Lambda FunctionのLog GroupはCDK管理で、現在のsynthでは731日保持・`RETAIN`である。
- Lambda@Edgeの実行logはviewerに近い実行regionへ分散し得るため、東京/us-east-1の中央Log Groupだけを見ても揃わない。
- 現状はalarm、dashboard、lifecycle last-success、orphan検知、cost anomaly通知がない。

長期運用ではregion横断の調査Runbookまたはlog集約、structured log/correlation ID、主要失敗metricを追加する。

## 14. Source treeと責任分担

```text
code-server/
├─ bin/lambda-microvm.ts
│   └─ 2 Stackのcompositionとregion
├─ lib/config.ts
│   └─ naming、region、timeout、Image設定
├─ lib/lambda-microvm-stack.ts
│   └─ AWS resource、IAM、CloudFront、asset bundling
├─ artifact/
│  ├─ base-image/
│  │  ├─ Dockerfile
│  │  ├─ lifecycle.py
│  │  ├─ start-cloud-ide.sh
│  │  ├─ persist-auth-state
│  │  ├─ omp-config.yml
│  │  ├─ settings.json
│  │  ├─ extensions.txt
│  │  └─ omp-cloud-ide-controls/
│  ├─ edge/
│  │  ├─ index.js
│  │  ├─ package.json / package-lock.json
│  │  └─ config.json（synth生成、Git対象外）
│  └─ edge-response/index.js
├─ test/lambda-microvm.test.ts
├─ package.json
├─ cdk.json
└─ README.md

docs/
├─ session-management.md
├─ lessons-learned.md
├─ implementation-status-and-roadmap.md
└─ architecture-and-design.md
```

## 15. テスト戦略

### 15.1 Static/Unit

- TypeScript strict compile
- Biome recommended lint
- CDK assertions
- Edge pure helper tests
- Cookie tamper/expiry tests
- HTML escape/CSP tests
- Suspend/Resume response tests
- transient 502 regression test
- Dockerfile/config/extension契約test

### 15.2 Deployed E2E

Edgeまたはセッション機能変更後は、実CloudFrontとテスト専用MicroVMで次を確認する。

```text
login
→ selector
→ new MicroVM
→ code-server ready
→ suspend
→ selector
→ resume
→ same session / code-server ready
→ terminate only test VM
→ delete only test DDB row
```

既存MicroVMのIDを事前に保存し、cleanup対象から除外する。

この手順は実ブラウザで個別に確認済みの範囲を含むが、リポジトリから一発で再実行できる自動E2E scriptとしては未整備である。

### 15.3 OMP project E2E

MicroVM内ではOMP Browserがprojectの`localhost`へアクセスし、click/fill/wait/screenshotなどを行える設計である。UIを変更したタスクは、実装後のブラウザ確認を完了条件にできる。ただし、このrepository自身の検証としてOMP Browserを実際に起動する自動E2Eは未実装である。

## 16. 元設計からの主要な設計判断

### 16.1 Auth Brokerを採用しなかった理由

単一利用者・単一の主要IDEセッションでは、常駐EC2/Auth Brokerの費用と運用が大きい。OMPの認証状態が`agent.db`へ集約されるため、lifecycle hookとS3で十分と判断した。

ただし、複数MicroVMの同時refreshには弱い。利用形態が拡大した時点で再評価する。

### 16.2 Workspaceを保存しない理由

任意workspace全体のsnapshotは、容量、復元時間、secret混入、同時編集競合、コスト、整合性の課題がある。最初の実用版ではGitを永続化境界にする方が明確である。

### 16.3 通常GitHubを選んだ理由

実要件ではGitHub Enterprise固有機能が不要で、通常`github.com`へOAuth接続できればよい。GitHub CLIのweb flowでPATを利用者に発行させずに済む。

### 16.4 Cognitoではなくパスワードフォームを選んだ理由

個人用PoCとしてリソースと設定を最小化した。Secrets Managerの自動生成passwordとHMAC Cookieで、MicroVM起動前の入口を保護できる。

MFA、ユーザー管理、監査、失効が必要になればCognito/OIDCへ移行する。

### 16.5 明示Suspend UIを追加した理由

open editorのWebSocket通信とauto resumeにより、単なるidle設定では利用者の「停止したい」という意図を保証できない。Edge側でtrafficを遮断してからSuspendする必要があった。

## 17. 制約とスケーリング境界

現在の設計が適する範囲:

- 1人
- 少数セッション
- 1つの共有認証状態
- 最大8時間の作業単位
- Git中心の成果物管理
- 手動デプロイを許容

境界を超える兆候:

- セッションが25件を超える
- 複数VMで同時にOAuth refreshする
- ユーザーごとのsession分離が必要
- 監査/MFA/退職者失効が必要
- workspaceをGit push前にも保全したい
- 日常的な変更を手動deployできない
- SLO/アラーム/自動復旧が必要
- 認証状態syncの成功保証や複数writer整合性が必要
- 未信頼repositoryをcredentialと同居させられない
- control routeをport proxyアプリと同一originに置けない
- 8時間を超えて同じVMを維持したい

この段階では、DynamoDB Query/GSI、Cognito/OIDC、Auth Broker、CI/CD、workspace persistenceを再設計する。

## 18. コスト構造

費用はMicroVMのRUNNING computeだけではない。

| 層 | 主な課金要素 |
| --- | --- |
| Lambda MicroVM | baseline/burst compute、Image storage、Suspend snapshot、start/resume read、suspend write |
| Edge/control | CloudFront request/転送、Lambda@Edge invocation、DynamoDB、Secrets Manager |
| 永続化 | S3 current/noncurrent Version、PUT/GET、KMS request/key、CloudWatch Logs |
| CI/CD | CDK asset upload、Image build、GitHub Actionsを導入した場合のrunner |

idle timeoutだけで費用上限を保証せず、エディタのWebSocketやpollingでRUNNINGが続く可能性がある。明示Suspend、セッション一覧の状態確認、S3 Version lifecycle、Log retentionに加えて、cost allocation tag、AWS Budgets、Cost Anomaly Detectionを検討する。

## 19. 関連資料

- [学び・ハマりどころ・注意点](lessons-learned.md)
- [実装状況・未実装項目・改善ロードマップ](implementation-status-and-roadmap.md)
- [セッション管理の詳細](session-management.md)
- [利用・デプロイ手順](../code-server/README.md)
