# OMP Cloud IDEの実装状況・未実装項目・改善ロードマップ

最終更新: 2026-09-25
対象: `code-server/`配下の個人用OMP Cloud IDE実装
基準: 2026-09-25時点の実装とデプロイ検証

この文書は、現時点で何が実装・検証済みか、何が部分実装または未実装か、次にどの改善を行うべきかを独立して判断できるようにまとめたものである。

## 1. 現在の到達点

通常GitHubの個人リポジトリから、AWS上へ手動デプロイして利用できる単一ユーザー向けオンデマンドCloud IDEとして動作している。

利用の基本フローは次のとおり。

```text
CloudFront URLを開く
  ↓
Lambda@Edgeのログインフォーム
  ↓
既存MicroVMを選ぶ / 新規MicroVMを開始
  ↓
code-server
  ↓
terminalからOMP、git、gh、Node/Bun/Pythonなどを利用
  ↓
作業後は明示Suspend
  ↓
次回は同じMicroVMをResume、または新規作成
```

OMPとGitHubの認証状態はKMS暗号化されたS3へ保存される。ワークスペース自体は永続化されないため、成果物はGitへcommit/pushする。

## 2. 機能別ステータス

凡例:

- **実装・検証済み**: コード、テスト、実環境で確認済み
- **実装済み**: コードとローカルテストはあるが、利用パターン全体の実機検証が不足
- **部分実装**: 基本機能はあるが、運用上必要な周辺機能が不足
- **未実装**: 現在の構成には存在しない
- **意図的に不採用**: 現要件では別方式へ置き換えた

### 2.1 AWS基盤

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| 東京リージョンのLambda MicroVM Image | 実装・検証済み | `ap-northeast-1`、ARM64、AL2023 base |
| CloudFront | 実装・検証済み | HTTPS入口、cache無効、HTTP/2・HTTP/3 |
| Lambda@Edge origin-request | 実装・検証済み | 認証、セッション管理、origin差し替え、token付与 |
| Lambda@Edge origin-response | 実装・検証済み | 一時的`502`/`504`から選択画面へ復帰 |
| DynamoDBセッションテーブル | 実装・検証済み | PAY_PER_REQUEST、TTL。選択画面は25件ずつ全ページScan |
| Secrets Managerアクセスパスワード | 実装・検証済み | 32文字自動生成、Edgeが実行時取得 |
| S3認証状態Bucket | 実装・検証済み | KMS、Versioning、Block Public Access、RETAIN。非現行Version lifecycleあり。実行Roleと実bucketでETag条件付き書き込みを確認済み |
| KMS Key rotation | 実装済み | rotation有効、RETAIN |
| MicroVM CloudWatch Logs | 部分実装 | 専用Log Group、1週間保持、削除保護、RETAIN。ただし届くのはImage build/検証用VMの出力だけで、実行中MicroVMのstdout(`[lifecycle]`行など)は届かない |
| Edge CloudWatch Logs | 部分実装 | 元Functionは731日保持・RETAIN、複製先regional logの保持/集約は未管理 |
| カスタムドメイン/ACM | 未実装 | CloudFront標準ドメインを使用 |
| WAF/レート制限 | 未実装 | ログイン試行制限なし |
| メトリクス/Alarm/Dashboard | 未実装 | 手動調査中心 |

### 2.2 認証とセキュリティ

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| MicroVM起動前のログイン | 実装・検証済み | Lambda@Edge HTMLフォーム |
| ブラウザ互換性 | 実装・検証済み | ネイティブBasic認証依存を解消 |
| 署名付きアクセスCookie | 実装・検証済み | HMAC-SHA256、8時間、改ざん/未来期限検証 |
| セッションCookie | 実装・検証済み | UUID参照、Secure/HttpOnly/SameSite=Strict |
| SecretsのImage/Git混入防止 | 実装済み | パスワード・OAuth tokenはImageに入れない |
| 非root実行 | 実装・検証済み | UID/GID 1000の`vscode` |
| MicroVM実行Role最小化 | 実装・検証済み | 認証状態S3/bucket、KMS、ログに限定 |
| Edge Role最小化 | 実装・検証済み | 対象Image、Role、Table、Secret等に限定 |
| セキュリティヘッダー | 実装・検証済み | CSP、HSTS、nosniff、no-referrer等 |
| MFA/ユーザー別認証 | 未実装 | 個人用固定username/password |
| ログイン試行ロック | 未実装 | brute-force防止なし |
| ログアウト/全Cookie失効UI | 未実装 | 手動Cookie削除またはパスワードrotation |
| 状態変更request分離 | 未実装 | proxyアプリとcontrolが同一origin。SameSiteだけでは同一originコードを防げない |
| Edge専用Cookieのorigin転送防止 | 実装・検証済み | access/session Cookieは認証後にorigin-requestから除去し、code-server固有Cookieを保持。実VMの`/proxy/3000/headers`でEdge Cookieが届かないことを確認 |
| 未信頼repository隔離 | 未実装 | Workspace Trust無効、同一UIDからOAuth/AWS資格情報とInternet egressを利用可能 |
| DDBの顧客管理KMS Key | 未実装 | AWS所有キーによるデフォルト暗号化に依存 |

### 2.3 MicroVMセッション管理

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| 新規MicroVM起動 | 実装・検証済み | 明示POST、UUIDの条件付きclaimで二重POSTを409として抑止。登録失敗は補償Terminateを要求 |
| 既存セッション一覧 | 実装・検証済み | 終了済み以外を表示。PENDING/SUSPENDING/UNKNOWNのUXは未整備 |
| 既存RUNNINGへ再接続 | 実装・検証済み | session Cookie再発行 |
| 既存SUSPENDEDのResume | 実装・検証済み | `ResumeMicrovm`後に同じsessionへ接続 |
| 明示Suspend | 実装・検証済み | status bar→control page→POST |
| 再接続による意図しないResume防止 | 実装・検証済み | DDB `paused`で通常通信を遮断 |
| 一時的502/504からの復旧 | 実装・検証済み | Cookie維持、一覧へ戻す |
| token自動更新 | 実装済み | 1時間token、15分前更新。更新失敗時、旧tokenが失効済みなら503で止める |
| セッションTerminate UI | 実装・検証済み | 追跡中の行だけ選択画面・制御画面からID再入力で終了。曖昧な失敗は遮断を維持し、終了確認後に対象DDB行を削除 |
| セッション名・用途ラベル | 未実装 | MicroVM IDと作成時刻のみ |
| 一覧ページング | 実装済み | DDB Scanと`ListMicrovms`を全ページ照合。個人用のため件数上限・bounded concurrencyはない |
| 一覧の負荷制御 | 未実装 | 全候補を並列`GetMicrovm`、bounded concurrency/retry/cacheなし |
| stale DDB行の即時削除 | 部分実装 | 一覧確認時にTERMINATED/NotFound行を対象ID一致で削除。TERMINATING中は保持 |
| 複数ユーザーの所有者分離 | 未実装 | 認証済み利用者は全候補を見られる単一ユーザー設計 |

### 2.4 OMPと開発ツール

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| OMP preinstall | 実装・検証済み | version固定、起動直後から利用可能 |
| Claude subscription | 実装・利用確認済み | OMP OAuth情報を`agent.db`へ保存 |
| OpenAI Codex subscription | 実装・利用確認済み | OMP OAuth情報を`agent.db`へ保存 |
| OpenCode Go設定 | 実装済み | model role/fallback設定あり、モデル呼び出しの正式E2Eは未完 |
| modelRoles/fallback | 実装済み | default/slow/plan/smol/advisor |
| Goal Mode | 実装済み | interactive continuation有効 |
| Ask tool | 実装済み | 有効 |
| approvalMode | 実装済み | `yolo` |
| 破壊的コマンドdeny | 実装済み | `rm -rf *`、`git push --force*` |
| OMP Browser | 実装済み | Chromium起動をImage buildで検証。OMP `browser.open`実操作E2Eは未完 |
| OMP Computer tool | 未実装 | headless Web E2Eを優先 |
| プロジェクト共通AGENTSルール | 未実装 | 各clone先リポジトリへ依存 |

### 2.5 開発ランタイム・IDE

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| code-server | 実装・検証済み | port 8080、`--auth none`、前段保護 |
| Node.js/TypeScript | 実装済み | Node 24、TypeScript/LSP |
| Bun | 実装済み | ARM64 binary |
| Python/pip/uv/Pyright | 実装済み | AL2023 Python + uv + LSP |
| Bash/YAML Language Server | 実装済み | npm global install |
| git/GitHub CLI | 実装・利用確認済み | 通常GitHub、HTTPS OAuth、PAT不要 |
| AWS CLI | 実装済み | ARM64 CLI v2 |
| ripgrep/jq/tree等 | 実装済み | Imageへ事前導入 |
| VS Code日本語化 | 実装済み | Japanese language pack |
| YAML/Python/Docker extension | 実装済み | Image build時に導入 |
| Suspend control extension | 部分実装 | HTTPS制御画面を開くがCloudFront URLがImage内に固定 |
| MicroVM残り寿命表示 | 実装・検証済み | Edgeが`RunMicrovm`直前に計算した期限を`/run` hook経由で渡し、status barへ`残り H:MM`、30分/10分で警告色、60/15/5分で通知。VM内時計はS3 `Date` headerで毎分補正(実機ではSuspend 3分→Resume後も補正-1秒で、ゲスト時計の遅れは観測されなかった)。deploy後の新規VMのみ対象 |
| リポジトリ自動clone | 未実装 | 起動後に手動clone |
| project依存の自動install | 未実装 | 各リポジトリで手動 |

### 2.6 永続化

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| OMP `agent.db`永続化 | 実装済み | SQLite backup API→`s3api put-object`。結果・VersionIdを`~/.cache/omp-cloud-ide/auth-sync.json`へ記録しstatus barに表示 |
| OMP `install-id`永続化 | 実装済み | 他ファイルと同じdeadline・失敗記録の対象 |
| GitHub CLI認証永続化 | 実装済み | `hosts.yml`→S3。保存結果をstatus barに表示 |
| `/run`復元 | 実装・検証済み | 25秒の共通deadline内で3ファイルを並列取得し、atomic replace。1つの遅延が後続を期限切れにしない。NoSuchKeyは正常、その他の失敗は`restoreFailed`に記録してそのkeyの自動保存を止める。fail-openで200 |
| 5分定期保存 | 実装済み | ETag条件付き。sha256が前回保存と同じならskip。競合・復元失敗のkeyは自動保存しない。lockが使用中なら待たずにskipし、hookが待っていれば実行中のAWS呼び出しを中断して譲る |
| `/suspend`保存 | 実装済み | 40秒deadline(hook timeout 45秒)でETag条件付き保存。失敗・競合は`auth-sync.json`へ記録し、Suspendを止めないfail-openで200。手動保存がlockを握っている間(最大約2分)は保存をskipし得る |
| `/terminate`保存 | 実装済み | 同上 |
| 手動保存 | 実装済み | `persist-auth-state`またはstatus barのクリック。変更のあるファイルをETag条件付きで保存し、失敗・競合時は非zero終了。`restoreFailed`のブロックも解除する。`--overwrite`は全ファイルを無条件に保存 |
| 保存結果の表示 | 実装・検証済み | status barに`認証 N分前`、15分(同期間隔の3倍)以上古いか記録がなければ警告、`認証保存失敗`/`認証復元失敗`/`認証競合`はエラー表示。control page・セッション選択画面・metricには未反映 |
| S3 Version lifecycle | 実装・検証済み | 非現行Versionは30日で失効。ただし最新10世代の非現行Versionは期間に関係なく保持。未完了multipart uploadは1日で破棄 |
| Workspace永続化 | 未実装 | Gitを永続化境界とする |
| S3過去Versionからの復元UI | 未実装 | 手動運用 |
| 複数VMの書き込み競合制御 | 実装・検証済み | S3 ETagによる楽観ロック。`/run`で記録したETagと一致するときだけ上書きし、不一致は`認証競合`として表示。`persist-auth-state --overwrite`で明示上書き |

### 2.7 IaC・デプロイ・CI/CD

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| AWS CDK TypeScript | 実装済み | 2リージョン・2スタック |
| cdkd deploy | 実装・検証済み | `--all --full-wait` |
| cdkd diff/dry-run | 実装済み | npm scripts |
| IaC unit test | 実装・検証済み | Jest 22件(うち1件がPython `lifecycle_test.py`の11件を実行) |
| Biome lint | 実装・検証済み | recommended rules |
| TypeScript strict check | 実装・検証済み | `tsc --noEmit` |
| GitHub Actions CI | 未実装 | workflowなし |
| GitHub Actions CD | 未実装 | 手動SSO deploy |
| GitHub OIDC→AWS | 未実装 | 静的キーも置いていない |
| `staging`/`main`環境分離 | 未実装 | `main`のみ |
| GitHub Environment/承認 | 未実装 | Environmentなし |
| branch protection/required checks | 未実装 | `main`未保護 |
| dependency update automation | 未実装 | 手動pin更新 |
| automated deployed E2E | 未実装 | 手動実行 |
| 複数環境の並行deploy | 未実装 | resource名・control URL・生成config pathが環境非対応 |
| retained resource cleanup | 未実装 | Lambda@Edge旧Version、KMS等の棚卸しRunbookなし(S3非現行Versionはlifecycleで失効) |

## 3. 現在の検証実績

### 3.1 ローカル検証

直近の変更では次が成功している。

```text
npm run build
npm run lint
npm test -- --runInBand  # Jest 22 tests(Python lifecycle_test.py 11 testsを含む)
npm run diff             # deploy後は両Stack差分ゼロ
```

テスト内容は、IaC、IAM、Cookie署名、HTML escape、CSP、Suspend/Resume、502復旧、Image設定、Chromium、extensionなどを含む。Python側(`lifecycle_test.py`)は、初回復元の未作成object、復元失敗時の自動保存停止、別VMの新しい状態を上書きしないETag条件付き書き込み、sha256による未変更skip、保存失敗の記録、hook deadline、hookによる定期保存の中断、`/run` hook envelopeからの期限記録を確認する。Jest側は残り寿命のcountdown・通知閾値・時計補正と、Edgeが実際の期限より遅い`expiresAt`を渡さないことも確認する。

### 3.2 実ブラウザE2E

セッション選択機能のデプロイ後、独立したブラウザコンテキストとテスト専用MicroVMを使って次を確認した。

- ログインフォーム成功
- 復旧対象の既存MicroVMが一覧へ表示される
- `Start a new MicroVM`
- code-server UI表示
- 明示Suspend
- 選択画面で`Resume and connect`
- Resume後に同じsession Cookieでcode-server UI表示
- テストMicroVMのTerminate
- テストDynamoDB行の削除
- 既存MicroVMがテスト前後で維持される

2026-09-25、残り寿命表示・認証保存状態表示・ETag楽観ロックのデプロイ後に、テスト専用MicroVMで次を確認した。

- 新規MicroVMのstatus barに`残り 7:59`と`認証 0分前`が表示される
- 30〜180秒のSuspend後にResumeしても、同じ表示が続く。3分のSuspend後の時計補正は-1秒で、ゲスト時計の遅れは観測されなかった
- テストMicroVMのTerminate、テストDynamoDB行の削除、既存MicroVMの保護

このE2Eでは、login・chooser・Suspend・ResumeをCookie付きHTTPで操作し、ブラウザではcode-server UIだけを開いた。同梱のheadless ChromiumがEdgeのlogin/chooserページを描画するとSkia FontConfigで異常終了するためである(5.9.1節)。

同日、起動・終了の安全策を反映したEdgeをデプロイし、テスト用MicroVMだけでフォームUUIDの二重POSTが409になること、追跡中のセッションを選択・接続できること、確認画面で誤ったIDが拒否されること、正しいIDでTerminateした後に`TERMINATED`を確認して行が消えること、access Cookieを残して選択画面へ戻ることを確認した。既存MicroVMは検証後も残った。新規VMのstatus barは`残り 7:59`を表示したが、1回の実行では`omp/install-id`と`github/hosts.yml`に`認証復元失敗`も表示された。

別のテスト用MicroVMでは、IDE内でport 3000の一時的なHTTP endpointを起動し、CloudFrontの`/proxy/3000/headers`を通したCookie headerが空であることを確認した。access/session Cookieを付けたブラウザ側リクエストでも、originへは渡っていない。`/run`の認証復元はこのVMで全ファイル成功し、同じVMからのS3 `get-object`も成功した。当時は前述の失敗原因を特定できていなかった。

その後、旧`/run`の先頭`get-object`を遅延させた回帰テストで、後続2ファイルが`DeadlineExceeded`になり、実機と同じ復元失敗の並びになることを再現した。3ファイルを共通deadline内で並列取得するImageをデプロイし、新規テストVMを2台連続で起動。両方で`auth-sync.json`の`restoreFailed=[]`、3ファイルのSHA-256記録、status barの`認証 0分前`、VM内からのS3取得成功を確認した。Suspend/Resume後も正常表示され、テストVMだけをTerminate・行削除し、既存VMは維持された。元の実機失敗のエラーコードは取得できていないため、同じ遅延が唯一の原因だったとは断定しない。

### 3.3 手動利用確認

- OMP起動
- Anthropic/Claude OAuth
- OpenAI Codex OAuth
- 通常GitHubの`gh auth login --web`
- ChromeからのCloudFrontログイン
- Codex内蔵ブラウザでのHTMLログインフォーム
- 失った`mvm-session`を既存セッション選択で復旧
- 実行Role(`omp-cloud-ide-microvm-execution`)と実bucket(Versioning、SSE-KMS)でのS3 conditional write: `If-None-Match`による作成、別writer更新後の`conflict`、手動保存も`conflict`で非zero終了、`--overwrite`での上書き成功(5.1節)

### 3.4 未完のE2E

次は部分的な利用確認に留まり、再現可能な自動E2Eとしては未整備である。

- OpenCode Goで実際のmodel request
- OMP Browserによる`browser.open`→localhost操作→screenshotの実E2E
- private repositoryのclone→edit→test→commit→push→PR作成
- 新規VMでS3 objectを復元し、OMP/GitHub認証が利用できるところまでの再現可能なE2E
- S3の過去Versionからの認証DB復旧
- 強制的な異常終了後の最大損失時間確認
- 2台の実MicroVMが同時にOAuth refreshする競合試験(条件付き書き込み自体は実行Roleと実bucketで確認済み)
- 8時間上限到達後の新規VMへの認証復元
- `/run`復元失敗の実機エラーコード取得と継続監視。後続が期限切れになる逐次取得は再現・修正済みだが、過去の実機失敗コードは残っていない。S3/KMS固有障害は依然として`restoreFailed`になり、該当keyの自動保存が止まる
- CloudFront/Lambda@Edgeのregional log横断調査
- 残り寿命の60/15/5分通知と警告色の実機確認(実機で確認したのは開始直後とSuspend/Resume後の表示まで)
- status bar項目のクリック(Suspend制御画面、手動保存、Source Control)の実ブラウザ操作。headless Chromiumでは文字glyphがほぼ描画されず、合成`element.click()`も効かないため自動化できていない

## 4. 元設計から変更した点

| 元設計 | 現在 | 理由 |
| --- | --- | --- |
| 常駐OMP Auth Broker | S3へ`agent.db`を保存 | 単一利用者では常駐サーバーが過剰 |
| Auth Broker用EC2 | 不採用 | 常時費用・運用対象を増やさない |
| GitHub Enterprise | 通常`github.com` | 実要件に合わせた |
| PATまたは外部Secret | `gh auth login --web` OAuth | PATを使わない要件 |
| root相当`vscode` | UID/GID 1000 | OMP shell実行時の影響を低減 |
| native HTTP Basic | HTMLフォーム+Cookie | 埋め込みブラウザ互換性 |
| Cookieなしで自動新規起動 | 選択画面 | 既存作業の孤立と不要起動を防止 |
| Browserは後回し | ARM64 ChromiumをImage同梱 | OMP自身のE2Eを標準化 |

## 5. 改善策の優先順位

### P0: データ損失と認証競合を減らす

#### 5.0 lifecycle保存を「成功/失敗が分かる処理」にする(実装済み 2026-09-25)

次を実装した。

- hookごとのdeadline(`/run` 25秒、`/suspend`・`/terminate` 40秒)。各AWS CLI呼び出しは`min(25秒, 残り時間)`で打ち切る
- `/run`の3つのS3取得を並列化。遅い先頭取得に後続ファイルの時間を奪われないようにし、各ファイルの失敗隔離と共通25秒deadlineは維持する
- fail-open policy: hookは常に200を返してRun/Suspend/Terminateを止めない。代わりに結果を`auth-sync.json`へ記録する
- 手動command(`persist-auth-state`)は失敗ファイルがあれば非zeroで終了し、ファイルごとの結果を表示する
- last-success、failed-files、restoreFailed、VersionId/ETagを`auth-sync.json`へ記録し、code-serverのstatus barに`認証 N分前`/`認証保存失敗`/`認証復元失敗`として表示する。クリックで手動保存
- lifecycle hookが待っている間、定期保存は実行中のAWS呼び出しを中断してlockを譲る。lockは`fcntl.flock`で手動commandとも共有する
- sha256で未変更ファイルをskipする
- 復元に失敗したkeyは自動保存を止める(ログインし直して手動保存すると解除)

未対応: DynamoDB/metricへの記録(VMの実行Roleに権限がないため、現状はVM内ファイルのみ。実行中MicroVMのstdoutはCloudWatch Logsに届いておらず、Log GroupにあるのはImage build/検証用VMのログだけだった)。手動保存がlockを握っている間(最大約2分)にSuspendされると、hookは待ちきれずに保存をskipし得る。

完了条件「利用者がTerminate前に最新の認証状態が保存されたか判断できる」は、status barの表示で満たす。

#### 5.1 同時実行ポリシーを決める(実装済み 2026-09-25: ETag楽観ロック)

複数MicroVMが同じS3 keyへOMP/GitHub認証状態を書けるため、S3 conditional writeによる楽観ロックを採用した。

- `/run`の復元時に各objectのETag(存在しなければ「未作成」)を`auth-sync.json`へ記録する
- 自動保存(定期・Suspend・Terminate)と手動保存は`--if-match <ETag>`(未作成なら`--if-none-match '*'`)で書く。成功したら新しいETagを記録する
- `412 PreconditionFailed`は別VMがより新しい状態を書いた証拠として`conflicts`に記録し、status barに`認証競合`と表示する。そのkeyは自動保存しない
- `409 ConditionalRequestConflict`は一時的な競合として失敗扱いにし、次回に再試行する
- 手動保存も条件付きのまま。このVMの認証で上書きすると決めた場合だけ`persist-auth-state --overwrite`で無条件に書き、競合を解除する

検証: 実行Role(`omp-cloud-ide-microvm-execution`)と実bucketで、未作成→`If-None-Match`で作成、別writerが更新→このVMの保存は`conflict`でS3は別writerの内容のまま、手動保存も`conflict`で非zero、`--overwrite`で上書き成功、を確認した。

未対応: 競合したVMが別VMの新しい認証を取り込み直す操作(現状はログインし直すか、そのVMを終了して新規VMで復元する)。本格的な並列利用ではAuth Brokerまたは中央token serviceへ移行する。

完了条件:

- 2台同時refreshでも新しいcredentialが古いcredentialに戻らない。(満たす)
- 競合時は黙って上書きせず、ログまたはUIで検知できる。(満たす: status barと`persist-auth-state`の出力)

#### 5.2 Workspaceの損失防止を強化する

現状はGit運用に依存する。次の軽量策から検討する。

- status barに「未push変更を確認」の導線を追加
- Terminate前にdirty repositoryを検知して警告
- startup時に指定repository/branchを自動clone
- 任意のworkspace snapshotをS3へ保存する明示コマンド

無条件の定期workspace snapshotは、サイズ、secret混入、復元競合、コストが増えるため、認証状態と同じ仕組みへ安易に混ぜない。

#### 5.3 明示Terminateと新規作成の安全策(実装済み 2026-09-25)

- chooserの新規起動フォームへrequest UUIDを入れ、DDB条件付きclaimを先に確保する。同じフォームの二重POSTは2台目を作らず409を返す
- `RunMicrovm`後にtoken作成や行保存が失敗したら`TerminateMicrovm`を要求する。補償も失敗したMicroVMは`ListMicrovms`とDDBの全ページ照合で「Untracked MicroVMs」に表示する(定期ジョブではなくchooser表示時)。起動中のVMと区別できないためuntrackedの画面内Terminateは提供せず、AWS API/Consoleで手動確認する
- 追跡中セッションの終了ボタンは、Image ARNと状態を再確認し、確認画面でMicroVM ID全文の再入力を求める。`terminationPending=true`と`paused=true`で通信・再接続を遮断してからAPIを呼び、成功した現在のbrowser session Cookieだけを失効させる
- API結果が不明でも遮断を維持して再試行可能にする。`TERMINATING`中のDDB行は保持し、TERMINATED/NotFoundを確認したときだけ対象ID一致の条件付き削除をする。認証状態の`/terminate` hookはfail-openで保存成功を保証しない
- `lambda:TerminateMicrovm`はImage/同アカウントMicroVM ARN、`lambda:ListMicrovms`はresource-level認可がないため`*`。DDB DeleteItemは対象Tableのみ
- token refresh失敗時は、旧tokenが有効なら継続し、失効済みなら503と再試行を案内する

残る制約: Lambda@Edgeの30秒以内に全候補を照合するため、VMが増えた場合のbounded concurrency、キャッシュ、定期reconciliationは未実装。terminate受理とhook完了は同義ではないため、行の削除は終了状態を確認するまで遅延する。

### P1: 運用を自動化・可観測化する

#### 5.4 GitHub Actions CI/CDを構築する

現状は手動SSOデプロイのみである。推奨構成:

```text
feature → PR: build / lint / unit test / synth（AWS資格情報なし）
staging merge: GitHub OIDCでstagingへ自動deploy + smoke test
main merge: prod Environment承認後にdeploy + E2E
```

必要事項:

- 固定のImage/Table/Secret/Role/Bucket/Headers Policy名を環境suffixまたは別accountで分離する
- Image内に固定されたcontrol URLを相対化またはruntime注入する
- synth時に共有source directoryへ`config.json`を書き込むraceを解消し、環境別outputへ生成する
- PR synthでは非秘密のaccount/regionを明示注入する（現状`CDK_DEFAULT_ACCOUNT`必須）
- `staging`/`main`ブランチと環境の1:1対応
- GitHub Environmentsのdeployment branch制限
- prod required reviewers
- GitHub OIDC、静的AWS key禁止
- `.github/workflows/**`のCODEOWNERS
- actionsのcommit SHA固定
- docs-only時もrequired checkがpendingにならないchanges判定
- `code-server/**`など成果物へ流入するpathのallowlist
- E2E専用VMを識別して確実にcleanup
- cdkdが直接AWS APIを呼ぶ前提で、環境別OIDC Roleとpermission boundaryを設計する

#### 5.5 Observabilityを追加する

追加候補:

- Lambda@Edge error/throttle Alarm
- MicroVM Image build failure Alarm
- CloudFront 4xx/5xx率
- セッション起動、Resume、Suspendのカスタムメトリクス
- 認証失敗回数（パスワード値は記録しない）
- lifecycle sync失敗回数・last-success・failed-files・conflictsのmetric化(現在はVM内`auth-sync.json`とstatus barだけ)
- 実行中MicroVMのログ取得経路(現状、runtime MicroVMのstdoutはCloudWatch Logsへ届かない)
- regional Lambda@Edge logの保持/中央集約
- CloudFront access log
- `GetMicrovm.stateReason`を含む障害Runbook
- Dashboardと調査Runbook
- 構造化ログとcorrelation ID

Lambda@Edgeのログは実行リージョンへ分散し得るため、中央集約または調査手順が必要である。

#### 5.6 E2Eスクリプトをリポジトリへ正式実装する

今回の一時スクリプトで検証したフローを、再実行可能なテストへする。

安全要件:

- 実行前の生存MicroVM IDを保護対象としてsnapshot
- test tag/session metadataを付与
- cleanupは作成したIDだけ
- Secretはruntime injectionし、ログへ出さない
- timeoutや途中失敗でもfinally cleanup
- selector、editor、Suspend/Resumeのscreenshotをartifact化

2026-09-25のdeployed E2Eで分かった実装上の注意:

- 同梱のheadless ChromiumはEdgeのlogin/chooserページでabortするため(5.9.1節)、login・chooser・Suspend・ResumeはCookie付きHTTPで操作し、ブラウザはcode-server UIだけに使う
- code-serverはready後に`/`へ`./?folder=...`への302を返すので、readiness probeに使える
- status bar項目は合成`element.click()`では反応せず、実mouse clickも文字glyphが描画されない状態では不安定である

### P1: セキュリティを強化する

#### 5.7 個人用パスワードをOIDCへ置き換える

候補はCognito Managed Loginまたは信頼できるOIDC IdPである。次が得られる。

- MFA
- ユーザー識別
- token失効
- 監査
- login rate limit

単一利用者の簡潔さとのトレードオフがあるため、外部公開範囲と利用頻度で判断する。

#### 5.7.1 control/auth originとIDE/proxy originを分離する

現在は同一CloudFront origin上の`/proxy/<port>/`アプリからsession制御routeへrequestできる。根本対策として、control/auth専用hostnameを分け、状態変更Cookieをそのhostnameだけへ限定する。

Edge専用の`omp-cloud-ide-auth`と`mvm-session`は、認証後にcode-serverへ転送する前に除去する。code-server自身のCookieは保持する。ただし同一CloudFront origin上の`/proxy/<port>/`アプリは制御routeへリクエストでき、server-side appは同じUIDの認証ファイルを読める。control/auth専用hostnameへの分離とproxy backendの実機E2Eは引き続き必要である。

移行までの軽減策:

- Origin/Referer検証
- 状態変更前の再確認
- rate limit
- 未信頼Webアプリを同一originへ載せない

同一originのまま単純CSRF tokenだけを追加しても、同一originアプリがtokenを読めるため完全な境界にならない。

#### 5.7.2 未信頼repository用の実行境界を作る

Workspace Trustを再評価し、未知repoや依存install scriptを`yolo`で実行しない。必要に応じて次を導入する。

- credential-freeの別Session/Image
- provider credentialのAuth Broker/別UID分離
- egress proxy/allowlist
- 作業Roleの短命AssumeRole
- clone後、実行前のreview gate

#### 5.8 WAFとレート制限を追加する

CloudFrontへWAF Web ACLを関連付け、少なくともログインrouteのrate-based ruleを検討する。固定IP制限が利用形態に合う場合は、さらに入口を狭められる。

MicroVM proxy tokenは現状60分である。短命化（例: 15〜30分）とrefresh閾値を再評価し、条件付きDynamoDB更新と並行refresh試験を行う。

#### 5.9 Supply chain検証を揃える

現在checksumがあるのは一部の配布物だけである。code-server、Node、Bun、GitHub CLI、AWS CLI、uvもchecksum/署名検証を追加する。

さらに次を検討する。

- Renovate/Dependabotによる更新PR
- SBOM生成
- Image vulnerability scan
- npm lockfileのreview
- VS Code extension version pin
- `dnf` repository snapshotまたは更新時のlock manifest
- package manifestのcaret rangeをexact化
- base image version/digestの更新方針
- OMP/provider更新時の互換性テスト

#### 5.9.1 Chromiumの調達元を再評価する

現在はSparticuz/chromiumのarm64 pack(149.0.0)をImage build時に`/opt/chromium`へ展開している。開発時点ではChrome for TestingにLinux arm64の配布物がなく、OMPのpuppeteerが自動ダウンロードに失敗するためである。

2026-09-25時点のChrome for Testingの配布一覧(`known-good-versions-with-downloads.json`)では、`linux-arm64`が153.0.8001.0から追加されている。次にChromiumを更新するときは、次の2案を比較する。

| 観点 | Sparticuz arm64 pack(現行) | Chrome for Testing linux-arm64 |
| --- | --- | --- |
| 配布元 | 個人メンテナンスのOSS(Lambda向け) | Google公式(自動テスト向け) |
| 共有ライブラリ | AL2023向けを同梱 | 同梱しない。AL2023 minimalへ不足分を`dnf`で入れる |
| 導入の仕組み | `AWS_EXECUTION_ENV`と`TMPDIR`を指定して`@sparticuz/chromium-min`で展開 | zipを展開し、`PUPPETEER_EXECUTABLE_PATH`で指定 |
| versionの選び方 | Sparticuzのrelease単位 | Chromeのversion単位。puppeteerが想定するversionに合わせやすい |
| 検証 | pack tarのSHA-256を固定 | 配布zipのSHA-256を固定する必要がある |
| font | 同梱の`FONTCONFIG_PATH=/opt/chromium/fonts`を使う。font fallbackでabortする(下記) | AL2023側でfontconfigとfontを用意する必要がある(未検証) |

現行packには実害も出ている。2026-09-25のdeployed E2Eでは、Edgeのlogin/chooserページを描画した時点で`FATAL: SkFontMgr_FontConfigInterface.cpp:163 Not implemented`によりChromiumが異常終了した(font fallback時)。また`about:blank`からCloudFrontへの最初のnavigationが`Navigating frame was detached`で失敗することがあった。code-server UIは描画できるが、文字glyphはほぼ表示されない。OMP Browserで一般のWebページを開く場合も、font fallbackが起きれば同じ異常終了が起こり得る。

前提として、どちらを選んでもOMPの`browser.open`→`localhost`操作→screenshotまでを通すdeployed E2E(3.4節の未完項目)が必要である。E2Eなしでは切り替え後の動作を判断できない。

完了条件:

- 採用した案でImage buildが`chromium --version`まで成功する
- OMP Browser E2EがMicroVM上で成功する
- EdgeのHTMLページを含む通常のWebページをabortせずに描画でき、文字glyphがscreenshotに表示される
- 採用理由とversion・checksumの更新手順を`docs/architecture-and-design.md`9.8節へ反映する

### P2: セッション管理を拡張する

#### 5.10 DynamoDB Scanをやめる

現在は全ページScanしているが、個人用途に限定される。改善案:

- `ownerId`と`updatedAt`を持つGSI
- `Query`によるユーザー別・新しい順取得
- bounded concurrency、retry/backoff、partial failure表示
- 一覧cacheまたは状態の非同期集約でN+1 API callを削減
- 終了済み行の定期cleanupとorphanの定期reconciliation(現在はchooser表示時のみ)
- session label/repository/branch metadata

origin-responseの`502`/`504`復旧もpathを限定し、`/proxy/<port>/`アプリ自身のHTMLエラーをMicroVM障害と誤認しないようにする。

#### 5.11 状態遷移を明示する

現在はAWS stateとDDB `paused`の組合せで判断する。将来は次のapplication stateを明示すると競合を扱いやすい。

```text
STARTING → RUNNING → SUSPEND_REQUESTED → SUSPENDED
                     ↓
                  RESUMING
                     ↓
                  RUNNING
RUNNING/SUSPENDED → TERMINATE_REQUESTED → TERMINATED
```

conditional updateとversion番号を使い、二重クリックや並行操作を検出する。

AWS APIはPENDINGやUNKNOWNを返す可能性があり、`GetMicrovm`成功だけではendpoint readyを意味しない。`stateReason`、health check、polling timeoutをUIへ反映する。proxy token refreshもconditional updateまたはsingle-flightで競合を制御する。

#### 5.12 UXを改善する

- セッション名
- repository/branch表示
- 最終接続時刻
- 現在の課金状態の説明
- Resume進捗のpolling
- 失敗時のretryボタン
- logout
- terminate
- stale session非表示/削除
- PENDING/RESUMING進捗とtimeout
- Image内の固定control URLをcurrent originから導出

### P2: 可用性と復旧性を高める

#### 5.13 認証状態の復旧Runbookを作る

S3 Versioningはあるが、どのVersionへ戻すかは手動である。次を整備する。

- `agent.db`の整合性検査
- Version一覧からの復元コマンド
- 復元前バックアップ
- GitHub credentialの再ログイン手順
- KMS/S3誤削除時の対応

#### 5.14 lifecycle保存結果をセッションUIへ反映する

code-serverのstatus barへの表示は実装済みである(5.0節)。`認証 N分前`、`認証保存失敗`、`認証復元失敗`、`認証競合`を表示し、クリックで手動保存できる。

残る課題:

- セッション選択画面・control pageへの表示。保存結果はVM内の`auth-sync.json`にしかなく、EdgeからもDynamoDBからも読めない。VMの実行Roleには記録先への書き込み権限がない
- Terminate UI(5.3節)で、Terminate前に最後の保存結果を確認させる
- 手動保存がlockを握っている間(最大約2分)に来たSuspend hookが保存をskipし得る

#### 5.15 Resume hookで依存関係を再検証する

現在の`/resume` hookは即時200だけを返す。Resume時に次を必要に応じて検証・再確立する。

- code-server `/healthz`
- 実行Role資格情報の利用可能性
- S3/KMS到達性
- egress/network connection
- lifecycle daemonと定期sync thread

#### 5.16 run hook payloadの活用を広げる

Lambdaは`/run`へ`{"microvmId": ..., "runHookPayload": "<RunMicrovmへ渡した文字列>"}`を送る。残り寿命表示のため、Edgeは`RunMicrovm`直前に計算した`expiresAt`を`runHookPayload`の`{"sessionId", "expiresAt"}`に入れ、`lifecycle.py`はこのenvelopeを解釈して`{microvmId, expiresAt}`を`~/.cache/omp-cloud-ide/session.json`へ書く(実装済み)。VMは自分の`startedAt`を知る手段(`GetMicrovm`権限や環境変数)を持たないため、期限はEdgeから渡している。`sessionId`はbearer Cookie値なのでVM内へ保存しない。

未活用: 記録済みの`microvmId`を、保存結果の記録、認証競合の診断、session別S3 prefixへ使う余地がある。

#### 5.17 保持とcleanupのRunbookを作る

- Lambda@Edge旧Versionの安全な棚卸しとquota監視
- DDB PITRとSecret RETAINの要否
- destroy前のMicroVM→DDB→Secret→RETAIN resource cleanup順序
- S3 noncurrent version lifecycle(実装済み: 30日、最新10世代は常に保持。cdkdは`prefix`だけのruleを旧形式の`Prefix`で送るため、`NewerNoncurrentVersions`と組み合わせると`InvalidRequest`になる。prefixを付けず`Filter: {Prefix: ""}`として送らせている)
- Cost Budget/Anomaly Detection

## 6. 推奨ロードマップ

### Phase A: 現行個人利用を堅牢化

1. lifecycle timeout/失敗通知/last-success(実装済み: 5.0節)
2. 新規作成orphanのcompensationとchooser reconciliation(実装済み: 5.3節)
3. auth-state競合防止とS3 Version lifecycle(実装済み: 5.1節、5.17節)
4. control originとproxy originの分離
5. 明示Terminate UI(実装済み: 5.3節)
6. E2Eスクリプト正式化
7. checksum・version pin拡充

### Phase B: CI/CDと運用監視

1. `staging`/`main`設計
2. 固定resource名/control URL/config生成の環境対応
3. GitHub OIDC Role
4. PR品質ゲート
5. staging自動deploy
6. prod承認deploy
7. deployed smoke/E2E
8. CloudWatch Alarm/Dashboard

### Phase C: 複数利用・長期運用

1. Cognito/OIDC
2. user ownership付きsession table
3. Query/GSI/pagination
4. Auth Brokerまたは中央credential service
5. workspace persistence方針
6. custom domain/WAF

## 7. 現時点の運用上の必須事項

改善が完了するまで、次を守る。

1. 作業成果は早めにcommit/pushする。
2. OMP/GitHubログイン直後は`persist-auth-state`(またはstatus barの`認証`表示のクリック)を実行する。
3. Terminate前・作業終了前はstatus barの`認証`表示が失敗・警告になっていないことを確認する。実行中MicroVMのlifecycleログはCloudWatch Logsへ届かないため、ログではなくstatus barか`~/.cache/omp-cloud-ide/auth-sync.json`で確認する。
4. 複数MicroVMで認証を更新した場合、status barが`認証競合`になったVMの認証は古い。どちらの認証を正とするか決め、必要なら`persist-auth-state --overwrite`を実行する。
5. 未信頼repoや依存scriptを`yolo`で実行しない。
6. 作業終了時はstatus barから明示Suspendする。
7. デプロイ前にbuild/lint/test/diffを通す。
8. デプロイは`npm run deploy`の`--full-wait`を使い、短いtimeoutのツール配下で実行しない。途中で止めるとcdkdのstack lockが残る。その場合はcdkd processが生きていないことを確認してから`cdkd force-unlock <stack> --stack-region <region>`を実行し、deployし直す。
9. Edge/session変更後は実ブラウザE2Eを行う。
10. E2Eでは既存MicroVMを保護し、テストで作ったVMだけを削除する。
11. Secret値やproxy tokenをログ・スクリーンショット・Gitへ出さない。

## 8. 関連資料

- [学び・ハマりどころ・注意点](lessons-learned.md)
- [設計思想・構成・IaC・外部モジュール](architecture-and-design.md)
- [セッション管理の詳細](session-management.md)
- [利用・デプロイ手順](../code-server/README.md)
