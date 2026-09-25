# OMP Cloud IDE の接続・セッション管理

この文書は、ブラウザからLambda MicroVM内のcode-serverへ接続する仕組みと、MicroVMセッションを新規作成・再接続・一時停止する際の状態管理を説明する。

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

セッション選択画面では`token`や`endpoint`を表示しない。DynamoDBからIDと表示用メタデータだけをScanし、各`microvmId`を`GetMicrovm`で照合する。`TERMINATED`、`TERMINATING`、存在しないMicroVMは候補から除外する。

## ログインから接続まで

### 1. ログイン

`GET /login`はログインフォームだけを返し、MicroVMを起動しない。`POST /login`が成功すると`omp-cloud-ide-auth`を発行し、`/session/select`へ移動する。

### 2. セッション選択

`GET /session/select`はDynamoDBを任意の最大25件Scanし、各候補を`GetMicrovm`で照合して状態付きで一覧表示する。

- `RUNNING`: `Connect`
- `SUSPENDED`または明示停止中: `Resume and connect`
- `SUSPENDING`: 完了待ちを案内
- `PENDING`/`UNKNOWN`: 現状は接続操作を表示するが、endpoint/code-serverのreadyは保証されない
- 候補がない場合: `Start a new MicroVM`

### 3-A. 新規セッション

`POST /session/select`で`action=new`を送ると、Lambda@Edgeが`RunMicrovm`を実行する。その後、port 8080だけを許可したMicroVM auth tokenを作成し、DynamoDBへレコードを保存して`mvm-session`を発行する。

この3段階はtransactionではない。`RunMicrovm`成功後にtoken作成またはDynamoDB保存が失敗すると、一覧から見えないorphan MicroVMが残り得る。現状は補償Terminateとidempotencyが未実装である。

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
6. HTTPSでAWS管理endpointへ転送する。

現状は手順1で検証した`omp-cloud-ide-auth`と`mvm-session`をrequestの`Cookie` headerから除去せず、そのままcode-server originへ転送する。`HttpOnly`でもorigin serverにはCookieが届き、code-server proxyが内側backendへ引き継ぐ場合はserver-side appから見える可能性がある。Edge専用Cookieだけを検証後にstripし、code-server固有Cookieは維持する改善と、そのE2E確認が必要である。

MicroVM内ではcode-serverが`0.0.0.0:8080`で待ち受け、独自認証は無効になっている。手前のCloudFrontログインとMicroVM proxy tokenの二段階を通らなければ到達できないためである。

code-serverの`/proxy/3000/`は、MicroVMの3000番を外部公開しているわけではない。外部通信は常にport 8080のcode-serverを通り、code-serverが内部の`localhost:3000`へ中継する。

## Suspend、Resume、Terminate

### 明示Suspend

`POST /session/suspend`では、先にDynamoDBの`paused=true`を保存してから`SuspendMicrovm`を呼ぶ。これにより、code-serverのWebSocket再接続が意図せずMicroVMを自動Resumeすることを防ぐ。

### Resume

`POST /session/resume`またはセッション選択画面の`Resume and connect`が`ResumeMicrovm`を呼ぶ。Resume後は`paused=false`へ戻す。

### Terminate

TerminateされたMicroVMのローカルディスクとRAM状態は戻せない。S3へ保存されるのはOMPとGitHubの認証ファイルだけで、`/home/vscode/workspace`は保存対象ではない。未完了の実装を残す場合は、Terminate前にGitへcommit・pushする必要がある。

`maximumDurationInSeconds=28800`はRUNNINGとSUSPENDEDを合わせたMicroVMの総寿命である。Suspend保持の設定が別に8時間あっても、起動から8時間を超えて同じMicroVMへ戻れるという意味ではない。

### 残り寿命の表示

Edgeは`RunMicrovm`直前に`expiresAt = now + 8時間`を計算して`runHookPayload`へ入れ、`/run` hookがMicroVM内へ記録する。code-serverのstatus barはこの値から`残り H:MM`を表示し、終了前に未push変更の確認を促す。セッション選択画面は`GetMicrovm`の`startedAt + maximumDurationInSeconds`から`Ends ... (Xh Ym left)`を表示する。どちらもこの機能のdeploy後に起動したMicroVMから有効で、それ以前のVMは`残り時間不明`になる。

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

- 現在は単一ユーザー用なので、セッション一覧はDynamoDB Scanの任意の最大25件を確認する。新しい順は保証せず、最大25回の`GetMicrovm`を並行実行する。
- DynamoDB TTL削除は即時ではないが、終了済みMicroVMはAPI照合で一覧から除外する。
- MicroVMのRUNNING+SUSPENDED総寿命8時間を超えてTerminateされた場合は再接続できない。
- セッション選択はMicroVMのローカル作業状態を永続化する機能ではない。生存している同一MicroVMへ接続し直す機能である。
- proxy token更新は分散Edgeからの条件なし更新であり、並行refreshの競合は未検証である。
- origin-responseはHTMLの`502/504`をpath非限定でselectorへ戻すため、proxy先アプリ自身のHTMLエラーをMicroVM障害と誤認し得る。
- Suspend/Terminate時のS3保存はbest-effortで、保存失敗が利用者へ表示されない。認証状態が重要な場合はlifecycle logとS3更新時刻も確認する。
