# OMP Cloud IDE開発で得た学び・ハマりどころ・注意点

最終更新: 2026-09-24
対象: `code-server/`配下の個人用OMP Cloud IDE実装
基準コミット: `6c46d65`以降

この文書は、AWS Lambda MicroVM上でcode-serverとOMPを動かし、CloudFrontから安全に利用できる個人用Cloud IDEを構築した過程で得た知見をまとめたものである。単なる構築手順ではなく、実際に発生した障害、その原因、採用した対策、同種の実装で再発しやすい点を記録する。

## 1. 最も重要だった設計上の学び

### 1.1 「ブラウザ認証」と「MicroVMセッション選択」は別の状態である

このシステムには、少なくとも次の2種類の状態がある。

| 状態 | 目的 | 現在の表現 |
| --- | --- | --- |
| 利用者認証 | Cloud IDEを使ってよいブラウザか | `omp-cloud-ide-auth` Cookie |
| 接続先選択 | どのMicroVMへ接続するか | `mvm-session` CookieとDynamoDB |

両者を1つのCookieや1つの画面にまとめると、「認証は有効だが接続先Cookieだけ消えた」「MicroVMは生きているがブラウザとの関連付けを失った」という状態を扱えない。

実際、初期実装では一時的な`502`/`504`をMicroVM消失とみなし、`mvm-session`を削除していた。その結果、MicroVMと作業中のローカルディスクは生存しているのに、ブラウザからは新規環境しか起動できないように見えた。

現在は次の原則に変更した。

1. 認証成功後も自動で新規MicroVMを起動しない。
2. `/session/select`で既存セッションへの接続と新規作成を明示的に選ぶ。
3. 一時的なorigin障害では`mvm-session`を消さない。
4. Cookieを失ってもDynamoDBと`GetMicrovm`から再接続候補を復元する。

### 1.2 「停止しているように見える」と「安全にSuspendされた」は違う

code-serverはWebSocketやバックグラウンド通信を行う。ブラウザタブを開いたままにすると、利用者が操作していなくてもendpointへの通信が続き、アイドル判定や自動Suspendの前提を崩す可能性がある。

また、MicroVMの`autoResumeEnabled`が有効なため、Suspend直後にcode-serverが再接続すると、利用者が止めたつもりでも自動Resumeされ得る。

対策として、Suspend APIを呼ぶ前にDynamoDBへ`paused=true`を書き、Lambda@Edgeで通常のエディタ通信を遮断する。HTMLナビゲーションは制御画面へ送り、WebSocketなどの非HTML通信は`409`で拒否する。Resume操作時だけ`paused=false`へ戻す。

重要なのは、クラウド側のライフサイクルAPIを呼ぶだけでなく、アプリケーション経路も同時に制御することである。

### 1.3 MicroVMのRAM/ディスク保持と永続ストレージを混同しない

Suspend中は同じMicroVMのメモリとディスク状態へ戻れるが、最大実行時間やSuspend保持時間を超えてTerminateされると、そのローカル状態は戻らない。

`maximumDurationInSeconds=28800`はRUNNING時間だけでなく、SUSPENDEDを含むMicroVMの総寿命に対する上限である。`suspendedDurationSeconds=28800`を設定していても「8時間作業した後、さらに8時間Suspendできる」という意味ではなく、原則として起動から8時間の総寿命が先に効く。

現在S3へ永続化しているのは、次の認証関連ファイルだけである。

- OMPの`agent.db`
- OMPの`install-id`
- GitHub CLIの`hosts.yml`

`/home/vscode/workspace`は永続化していない。したがって、作業成果の永続化境界はGitであり、Terminate前にcommit/pushする必要がある。

「セッション再接続」は生存している同一MicroVMへ戻る機能であり、「任意時点のワークスペース復元」ではない。

## 2. AWS Lambda MicroVMとLambda@Edge固有のハマりどころ

### 2.1 Lambda@Edgeは`us-east-1`に置く必要がある

実際のMicroVMは東京リージョン`ap-northeast-1`で動かしたいが、CloudFrontへ関連付けるLambda@Edgeは`us-east-1`に必要となる。そのため、CDKスタックを次の2つへ分離した。

- `OmpCloudIdeMicrovmStack`: `ap-northeast-1`
- `OmpCloudIdeEdgeStack`: `us-east-1`

リージョンを単純に東京へ一括変更するとLambda@Edge要件を満たせない。DynamoDBとSecrets ManagerはEdge側の`us-east-1`、MicroVM Image・S3・KMSは東京側という分担になっている。

### 2.2 Lambda@Edgeでは通常の環境変数に依存できない

Lambda@Edgeの設定値は、CDK synth時に`artifact/edge/config.json`へ書き出してバンドルしている。ここへ入れるのはリージョン、リソース名、ARN、設定時間などの非秘密情報だけである。

アクセスパスワードそのものは埋め込まず、安定したSecrets ManagerのSecret名だけを設定し、実行時に取得する。

注意点:

- `config.json`は生成物なのでGit管理しない。
- テストでは先にStackをsynthし、`config.json`を生成してからEdgeモジュールを読み込む。
- CDK tokenをそのままアセットへ書くとハッシュや解決順序が不安定になるため、安定した名前を使う。

### 2.3 Lambda@EdgeのVersionはすぐ削除できない

CloudFrontへ関連付けたLambdaの公開Versionはエッジリージョンへ複製される。新Versionへ切り替えた直後に旧Versionを削除しようとすると、レプリカが残っているためAWSに拒否される。

現在はLambda Versionへ`RemovalPolicy.RETAIN`を設定し、デプロイの失敗を避けている。その代わり、旧Versionが自動削除されず蓄積するため、将来的な棚卸しが必要である。

### 2.4 CloudFrontにはダミーoriginが必要だが、実通信先ではない

CDKのCloudFront Distributionにはorigin定義が必要なので`example.com`を設定している。しかし認証済みの通常リクエストでは、origin-request Lambda@Edgeがセッション固有のMicroVM endpointへoriginを差し替える。

ダミーoriginへ到達することを前提にしてはいけない。Edge処理の例外や未処理ルートがあると、意図せずダミーoriginへ向かう可能性があるため、認証・セッション分岐をテストする必要がある。

### 2.5 Lambda@Edgeのlogは1つのregionだけ見ればよいとは限らない

source Functionは`us-east-1`にあるが、Lambda@Edgeの実行logはviewerに近いregionへ分散し得る。東京側MicroVM用Log Groupや`us-east-1`のsource Functionだけを調べても、該当requestのlogが見つからない場合がある。

障害調査ではCloudFront request ID、時刻、実行regionを手掛かりにし、region横断のRunbookまたはlog集約を用意する。MicroVM専用Log Groupだけは1週間保持・削除保護・`RETAIN`だが、Edge複製先logの保持は現状一元管理していない。

## 3. IAMで実際に詰まった点

### 3.1 API入力のIDとIAM評価対象ARNは一致するとは限らない

`CreateMicrovmAuthToken`の入力は`microvmIdentifier`だが、IAM認可はMicroVMインスタンスARNではなく、元のMicroVM Image ARNに対して評価された。初期実装で`microvm:*`を許可しても失敗し、CloudFrontでは「関連Lambdaが無効、または必要な権限がない」という`503`に見えた。

現在は次のように設定している。

- `lambda:RunMicrovm`: 対象Image ARN
- `lambda:CreateMicrovmAuthToken`: 対象Image ARN
- `lambda:GetMicrovm`、`SuspendMicrovm`、`ResumeMicrovm`: Image ARNとアカウント内MicroVM ARN

教訓は、APIパラメータ名だけでIAM Resourceを推測せず、実際のエラーとAWS側の評価対象を確認することである。

### 3.2 `iam:PassRole`のConditionが実APIと合わない場合がある

初期実装では`iam:PassedToService=lambda.amazonaws.com`を付けたが、Lambda MicroVM API経由の評価と合わず失敗した。現在は渡せるRole ARNを`omp-cloud-ide-microvm-execution`の1つへ限定し、適合しないConditionは外している。

Conditionを付ければ常に安全になるわけではない。APIの実際の呼び出しコンテキストと一致しないConditionは、正当な処理だけを壊す。

### 3.3 MicroVM内の実行Roleは開発対象AWS権限と分離する

OMPはシェルを実行できるため、MicroVM実行Roleの権限は実質的にOMPから利用できる。現在の実行Roleは次に限定している。

- 認証状態用S3 prefixのobject取得・作成・削除と、必要なbucket-level list/get
- SSE-KMS利用に必要なEncrypt/Decrypt/GenerateDataKey/ReEncrypt/DescribeKey
- 専用CloudWatch Logsへの書き込み

AdministratorAccessを与えず、Image build Roleとruntime execution Roleも分離した。将来、開発対象AWSへアクセスさせる場合も、IDE基盤Roleへ権限を足し続けるのではなく、作業用の短命Roleや明示的なAssumeRole境界を検討すべきである。

### 3.4 Trust PolicyもSourceで絞る

build/runtime Roleは`lambda.amazonaws.com`をPrincipalとし、`aws:SourceAccount`とMicroVM Image ARNパターンを条件に入れている。これにより他アカウントからの利用は絞れるが、現在のSourceArnは同一アカウントの`microvm-image:*`であり、同一アカウント内の別Imageまでは排除しない。対象Image ARNへさらに限定できるかを確認する余地がある。

## 4. ブラウザ認証で得た知見

### 4.1 HTTP Basic認証のネイティブダイアログは埋め込みブラウザと相性がある

Chromeでは正常でも、Codex内蔵ブラウザではBasic認証ダイアログが一瞬表示されて閉じる挙動があった。ブラウザ実装・WebView・認証ダイアログの扱いに依存するため、ブラウザE2Eの入口として不安定だった。

対策として、Lambda@EdgeがHTMLログインフォームを返し、成功時に署名付きCookieを発行する方式へ変更した。Basic認証は非ブラウザのスモークチェック互換用として残している。

### 4.2 ログイン画面を開くだけでMicroVMを起動してはいけない

以前は認証後に`/`へ移動すると、`mvm-session`がないだけで新しいMicroVMを起動していた。これではログイン確認やブラウザ再訪だけでも課金対象のcomputeを開始し得る。

現在は次の境界を設けた。

- `GET /login`: フォーム表示のみ
- ログイン成功: `/session/select`へ移動するだけ
- `POST /session/select`かつ`action=new`: 初めて`RunMicrovm`

課金や状態変更を伴う操作は、明示的なPOST操作へ寄せるべきである。

### 4.3 CookieはHMAC署名・期限・属性を揃える

アクセスCookieはSecrets Managerのパスワードを鍵にHMAC-SHA256で署名し、期限改ざんを検出する。さらに、現在時刻から設定寿命を大きく超える未来期限も拒否する。

両Cookieに次を付けている。

- `Secure`
- `HttpOnly`
- `SameSite=Strict`
- 明示的な`Max-Age`

HTMLレスポンスには`Cache-Control: no-store`、CSP、`X-Content-Type-Options`を付ける。比較には`timingSafeEqual`を使う。

### 4.4 通常デプロイでパスワードは毎回変わらない

同一のSecrets Managerリソースを更新する通常デプロイでは、生成済みSecret値は維持される。Secretの置換、削除・再作成、明示的なローテーションを行った場合は変わる。

Edge側はパスワードを5分キャッシュするため、ローテーション直後にはエッジ実行環境ごとに短い移行時間があり得る。パスワードを署名鍵にも使っているため、ローテーション後は既存のアクセスCookieも無効になる。

### 4.5 現在の認証は「個人用共有パスワード」である

これはユーザーディレクトリ、MFA、監査可能な個人識別を持つ認証ではない。単一利用者の入口としては軽量だが、複数ユーザー化する場合はCognito/OIDCなどへ置き換えるべきである。

### 4.6 SameSite Cookieだけでは同一origin内の未信頼アプリを防げない

code-server、`/proxy/<port>/`で開く開発アプリ、`/session/select`、`/session/suspend`、`/session/resume`は同じCloudFront originを共有する。cloneしたアプリが同一origin上で任意のJavaScript/HTMLを実行できる場合、SameSite=Strictはそのアプリからの状態変更requestを防がない。

さらにEdgeは認証後も`omp-cloud-ide-auth`と`mvm-session`をrequestから除去せず、code-server originへ転送する。`HttpOnly`はbrowser JavaScriptからの読取りを防ぐが、origin serverへ届くCookie headerを隠さない。code-server proxyが内側backendへCookieを引き継ぐ場合、同一VMのserver-side appから値を取得できる可能性もある。

したがって現状は「MicroVM内で起動するWebアプリとcloneしたコードも信頼する」という前提を持つ。単純なCSRF tokenも同一originアプリがcontrol pageを読めるなら十分な境界にならない。根本策はIDE/proxy用hostnameとcontrol/auth用hostnameを分離し、状態変更Cookieをcontrol側だけへ限定することである。当面でも、Edgeで検証後にEdge専用Cookieだけをorigin転送前に除去し、proxy backendへのCookie転送をE2E確認する。Origin/Referer検証、再確認画面、rate limitも軽減策になる。

## 5. セッション管理と障害復旧の知見

### 5.1 `502`/`504`は即座に「MicroVMが消えた」と判定できない

SuspendからResume中、code-server起動途中、endpoint切り替え直後などでは、一時的な`502`/`504`が発生し得る。ここでCookieを消すと、生きている作業環境をブラウザから見失う。

origin-response Lambda@Edgeは、HTMLナビゲーションの`502`/`504`に対して次の処理だけを行う。

1. `mvm-session`を保持する。
2. `/session/select`へ戻す。
3. 一覧表示時に`GetMicrovm`で実状態を再確認する。

状態を破壊する前に、control planeのAPIを正とした再確認が必要である。

ただし現在の判定はpathを限定せず、`Accept: text/html`の`502`/`504`を対象とする。`/proxy/<port>/`の開発アプリ自身がHTML 502を返した場合もMicroVM障害と誤認して選択画面へ送る可能性がある。対象path、専用error marker、control planeでの状態確認などで判定を狭める余地がある。

### 5.2 DynamoDBレコードだけを信頼しない

DynamoDB TTL削除は即時ではない。MicroVMがTerminate済みでもレコードが残るため、セッション一覧では各`microvmId`を`GetMicrovm`で照合し、`TERMINATED`、`TERMINATING`、NotFoundを除外する。

一方、現在の一覧は`Scan Limit=25`であり、ページングしていない。これは「新しい25件」ではなくScanが返した任意の25件である。さらに各候補へ並列`GetMicrovm`を行うN+1構造なので、セッション数が増えると有効な候補の取りこぼし、Edge 30秒timeout、throttle、partial failureが問題になる。

また、`PENDING`や`UNKNOWN`を現状は接続可能候補として扱うが、`GetMicrovm`成功はendpointやcode-serverのreadyを保証しない。`stateReason`表示、bounded concurrency、retry/backoff、health pollingが必要である。

### 5.3 tokenは短命にしてEdgeで更新する

MicroVM proxy tokenは1時間、有効期限15分前から更新する。許可portはcode-serverの`8080`だけである。ブラウザへtokenを返さず、Lambda@Edgeが`X-aws-proxy-auth`を付与する。

DynamoDBにはtokenと期限を保存しているため、テーブルへのアクセス権限とログ出力を厳格にする必要がある。エラー時にもtoken値をログへ出さない。

Lambda@Edgeは分散して実行されるため、複数リクエストが同時にtoken更新する可能性がある。現在のDynamoDB更新には条件式やsingle-flight制御がなく、並行refreshの挙動は未検証である。またtoken更新失敗時は既存tokenで続行するため、既に失効していれば後段で失敗する。短いtoken寿命、条件付き更新、明示retry/errorへの改善余地がある。

### 5.4 UI表示用データも必ずescapeする

セッション選択画面はMicroVM ID、state、imageVersion、sessionIdをHTMLへ埋め込む。AWS由来またはDynamoDB由来の値であっても、`escapeHtml`を通して表示する。テストでは`microvm-<unsafe>`を使い、生HTMLとして出ないことを確認している。

### 5.5 新規セッション作成は現状トランザクションではない

`RunMicrovm`、`CreateMicrovmAuthToken`、DynamoDB `PutItem`は別々のAPI呼び出しである。Run成功後にtoken作成やPutが失敗すると、一覧から参照できないorphan MicroVMが残る可能性がある。

実装では、作成済みMicroVM IDを保持し、後続失敗時だけTerminateするcompensation、requestのidempotency、`ListMicrovms`とDynamoDBの定期reconciliationが必要になる。

## 6. OMP認証状態の永続化で得た知見

### 6.1 単一利用者・単一IDEならAuth Brokerなしでも成立する

OMPのClaude/Codex OAuth情報は`agent.db`へまとまる。個人用で同時実行を前提にしないなら、常駐Auth Brokerを追加するより、MicroVMのライフサイクルに合わせてS3へ退避する方が小さく保てる。

採用した処理:

- `/run`: S3から復元
- 5分ごと: 定期保存
- `/suspend`: 保存
- `/terminate`: 保存
- `persist-auth-state`: 手動保存

### 6.2 SQLiteファイルをそのままコピーしてはいけない

OMPが書き込み中の`agent.db`を単純に`cp`すると、不整合なスナップショットを保存する可能性がある。現在はPythonの`sqlite3.Connection.backup()`で一貫した一時DBを作り、その一時ファイルをS3へアップロードする。

復元時も対象へ直接ダウンロードせず、同じディレクトリの一時ファイルへ取得し、権限を`0600`へ変更してから`os.replace`で原子的に置換する。

### 6.3 `/terminate`だけに依存しない

異常終了、ホスト障害、タイムアウトなどではterminate hookが期待どおり完了しない可能性がある。そのため、定期保存と手動保存を併用して損失窓を小さくしている。

それでも最大5分程度の更新が失われる可能性はある。特にOAuth refresh直後や`gh auth login`直後は`persist-auth-state`を実行する方が安全である。

さらに、現在の保存・復元はベストエフォートである。保存側は各S3操作失敗をlogに記録して続行し、hookは最終的に200、手動`persist-auth-state`も全ファイルの保存失敗をexit codeで通知しない。復元側はS3 CLIのnon-zeroをskipして復元件数だけをlogに残し、subprocess timeoutなどの例外時はhookが200を返せない可能性がある。1回のAWS CLI timeoutは25秒、3ファイルを逐次処理するため最大75秒超になり得るが、`/run`は30秒、`/suspend`と`/terminate`は45秒である。定期syncが同じlockを保持していれば待ち時間も加わる。

従って「hookが200になった」ことを「認証状態が確実に保存された」と解釈してはいけない。全体deadline、必須ファイル失敗時のnon-2xx/非zero終了、last-success表示、lock優先制御が必要である。

### 6.4 同時に複数VMを使うと「最後の書き込みが勝つ」

現在はすべてのMicroVMが同じS3 keyへ書き込む。複数VMでOAuth tokenがrefreshされると、後から保存したVMが他方の新しい状態を上書きする可能性がある。

単一利用者でも複数セッションを同時に開けるようになったため、この点は重要な改善候補である。対策候補は次のとおり。

- 原則1セッションに制限する。
- S3 keyをセッション別に分け、どれを正とするか明示する。
- ETag/VersionIdによる楽観ロックを入れる。
- 認証更新を1か所に集約するAuth Brokerへ移行する。

### 6.5 S3のVersioningとKMSは復旧余地を作る

認証状態BucketはKMS暗号化、公開遮断、SSL必須、Versioning有効、`RETAIN`である。誤上書き時に過去Versionから戻せる余地はあるが、復元手順はまだ自動化していない。

ただしruntime Execution Roleは`DeleteObject*`も持つため、Versioningは通常の上書き事故への復旧余地であり、同Roleを使った明示的なVersion削除から過去Versionを守る境界ではない。Object Lock、別backup account、削除権限の分離が必要なら追加設計する。

`destroy`してもBucketとKMS Keyは残る。これは意図した安全策だが、不要になった際はVersionを含めて手動で廃棄する必要がある。

現在は変更検知をせず、存在する最大3ファイルを5分ごとに再uploadする。総寿命8時間の1台では定期syncだけで最大約288 object versions、1日を3台で連続利用すれば約864 versions/日が増え得る。Suspend、Terminate、手動保存分は別途加算される。noncurrent versionのlifecycle ruleもないため、hash/mtimeによる未変更skipと、復旧要件に応じた旧Version保持期間が必要である。

## 7. OMP・GitHub・リモートOAuthの注意点

### 7.1 OAuthの`localhost` callbackとcode-server port forwardingは別物

OMPのOAuthフローは一時的に`localhost` callback listenerを開くことがある。code-serverが「port 1455 is available」と表示しても、`/proxy/1455/`がOAuth providerの固定redirect URIと同じになるわけではない。

また、callback listenerが期待するpathとcode-server proxyのbase pathが一致しなければ`not found`になる。リモート環境では、providerが案内するauthorization codeまたは最終redirect URLをOMPへ貼り戻すフローを使う必要がある場合がある。

### 7.2 GitHub認証は通常GitHubのOAuthを使い、PATを前提にしない

現在は次のフローを採用している。

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
persist-auth-state
```

`hosts.yml`はS3へ保存されるため、tokenをDocker ImageやGitへ含めない。Git credential helperはシステム設定で`gh auth git-credential`へ向けている。

### 7.3 OMPの`yolo`設定はOSレベルのsandboxではない

`tools.approvalMode: yolo`により通常操作の承認回数を減らしているが、これは操作を安全化する仕組みではない。`rm -rf *`と`git push --force*`をOMP設定でdenyしていても、パターン回避、別コマンド、子プロセスまでOSとして禁止するものではない。code-server設定ではWorkspace Trustも無効化されている。

現在の隔離境界は次である。

- MicroVMによる隔離
- 非root UID 1000
- 最小権限IAM Role
- 永続対象の限定
- Gitによる成果物管理

これらはAWSホストや他MicroVM、広いAWSアカウント権限を守る一方、同一MicroVM内のsecretを未信頼コードから隔離しない。cloneしたコード、dependency install script、VS Code extension、OMPは同じUID 1000で動き、`agent.db`、GitHub `hosts.yml`、実行Role資格情報へアクセスでき、`INTERNET_EGRESS`で外部送信も可能である。

従って現状は利用者、OMP/provider、clone先repositoryと実行する依存スクリプトを信頼する単一ユーザー環境である。未知repoでは実行前にコードを確認し、必要ならWorkspace Trustを再有効化する。より強い分離が必要なら、credentialをBroker/別UIDへ移す、egress proxy/allowlistを使う、未信頼コード専用のcredential-free Image/Sessionを分ける。

### 7.4 モデルIDとprovider仕様は変わり得る

OMPのmodel roleはImage内へ固定しているが、provider側のモデル名や利用条件は変わり得る。Image更新時には`omp models --kind chat`などで有効なIDを再確認し、設定だけを古いまま残さない。

## 8. ARM64 ImageとBrowser E2Eのハマりどころ

### 8.1 Google Chrome for TestingはLinux arm64をそのまま配布しない

MicroVM ImageはARM64である。OMPのPuppeteer機能に通常の自動ダウンロードを任せると、対応するLinux arm64 Chromeを取得できず、初回E2Eが失敗する。

現在は`@sparticuz/chromium-min`とSparticuzのarm64 packを使い、Amazon Linux 2023向けChromiumをImage build時に展開している。

必要な環境変数:

- `PUPPETEER_EXECUTABLE_PATH=/opt/chromium/chromium`
- `FONTCONFIG_PATH=/opt/chromium/fonts`
- `LD_LIBRARY_PATH=/opt/chromium/al2023/lib:/opt/chromium`

packはSHA-256を固定し、build時に実際に`chromium --version`を実行して検証する。

### 8.2 Architectureごとの配布形式を確認する

code-server、Node.js、Bun、GitHub CLI、AWS CLI、uv、ripgrepはすべてarm64/aarch64向け成果物を選ぶ必要がある。x86_64用バイナリが1つ混ざるとImage build時または起動時に`exec format error`になる。

### 8.3 version pinだけでなくchecksumも必要

主要なtop-levelツールはversion固定しているが、完全再現可能ではない。現在checksum検証しているのはripgrepとChromium packであり、他の直接ダウンロード成果物には未実装である。`dnf` package、VS Code extension、base imageの実体、OMPのtransitive dependencyは完全固定されていない。Edge SDKはlockfileと`npm ci`で現在解決結果を固定しているが、manifestは一部caret rangeである。

version固定は再現性を上げるが、配布物改ざんや同一タグ差し替えへの対策としてはchecksumまたは署名検証が必要である。

## 9. code-serverとImage構築の知見

### 9.1 code-server自身の認証を無効にするなら前段を唯一の入口にする

code-serverは`--auth none`で起動する。これはCloudFrontログインとMicroVM proxy tokenが必ず前段にあることを前提としている。

MicroVM endpointはport 8080に限定された短命tokenが必要で、ブラウザへtokenを露出しない。将来別のingress経路を追加する際は、`--auth none`のまま公開経路を増やしてはいけない。

### 9.2 非root化は後付けではなくImageの所有権設計とセット

元サンプルでは`vscode`が実質UID 0だった。現在はUID/GID 1000を作り、`/home/vscode`配下を所有させてから`USER vscode`で起動する。

非root化すると、extension、OMP設定、workspace、SQLite、GitHub設定の書き込み権限をすべて合わせる必要がある。単に`USER`行を足すだけでは起動後に権限エラーになる。

### 9.3 起動時downloadを減らす

最大8時間の使い捨て環境では、毎回ツールを入れるよりImageに含める方が起動時間と再現性に優れる。code-server、OMP、Node、Bun、Python、uv、GitHub CLI、AWS CLI、language server、Chromium、VS Code extensionを事前導入している。

プロジェクト固有依存だけを起動後に導入する。

### 9.4 新規ファイルの追跡漏れはImage機能欠落につながる

Suspendボタン用extensionの`package.json`を追加した際、実装本体`extension.js`が最初のコミットに含まれていなかった。Dockerの`COPY`対象ディレクトリにファイルがないと、Image buildは通ってもextensionが動かない可能性がある。

対策:

- commit前に`git status --short`を見る。
- テストで`extension.js`の存在と重要文字列を確認する。
- Docker build contextに実際に入るファイル一覧を意識する。

### 9.5 Image内へ環境固有URLを固定すると再作成・複数環境で壊れる

現在、code-server設定とcontrol extensionのdefault URLには特定CloudFront DistributionのURLが固定されている。Distributionを再作成した場合やstaging/prodを並行展開した場合、Suspendボタンが旧環境を開く。

control URLはdeploy時にImageへ焼き直すより、現在のbrowser originから相対URLで導出するか、起動時設定として注入すべきである。E2EでもCDK OutputのDistribution URLとcontrol URLの一致を確認する。

### 9.6 lifecycle payloadとResume処理を「将来使う想定」のまま放置しない

Edgeはrun hook payloadへ`sessionId`を渡すが、hook側は`microvmId`を探しており、現在どちらも状態管理に使われていない。また`/resume` hookは即時200を返すだけで、credential refresh、S3到達、code-server health、network connectionを再確認しない。

payload schemaを揃えてsession別ログや競合制御へ使うか、不要なら削除する。Resume時に再確立すべき依存関係も明示する。

## 10. cdkd・CDK・AWS SSOの注意点

### 10.1 このプロジェクトは標準CDK deployではなくcdkdを通常経路にしている

主要コマンドは次のとおり。

```bash
npm run synth       # cdkd synth
npm run diff        # cdkd diff --all
npm run deploy      # cdkd deploy --all --full-wait
```

`cdkd`はこの個人開発環境では高速なdev/testデプロイ手段として採用している。通常のCloudFormation execution roleへ任せる運用とは異なり、実行中のAWS資格情報に直接必要権限が必要である。

### 10.2 `--full-wait`を外すと「完了したように見える」問題が起きる

MicroVM Image buildとCloudFront Distribution更新は時間がかかる。デプロイコマンドがリソース安定前に戻ると、古いEdge Versionと新しいコードが混在する状態でE2Eを始める危険がある。

通常デプロイは`--full-wait`を付け、CloudFrontが反映済みになってからテストする。

### 10.3 AWS CLIでは有効でもNode SDKからSSO期限切れになることがある

今回、`aws sts get-caller-identity --profile <aws-profile>`は成功する一方、`cdkd`内部のNode資格情報プロバイダが`Token is expired`を返す事象があった。

回避策は、AWS CLIで現在の一時資格情報を環境変数形式へexportし、古いprofile解決を使わせないことだった。

```bash
eval "$(aws configure export-credentials --profile <aws-profile> --format env)"
unset AWS_PROFILE
AWS_REGION=ap-northeast-1 npm run diff
```

注意:

- export結果をログへ出さない。
- 長期保存しない。
- まず`aws sso login --profile <aws-profile>`と`aws sts get-caller-identity`を確認する。

### 10.4 synth前にアカウントを確定する

`config.ts`は`CDK_DEFAULT_ACCOUNT`がなければ停止する。アカウント未確定のままARNやBucket名を合成しないためのfail-fastである。

テストでは固定のテストアカウントをStack propsへ渡す。実デプロイでは認証済みアカウントからcdkd/CDKが値を設定する。

### 10.5 CDK差分でstateful resourceの置換を必ず見る

S3、KMS、DynamoDB、MicroVM ImageのLogical ID変更はデータや接続へ影響する。デプロイ前に`npm run diff`を実行し、今回のようなEdgeコード変更でMicroVM Stackに差分がないことを確認する。

### 10.6 現在のIaCはそのままではstaging/prodを並行展開できない

Stack、Image、IAM Role、DynamoDB table、Secretなどの名前が固定で、control extensionにも特定Distribution URLが固定されている。同一accountへ2環境をdeployすると名前衝突または誤ったcontrol先が生じる。

さらにsynthは`artifact/edge/config.json`という共有source pathへ設定を書き出すため、同じcheckoutで環境別synthを並列実行するとraceになり得る。GitHub Actions化の前に、環境suffix/別account、生成物用一時directory、control URLのruntime注入、PR synth用の明示account IDを設計する。

`cdkd`は実行資格情報でAWS APIを直接呼ぶため、CIでは環境別GitHub OIDC Roleとpermission boundaryを用意し、静的AWS keyを置かない。

## 11. テストで得た知見

### 11.1 IaCのテストはリソース数だけでなくセキュリティ契約を見る

現在のJestテストは次を確認する。

- S3のKMS暗号化、Versioning、Public Access Block
- MicroVM lifecycle hook
- Lambda@Edge関連付けとsecurity headers
- IAMのResource範囲
- HTML escape、CSP、Cookie署名と期限
- Suspend/ResumeのPOST制限
- 一時的`502`でCookieを削除しないこと
- OMP/Chromium/version pin/非root設定
- control extensionの追跡とHTTPS制約

### 11.2 CDK assertionの配列順に注意する

CDKは複数IAM actionを1つのStatementへまとめる。`Match.arrayWith`は期待要素の順序に影響されるため、生成されたCloudFormationのStatement順とテストの並びが違うだけで失敗した。

テスト失敗時は実装バグと決めつけず、synth済みtemplateの実際の形を確認する。

### 11.3 Unit testだけではブラウザ・CloudFront・MicroVMの組合せを保証できない

セッション選択修正後は、実際のブラウザで次をE2E確認した。

1. 新規ブラウザコンテキストでログイン
2. 既存MicroVMが一覧へ表示されることを確認
3. テスト専用MicroVMを新規作成
4. code-serverの`.monaco-workbench`表示を確認
5. 明示Suspend
6. 一覧から`Resume and connect`
7. 同じsession IDでcode-serverへ復帰
8. テスト専用MicroVMだけをTerminateし、DynamoDB行を削除

既存MicroVM IDを事前にsnapshotし、テストで作ったIDとの差分だけをcleanupすることが重要である。

### 11.4 SecretをE2Eログへ出さない

ブラウザE2EのパスワードはSecrets Managerの値を直接取得・表示せず、`asm-exec`で子プロセスの環境変数へ動的注入した。スクリーンショット、console、テスト結果へパスワードを出さない。

### 11.5 Browser runtimeがあることとOMP Browser E2Eが通ることは別である

Image build時の`chromium --version`と設定ファイルのassertionは、binaryと設定の存在を示すだけである。OMPが実際にbrowser processを起動し、`localhost`へ接続し、DOM操作とscreenshotを完了できることまでは保証しない。

Image/provider更新時は、MicroVM内で小さなtest appを起動し、OMPの`browser.open`→操作→console/network確認→screenshotまでをdeployed E2Eとして通す必要がある。

## 12. 運用・コスト面の気付き

### 12.1 エディタを開いて通信が続けばRUNNING時間が延びる

「ブラウザを操作していない」ことと「endpointがアイドル」は一致しない。作業終了時はステータスバーの`Suspend Cloud IDE`を使う方が確実である。

### 12.2 ログイン画面やセッション選択画面だけでは新規computeを起動しない

現在、明示的に`Start a new MicroVM`を押すまで`RunMicrovm`は呼ばれない。利用者認証の確認だけでcompute課金を開始しない設計になっている。

### 12.3 Suspendは無償化ではなく課金形態の変更である

Suspend後は実行computeが止まるが、snapshot storageやsnapshot read/writeなどの費用要素は残り得る。`maximumDurationInSeconds`はSUSPENDEDを含む総寿命なので、起動から8時間を超えて保持できない。

### 12.4 CloudFront/Lambda@Edgeの反映には時間差がある

Edgeデプロイ直後にテストすると旧Versionが見える可能性がある。`cdkd deploy --full-wait`完了後にE2Eし、それでも異常ならCloudFront statusと関連Lambda Versionを確認する。

### 12.5 課金箇所はMicroVM computeだけではない

単価を固定値で文書化せず、少なくとも次の課金トリガーを監視する。

| 項目 | 主なトリガー |
| --- | --- |
| MicroVM | baseline/burst compute、Image storage、Suspend snapshot、start/resume read、suspend write |
| CloudFront/Lambda@Edge | request、data transfer、Edge invocation/実行時間 |
| DynamoDB | Get/Put/Update/Scan |
| S3/KMS | 5分sync、Object Version、KMS request、storage |
| Secrets Manager | Secret保管とAPI call |
| CloudWatch Logs | 取込、保持、検索 |

AWS Budgets、Cost Anomaly Detection、Cost Explorer用tag/配賦を追加し、実測で支配項を判断する。

一覧のN+1 `GetMicrovm`はDynamoDB課金ではないが、Lambda MicroVM control-plane APIのlatency、throttle、Edge実行時間を増やす。

### 12.6 destroy時の保持方針は非対称である

S3、KMS、MicroVM専用Log Group、Lambda@Edge VersionはRETAINだが、DynamoDB session tableとアクセスパスワードSecretはDeleteである。`cdkd destroy --all`やLogical ID置換をすると、生存MicroVMがあってもDDB関連付けを失い、Secret再作成でパスワード変更とアクセスCookie全失効が起こり得る。

destroy前にはセッションcleanup順序を決め、DynamoDB PITRやSecret RETAINが必要か判断する。

### 12.7 定期cleanupしないresourceはquotaと費用になる

Lambda@Edgeの公開Versionは関連解除直後に消せないため`RETAIN`、S3はVersioning+`RETAIN`、KMSも`RETAIN`である。安全側の設定だが、旧Lambda Version、noncurrent S3 Version、不要Keyを放置するとquota、storage、KMS費用が積み上がる。

保持することと永久放置は別である。関連解除済みVersionの棚卸し、S3 lifecycle、最終利用時刻、削除前backupを含むcleanup Runbookを用意する。

## 13. 既知の注意点チェックリスト

変更前後に最低限、次を確認する。

### Image変更

- [ ] 取得物がARM64対応か
- [ ] versionが固定されているか
- [ ] checksumまたは署名を検証できるか
- [ ] `USER vscode`後に必要ファイルへ書き込めるか
- [ ] `ready` hookがcode-serverの`/healthz`を確認できるか
- [ ] OMP browserが`/opt/chromium/chromium`を起動できるか

### Edge・セッション変更

- [ ] 未認証GETが`/login`へ行くか
- [ ] ログインだけで`RunMicrovm`しないか
- [ ] 新規作成がPOSTの明示操作か
- [ ] existing sessionを再選択できるか
- [ ] Suspend前に`paused=true`になるか
- [ ] `502`/`504`で生存セッションCookieを消していないか
- [ ] `/proxy/<port>/`アプリのHTML 502を誤判定していないか
- [ ] HTMLへ埋め込む値をescapeしているか
- [ ] tokenやendpointをブラウザへ返していないか
- [ ] 新規起動の途中失敗でorphan MicroVMを残さないか
- [ ] 同一originの未信頼アプリから制御POSTできない設計か

### IaC・デプロイ

- [ ] `npm run build`
- [ ] `npm run lint`
- [ ] `npm test -- --runInBand`
- [ ] `npm run diff`
- [ ] stateful resourceの置換がないか
- [ ] Secret/DDBの削除とRETAIN resourceの残存を確認したか
- [ ] `npm run deploy`が`--full-wait`で完了したか
- [ ] 実ブラウザE2Eが通ったか
- [ ] テスト用MicroVM/DynamoDBレコードだけをcleanupしたか
- [ ] `git status --short`で新規ファイルの追跡漏れがないか

## 14. 関連資料

- [セッション管理の詳細](session-management.md)
- [現状の実装範囲と改善案](implementation-status-and-roadmap.md)
- [設計思想・構成・IaC・外部モジュール](architecture-and-design.md)
- [Cloud IDEの利用・デプロイ手順](../code-server/README.md)
