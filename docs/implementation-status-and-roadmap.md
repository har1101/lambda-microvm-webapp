# OMP Cloud IDEの実装状況・未実装項目・改善ロードマップ

最終更新: 2026-09-24
対象: `code-server/`配下の個人用OMP Cloud IDE実装
基準コミット: `6c46d65`以降

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
| DynamoDBセッションテーブル | 実装・検証済み | PAY_PER_REQUEST、TTL、最大25件Scan |
| Secrets Managerアクセスパスワード | 実装・検証済み | 32文字自動生成、Edgeが実行時取得 |
| S3認証状態Bucket | 実装済み | KMS、Versioning、Block Public Access、RETAIN。保存結果通知はbest-effort |
| KMS Key rotation | 実装済み | rotation有効、RETAIN |
| MicroVM CloudWatch Logs | 実装済み | 専用Log Group、1週間保持、削除保護、RETAIN |
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
| Edge専用Cookieのorigin転送防止 | 未実装 | 認証後もaccess/session Cookieをcode-server originへ転送 |
| 未信頼repository隔離 | 未実装 | Workspace Trust無効、同一UIDからOAuth/AWS資格情報とInternet egressを利用可能 |
| DDBの顧客管理KMS Key | 未実装 | AWS所有キーによるデフォルト暗号化に依存 |

### 2.3 MicroVMセッション管理

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| 新規MicroVM起動 | 部分実装 | 明示POSTのみ。後続API失敗時のorphan補償なし |
| 既存セッション一覧 | 実装・検証済み | 終了済み以外を表示。PENDING/SUSPENDING/UNKNOWNのUXは未整備 |
| 既存RUNNINGへ再接続 | 実装・検証済み | session Cookie再発行 |
| 既存SUSPENDEDのResume | 実装・検証済み | `ResumeMicrovm`後に同じsessionへ接続 |
| 明示Suspend | 実装・検証済み | status bar→control page→POST |
| 再接続による意図しないResume防止 | 実装・検証済み | DDB `paused`で通常通信を遮断 |
| 一時的502/504からの復旧 | 実装・検証済み | Cookie維持、一覧へ戻す |
| token自動更新 | 実装済み | 1時間token、15分前更新 |
| セッションTerminate UI | 未実装 | AWS API/Console等で手動 |
| セッション名・用途ラベル | 未実装 | MicroVM IDと作成時刻のみ |
| 一覧ページング | 未実装 | Scanは最大25件 |
| 一覧の負荷制御 | 未実装 | 最大25並列`GetMicrovm`、bounded concurrency/retry/cacheなし |
| stale DDB行の即時削除 | 部分実装 | 一覧から除外するがTTL削除待ち |
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
| リポジトリ自動clone | 未実装 | 起動後に手動clone |
| project依存の自動install | 未実装 | 各リポジトリで手動 |

### 2.6 永続化

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| OMP `agent.db`永続化 | 部分実装 | SQLite backup API→S3。失敗してもhook/手動commandは成功扱い |
| OMP `install-id`永続化 | 部分実装 | S3対象だが、他ファイルと同じbest-effort/timeout制約を持つ |
| GitHub CLI認証永続化 | 部分実装 | `hosts.yml`→S3。保存成功の利用者通知なし |
| `/run`復元 | 部分実装 | atomic replace。S3 CLI non-zeroはskipして200、subprocess timeout等は応答失敗し得る |
| 5分定期保存 | 部分実装 | 変更有無に関係なくupload、hookと同じlock |
| `/suspend`保存 | 部分実装 | 45秒timeoutに対し逐次S3処理は最大75秒超 |
| `/terminate`保存 | 部分実装 | 45秒timeout、捕捉された個別保存失敗でも200 |
| 手動保存 | 部分実装 | `persist-auth-state`は失敗を非zeroで通知しない |
| S3 Version lifecycle | 未実装 | 5分syncで旧Versionが継続増加 |
| Workspace永続化 | 未実装 | Gitを永続化境界とする |
| S3過去Versionからの復元UI | 未実装 | 手動運用 |
| 複数VMの書き込み競合制御 | 未実装 | last-writer-wins |

### 2.7 IaC・デプロイ・CI/CD

| 項目 | 状態 | 現状 |
| --- | --- | --- |
| AWS CDK TypeScript | 実装済み | 2リージョン・2スタック |
| cdkd deploy | 実装・検証済み | `--all --full-wait` |
| cdkd diff/dry-run | 実装済み | npm scripts |
| IaC unit test | 実装・検証済み | Jest 11件 |
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
| retained resource cleanup | 未実装 | Lambda@Edge旧Version、S3 Version、KMS等の棚卸しRunbookなし |

## 3. 現在の検証実績

### 3.1 ローカル検証

直近の変更では次が成功している。

```text
npm run build
npm run lint
npm test -- --runInBand  # 11 tests
npm run diff             # deploy後は両Stack差分ゼロ
```

テスト内容は、IaC、IAM、Cookie署名、HTML escape、CSP、Suspend/Resume、502復旧、Image設定、Chromium、extensionなどを含む。

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

### 3.3 手動利用確認

- OMP起動
- Anthropic/Claude OAuth
- OpenAI Codex OAuth
- 通常GitHubの`gh auth login --web`
- ChromeからのCloudFrontログイン
- Codex内蔵ブラウザでのHTMLログインフォーム
- 失った`mvm-session`を既存セッション選択で復旧

### 3.4 未完のE2E

次は部分的な利用確認に留まり、再現可能な自動E2Eとしては未整備である。

- OpenCode Goで実際のmodel request
- OMP Browserによる`browser.open`→localhost操作→screenshotの実E2E
- private repositoryのclone→edit→test→commit→push→PR作成
- 新規VMでS3 objectを復元し、OMP/GitHub認証が利用できるところまでの再現可能なE2E
- S3の過去Versionからの認証DB復旧
- 強制的な異常終了後の最大損失時間確認
- 同時に2つのMicroVMがOAuth refreshする競合試験
- 8時間上限到達後の新規VMへの認証復元
- CloudFront/Lambda@Edgeのregional log横断調査

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

#### 5.0 lifecycle保存を「成功/失敗が分かる処理」にする

現在の認証状態保存はベストエフォートであり、失敗してもhookは200、手動commandは成功終了する。さらにAWS CLI 25秒timeoutを3ファイルへ逐次適用するため、hook全体timeoutを超え得る。

必要な改善:

- hook全体deadlineを設け、残時間を各I/Oへ配分する
- `agent.db`など必須ファイル失敗時はnon-2xxまたは明示したfail-open/fail-closed policyを返す
- 手動commandは失敗ファイルがあれば非zeroで終了する
- last-success、failed-files、保存VersionIdをDynamoDB/metric/UIへ記録する
- periodic syncよりlifecycle hookを優先し、lock待ちでtimeoutしないようにする
- hash/mtimeで未変更ファイルをskipする
- S3 noncurrent versionの保持日数/世代数を決める

完了条件は、利用者がTerminate前に最新の認証状態が保存されたか判断できることである。

#### 5.1 同時実行ポリシーを決める

現在、複数MicroVMが同じS3 keyへOMP/GitHub認証状態を書ける。選択肢を1つ決める必要がある。

推奨順:

1. 当面は「同時に書き込み可能なセッションは1つ」に制限する。
2. 複数セッションが必要なら、S3 VersionId/ETagによる楽観ロックを実装する。
3. 本格的な並列利用ではAuth Brokerまたは中央token serviceへ移行する。

完了条件:

- 2台同時refreshでも新しいcredentialが古いcredentialに戻らない。
- 競合時は黙って上書きせず、ログまたはUIで検知できる。

#### 5.2 Workspaceの損失防止を強化する

現状はGit運用に依存する。次の軽量策から検討する。

- status barに「未push変更を確認」の導線を追加
- Terminate前にdirty repositoryを検知して警告
- startup時に指定repository/branchを自動clone
- 任意のworkspace snapshotをS3へ保存する明示コマンド

無条件の定期workspace snapshotは、サイズ、secret混入、復元競合、コストが増えるため、認証状態と同じ仕組みへ安易に混ぜない。

#### 5.3 明示Terminate機能を追加する

Suspendだけでなく、不要なセッションを一覧から安全にTerminateするUIが必要である。

要件:

- MicroVM IDと状態を再確認
- 二段階確認
- `/terminate` hook完了を待つ
- 対象Image/accountへ絞った`lambda:TerminateMicrovm`権限とIAM assertionを追加
- DDB行削除
- 現在のbrowser Cookieを削除
- 他の既存セッションを誤削除しない

#### 5.3.1 新規作成のorphanを補償する

`RunMicrovm`成功後にtoken作成またはDynamoDB Putが失敗すると、chooserから見えないMicroVMが残り得る。

- start処理で作成済みIDを保持し、後続失敗時だけTerminateする
- 二重POSTに対するidempotency key/conditional writeを導入する
- 定期的に`ListMicrovms`とDynamoDBを照合し、orphan/stale recordを検出する
- compensation/reconciliation用の`lambda:TerminateMicrovm`/`lambda:ListMicrovms`を対象Image/accountへ絞り、IAM testを追加する
- token refresh失敗時に期限切れtokenで黙って続行せず、retryまたは明示エラーへ送る

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
- lifecycle sync失敗回数
- lifecycle last-success/failed-files
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

加えて現状はEdgeで認証した後も`omp-cloud-ide-auth`と`mvm-session`をcode-server originへ転送している。`HttpOnly`でもorigin serverにはCookie headerが届くため、Edge専用の2 Cookieだけをorigin転送前に除去し、code-server自身に必要なCookieは保持する。code-server proxyが内側backendへCookieを渡さないこともE2Eで確認する。

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

### P2: セッション管理を拡張する

#### 5.10 DynamoDB Scanをやめる

現在は最大25件Scanであり、個人用途に限定される。改善案:

- `ownerId`と`updatedAt`を持つGSI
- `Query`によるユーザー別・新しい順取得
- pagination token
- bounded concurrency、retry/backoff、partial failure表示
- 一覧cacheまたは状態の非同期集約でN+1 API callを削減
- terminated recordの明示cleanup
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

現在、保存失敗はログへ出るだけで利用者に見えない。最後の成功時刻、失敗状態、手動再試行をcontrol pageに表示できると、Terminate前の判断が容易になる。

#### 5.15 Resume hookで依存関係を再検証する

現在の`/resume` hookは即時200だけを返す。Resume時に次を必要に応じて検証・再確立する。

- code-server `/healthz`
- 実行Role資格情報の利用可能性
- S3/KMS到達性
- egress/network connection
- lifecycle daemonと定期sync thread

#### 5.16 run hook payload契約を揃える

Edgeは`sessionId`を渡す一方、hookは`microvmId`を探しており、どちらも現在は状態管理へ使っていない。schemaを一致させてログ・競合制御・session別prefixへ活用するか、不要ならpayload自体を削除する。

#### 5.17 保持とcleanupのRunbookを作る

- Lambda@Edge旧Versionの安全な棚卸しとquota監視
- DDB PITRとSecret RETAINの要否
- destroy前のMicroVM→DDB→Secret→RETAIN resource cleanup順序
- S3 noncurrent version lifecycle
- Cost Budget/Anomaly Detection

## 6. 推奨ロードマップ

### Phase A: 現行個人利用を堅牢化

1. lifecycle timeout/失敗通知/last-success
2. 新規作成orphanのcompensation
3. auth-state競合防止とS3 Version lifecycle
4. control originとproxy originの分離
5. 明示Terminate UI
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
2. OMP/GitHubログイン直後は`persist-auth-state`を実行する。
3. commandが成功表示しても、現状はS3保存成功を保証しないためlifecycle logも確認する。
4. 複数MicroVMで同時に認証更新しない。
5. 未信頼repoや依存scriptを`yolo`で実行しない。
6. 作業終了時はstatus barから明示Suspendする。
7. デプロイ前にbuild/lint/test/diffを通す。
8. デプロイは`npm run deploy`の`--full-wait`を使う。
9. Edge/session変更後は実ブラウザE2Eを行う。
10. E2Eでは既存MicroVMを保護し、テストで作ったVMだけを削除する。
11. Secret値やproxy tokenをログ・スクリーンショット・Gitへ出さない。

## 8. 関連資料

- [学び・ハマりどころ・注意点](lessons-learned.md)
- [設計思想・構成・IaC・外部モジュール](architecture-and-design.md)
- [セッション管理の詳細](session-management.md)
- [利用・デプロイ手順](../code-server/README.md)
