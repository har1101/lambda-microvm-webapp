# OMP Cloud IDE の接続・セッション管理

この文書は、ブラウザからLambda MicroVM内のcode-serverへ接続する仕組みと、MicroVMセッションの新規作成・再接続・一時停止・終了の状態管理を説明する。

## 全体構成

```text
Browser
  │ HTTPS / WebSocket
  ▼
CloudFront
  │
  ├─ Lambda@Edge (origin-request)
  │    ├─ ログイン認証
  │    ├─ セッション選択
  │    ├─ DynamoDBから接続先を取得
  │    └─ X-aws-proxy-authを付加
  │
  ▼ HTTPS :443
AWS管理のLambda MicroVM endpoint
  │ 認証トークンを検証し、許可されたport 8080へ転送
  ▼
Lambda MicroVM
  └─ code-server :8080
       ├─ VS Code UI / WebSocket
       └─ /proxy/<port>/ → MicroVM内のlocalhost:<port>
```

CloudFrontのCDK定義にはダミーoriginとして`example.com`が必要だが、実際の認証済みリクエストではLambda@Edgeがoriginをセッション固有のMicroVM endpointへ置き換える。ブラウザへMicroVM endpointや`X-aws-proxy-auth`を渡さず、CloudFrontを唯一の入口にしている。

## 2種類のCookie

このシステムでは目的が異なる2種類のCookieを使う。

| Cookie | 目的 | 内容 |
| --- | --- | --- |
| `omp-cloud-ide-auth` | Cloud IDE利用者の認証 | 有効期限とHMAC署名。Secrets Managerのパスワードから署名する |
| `mvm-session` | ブラウザとMicroVMセッションの関連付け | DynamoDBの`sessionId`を指すランダムUUID |

どちらも`Secure`、`HttpOnly`、`SameSite=Strict`で発行する。`mvm-session`だけでは接続できず、有効な`omp-cloud-ide-auth`も必要になる。

## DynamoDBのセッションレコード

`omp-cloud-ide-sessions`テーブルは`sessionId`をパーティションキーとして、次の情報を保持する。

```text
sessionId       ブラウザCookieが参照するUUID
microvmId       Lambda MicroVM ID
endpoint        AWS管理のMicroVM HTTPS endpoint
token           X-aws-proxy-authの値
tokenExpiry     proxy tokenの失効時刻
paused          明示的な一時停止状態
createdAt       セッション作成時刻
ttl             DynamoDBレコードの自動削除時刻
```

セッション選択画面では`token`や`endpoint`を表示しない。DynamoDBの全ページを25件ずつScanし、各`microvmId`を`GetMicrovm`で照合する。`TERMINATING`は候補から除外し、`TERMINATED`または存在しないMicroVMの行は対象ID一致を条件に削除する。`ListMicrovms`でも対象Imageの全ページを照合し、セッション行がない稼働中MicroVMを「Untracked MicroVMs」として表示する。

## ログインから接続まで

### 1. ログイン

`GET /login`はログインフォームだけを返し、MicroVMを起動しない。`POST /login`が成功すると`omp-cloud-ide-auth`を発行し、`/session/select`へ移動する。

### 2. セッション選択

`GET /session/select`はDynamoDBを25件ずつ全ページScanし、各候補を`GetMicrovm`で照合して状態付きで一覧表示する。

- `RUNNING`: `Connect`
- `SUSPENDED`または明示停止中: `Resume and connect`
- `SUSPENDING`: 完了待ちを案内
- `PENDING`/`UNKNOWN`: 現状は接続操作を表示するが、endpoint/code-serverのreadyは保証されない
- 候補がない場合: `Start a new MicroVM`

### 3-A. 新規セッション

`POST /session/select`の`action=new`には画面に埋め込んだrequest UUIDを付ける。Lambda@EdgeはまずDynamoDBへ条件付き`PutItem`で短命の起動claimを確保し、同じフォームの二重送信では2台目を起動しない。次に`RunMicrovm`を実行し、port 8080だけを許可したauth tokenを作成してセッション行を保存し、最後に`mvm-session`を発行する。旧`/session/start`は起動せず選択画面へ戻す。

この操作はtransactionではない。`RunMicrovm`後のtoken作成や行保存が失敗した場合は、作成したIDに対して`TerminateMicrovm`を要求する。補償失敗や不明な結果で残った稼働中MicroVMは、選択画面の`ListMicrovms`照合で「Untracked MicroVMs」へ表示する。ただし起動中の一時的な不整合と区別できないため、untrackedの画面内Terminateは設けない。IDと状態を確認し、AWS API/Consoleで手動終了する。起動claimは15分のTTLを持ち、行が完成するまでは接続候補にならない。

### 3-B. 既存セッション

`action=attach`と`sessionId`を送ると、Lambda@EdgeはDynamoDBを再取得し、`GetMicrovm`で実在と状態を検証する。

- `RUNNING`: `mvm-session`を再発行してエディタへ移動
- `SUSPENDED`: `ResumeMicrovm`を呼び、Cookieを再発行して再開待ち画面を返す
- `SUSPENDING`: 完了を待って再試行するよう表示
- `TERMINATED`: 復旧不能として新規セッションを案内

既存セッションを選ぶ操作によって、ブラウザCookieを失ってもDynamoDBに残っているMicroVMへ安全に再関連付けできる。

## CloudFrontからcode-serverへの転送

通常リクエストではLambda@Edgeが次を行う。

1. `omp-cloud-ide-auth`を検証する。
2. `mvm-session`をキーにDynamoDBを読む。
3. proxy tokenの期限が近ければ`CreateMicrovmAuthToken`で更新する。
4. CloudFront originをDynamoDBの`endpoint`へ変更する。
5. `Host`、`Origin`、`X-aws-proxy-auth`をMicroVM endpoint用に設定する。
6. Edge専用のaccess/session Cookieだけを`Cookie` headerから除去し、code-server固有Cookieを保持する。
7. HTTPSでAWS管理endpointへ転送する。

access/session Cookieは認証判定には使うが、code-server originには渡さない。`HttpOnly`だけではorigin serverからCookieを隠せないためである。ただし同一CloudFront originの`/proxy/<port>/`アプリは制御画面へリクエストでき、VM内の同一UIDのコードは認証ファイルも読める。Cookie stripはこれらを隔離する仕組みではない。

MicroVM内ではcode-serverが`0.0.0.0:8080`で待ち受け、独自認証は無効になっている。手前のCloudFrontログインとMicroVM proxy tokenの二段階を通らなければ到達できないためである。

code-serverの`/proxy/3000/`は、MicroVMの3000番を外部公開しているわけではない。外部通信は常にport 8080のcode-serverを通り、code-serverが内部の`localhost:3000`へ中継する。

## Suspend、Resume、Terminate

### 明示Suspend

`POST /session/suspend`では、先にDynamoDBの`paused=true`を保存してから`SuspendMicrovm`を呼ぶ。これにより、code-serverのWebSocket再接続が意図せずMicroVMを自動Resumeすることを防ぐ。

SuspendするとMicroVM内の`/suspend` hookが呼ばれ、OMPとGitHubの認証状態をS3へ保存する(後述の「Suspend/Terminate時の認証状態保存」)。

### Resume

`POST /session/resume`またはセッション選択画面の`Resume and connect`が`ResumeMicrovm`を呼ぶ。Resume後は`paused=false`へ戻す。MicroVM内の`/resume` hookは即時200を返すだけで、5分ごとの定期保存はResume後もそのまま続く。

### 明示Terminate

セッション一覧または現在の制御画面から`Terminate permanently...`を押すと、対象MicroVM ID・状態を`GetMicrovm`で確認した上で確認画面が出る。対象Image ARNを再検証し、セッション行のID変更も拒否する。MicroVM ID全文を入力してPOSTすると、DynamoDBに`terminationPending=true`と`paused=true`を書き、エディタ通信と再接続を止めてから`TerminateMicrovm`を要求する。受理が確認できた場合、現在選択中のセッションなら`mvm-session`を失効させ、access Cookieは残す。

APIの応答が失われても終了が受理された可能性があるので、結果が不明な場合も通信遮断を維持し、選択画面から同じ対象の再試行を案内する。`TERMINATING`中はDynamoDB行を保持し、`TERMINATED`またはNotFoundを確認した時点で`microvmId`一致を条件にその行だけを削除する。選択画面を再表示した際にも終了済み行を掃除する。`/terminate` hookは認証状態を保存するがfail-openであり、保存成功を保証しない。終了前にstatus barを確認し、作業をcommit/pushする。

#### 終了前に残すものと寿命

TerminateされたMicroVMのローカルディスクとRAM状態は戻せない。S3へ保存されるのはOMPとGitHubの認証ファイルだけで、`/home/vscode/workspace`は保存対象ではない。未完了の実装を残す場合は、Terminate前にGitへcommit・pushする必要がある。

`maximumDurationInSeconds=28800`はRUNNINGとSUSPENDEDを合わせたMicroVMの総寿命である。Suspend保持の設定が別に8時間あっても、起動から8時間を超えて同じMicroVMへ戻れるという意味ではない。

### Suspend/Terminate時の認証状態保存

`/suspend`と`/terminate` hookは、`lifecycle.py`が40秒のdeadline(Image側のhook timeoutは45秒)内でOMPとGitHubの認証ファイルをS3へ保存する。各AWS CLI呼び出しは`min(25秒, 残り時間)`で打ち切るため、S3/KMSが応答しなくてもhookがtimeoutを超えて止まることはない。

`/run`では3ファイルの`get-object`を共通25秒deadline内で並列実行する。旧実装の逐次実行では最初の取得が遅れると残り2件が`DeadlineExceeded`になった。ファイルごとの一時ファイル・原子的置換、`NoSuchKey`と実際の失敗の区別は変えていない。

- sha256が前回保存と同じファイルは送らない。
- 保存は`aws s3api put-object`で、`/run`の復元時に記録したETagと一致するときだけ書くETag楽観ロックである(S3に未作成なら`--if-none-match '*'`)。別MicroVMがより新しい状態を書いていれば上書きせず、`認証競合`として記録する。
- `/run`で復元に失敗したkeyと競合したkeyは自動保存しない。未ログインのファイルでS3の正常な状態を上書きしないためである。
- hookはfail-openで常に200を返し、失敗してもSuspend/Terminateを止めない。代わりに結果を`~/.cache/omp-cloud-ide/auth-sync.json`へ記録する。
- 定期保存が実行中でも、hookが待っていれば定期保存のAWS呼び出しを中断してlockを譲らせる。

記録した結果はcode-serverのstatus barに`認証 N分前`、`認証保存失敗`、`認証復元失敗`、`認証競合`として表示され、クリックすると`persist-auth-state`で手動保存する。実行中MicroVMのstdout(`[lifecycle]`行)はCloudWatch Logsへ届かないため、保存結果はログではなくstatus barか`auth-sync.json`で確認する。Terminate後は確認できないので、Terminate前にstatus barを確認する。

2026-09-25の新規VM E2Eでは、1台で`omp/install-id`と`github/hosts.yml`が`認証復元失敗`になった。先頭取得を遅延させる回帰テストで同じ並びを再現し、並列化後の新規VM 2台では3ファイルすべてが復元された。元のVMの失敗コードは未取得なので、S3/KMS固有障害まで解消したとは断定しない。利用開始時にstatus barを確認し、実際に失敗したVMでは必要なら再ログイン後に明示的に`persist-auth-state`を実行する。

### 残り寿命の表示

Edgeは`RunMicrovm`直前に`expiresAt = now + 8時間`を計算して`runHookPayload`へ入れ、`/run` hookがMicroVM内の`~/.cache/omp-cloud-ide/session.json`へ記録する。実際の期限より遅くならないよう、`RunMicrovm`より前の時刻で計算している。VMは自分の起動時刻を知る手段を持たないため、期限はEdgeから渡す。`runHookPayload`には`sessionId`も入るが、bearer Cookie値なのでVM内へは保存しない。

code-serverのstatus barはこの値から`残り H:MM`を表示し、残り30分以下で黄色、10分以下で赤にする。残り60/15/5分を過ぎるたびに1回だけ通知し、commit/pushを促す(遅れて開いた場合は最も近い閾値だけ)。クリックするとSource Controlを開く。MicroVMの時計はNTP同期されないため、S3 regional endpointの`Date` headerで毎分とwindow focus時に補正する。実機では3分のSuspend→Resume後も補正は-1秒で、ゲスト時計の遅れは観測されなかった。

セッション選択画面は`GetMicrovm`の`startedAt + maximumDurationInSeconds`から`Ends ... (Xh Ym left)`を表示する。どちらもこの機能のdeploy後に起動したMicroVMから有効で、それ以前のVMは`残り時間不明`になる。

## 今回修正した障害の原因

以前のorigin-response Lambda@Edgeは、MicroVM originがHTMLナビゲーションに対して一時的に`502`または`504`を返すと、`mvm-session` Cookieを即座に削除して`/session/start`へ送っていた。

Suspendからの自動Resume中にも短時間の`502/504`が発生し得るため、MicroVMとDynamoDBレコードが生きているのに、ブラウザだけが関連付けを失うことがあった。さらに`/session/start`は新規MicroVMを開始するため、元の作業環境が孤立して見える状態になっていた。

修正後は次の挙動になる。

1. `502/504`でも`mvm-session`を削除しない。
2. `/session/select`へ戻す。
3. 一覧でMicroVMの実状態を再確認する。
4. ユーザーが既存セッションへの再接続または新規開始を明示的に選ぶ。

## セキュリティ上の境界

- セッション選択画面は有効なログインCookieがなければ表示できない。
- `sessionId`は現状、hexとhyphenからなる36文字の簡易形式を検証し、DynamoDBとLambda MicroVM APIの両方で再確認する。UUIDのversion/variantやhyphen位置までの厳密検証ではない。
- proxy tokenはブラウザへ返さず、Lambda@Edgeだけがリクエストヘッダーへ注入する。
- MicroVM auth tokenはport 8080だけを許可する。
- CloudFrontキャッシュは無効で、ログイン・セッション画面には`Cache-Control: no-store`を付ける。
- セッション選択画面はCSPで外部スクリプトと外部送信を禁止する。

ただし、IDE、`/proxy/<port>/`、login/selector/control routeは同じCloudFront originである。`SameSite=Strict`は外部siteからの一般的なCSRFには有効だが、同一originのproxyアプリから状態変更routeを隔離しない。現状はproxy先アプリも信頼する個人用環境という境界である。

## 制約

- 現在は単一ユーザー用なので、選択画面はDynamoDBと`ListMicrovms`をページングして全件確認する。`GetMicrovm`は候補の数だけ並列実行されるため、件数が多いとEdgeの30秒timeoutやAPI throttlingの恐れがある。
- DynamoDB TTL削除は即時ではないが、終了済みMicroVMの行は一覧照合時に条件付きで削除する。`TERMINATING`の行は終了確認まで保持する。
- MicroVMのRUNNING+SUSPENDED総寿命8時間を超えてTerminateされた場合は再接続できない。
- セッション選択はMicroVMのローカル作業状態を永続化する機能ではない。生存している同一MicroVMへ接続し直す機能である。
- proxy token更新は分散Edgeからの条件なし更新であり、並行refreshの競合は未検証である。
- origin-responseはHTMLの`502/504`をpath非限定でselectorへ戻すため、proxy先アプリ自身のHTMLエラーをMicroVM障害と誤認し得る。
- Suspend/Terminate時のS3保存はfail-openで、失敗してもSuspend/Terminateは止まらない。結果はVM内の`auth-sync.json`とstatus barにしか残らず、セッション選択画面やDynamoDBには表示されない。
- 手動保存がlockを握っている間(最大約2分)にSuspendされると、`/suspend` hookは待ちきれずに保存をskipし得る。
- `認証競合`になったMicroVMは、別MicroVMが保存した新しい認証を取り込み直せない。ログインし直すか、新規MicroVMを起動して復元する。このVMの認証を正とする場合だけ`persist-auth-state --overwrite`で上書きする。
- ETag楽観ロック導入前のImageで起動したMicroVMは、条件なしでS3へ書く。
