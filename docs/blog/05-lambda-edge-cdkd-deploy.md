---
title: Lambda@EdgeとLambda MicroVMの2リージョン構成をcdkdでデプロイしたときのハマりどころ
tags:
  - AWS
  - CDK
  - LambdaEdge
  - CloudFront
  - cdkd
private: false
updated_at: ''
id: null
organization_url_name: null
slide: false
ignorePublish: false
---

# はじめに
こんにちは、ふくちです。

AWS Lambda MicroVMの上に自分専用のCloud IDEを作り、そのIaCをAWS CDKで書いてcdkdでデプロイしています。全体の構成は「Lambda MicroVMで自分専用のCloud IDEを作った(AWS構成・認証・接続フロー編)」という記事に書きました。

構成をざっくりいうと、CloudFront + Lambda@Edgeをus-east-1に、Lambda MicroVMを東京に置いた2リージョン・2スタックの構成です。

| スタック | リージョン | 中身 |
| --- | --- | --- |
| `OmpCloudIdeMicrovmStack` | ap-northeast-1 | MicroVM Image、S3、KMS、IAM Role |
| `OmpCloudIdeEdgeStack` | us-east-1 | CloudFront、Lambda@Edge、DynamoDB、Secrets Manager |

この構成をデプロイしていて、Lambda@Edge、CDK、cdkdまわりでいくつかハマりました。この記事ではそれをまとめます。

# cdkdとは
cdkdは、go-to-kさんが開発しているOSSのCLIです。既存のCDKアプリをそのまま使い、CloudFormationを経由せずにAWS SDKで直接リソースを作ります。

https://github.com/go-to-k/cdkd

GitHubにあるcdkdのREADMEには、cdkdはdev/test用途向けで、本番ではAWS CDK CLIを使うよう書かれています。今回は個人の開発環境なので、デプロイの速さを優先して採用しました。npm scriptsはこうしています。

```json:package.json
"synth": "cdkd synth",
"diff": "cdkd diff --all",
"deploy": "cdkd deploy --all --full-wait",
"deploy:dry-run": "cdkd deploy --all --dry-run",
"destroy": "cdkd destroy --all",
"bootstrap": "cdkd bootstrap --region ap-northeast-1 && cdkd bootstrap --region us-east-1"
```

2リージョンにデプロイするので、bootstrapも両方のリージョンで実行しています。

# ハマり1: Lambda@Edgeは環境変数を使えない
Lambda@Edgeでは、Lambdaの環境変数を使えません。CloudFront開発者ガイドのLambda@Edgeの制限事項に、サポートされないLambdaの機能として「Lambda environment variables」が挙がっています。

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html

今回のLambda@Edgeは、DynamoDBのテーブル名、MicroVMのImage ARN、Execution RoleのARNなど、いくつかの設定値を必要とします。そこで、CDKのsynth時に設定ファイル(`config.json`)を書き出し、関数のコードと一緒にバンドルすることにしました。

```ts:lib/lambda-microvm-stack.ts
const edgeAssetDir = path.join(__dirname, '..', 'artifact', 'edge');
this.writeEdgeConfig(edgeAssetDir, {
  MVM_REGION: config.microvmRegion,
  TABLE_REGION: config.edgeRegion,
  TABLE: config.edge.tableName,
  IMAGE_ARN: imageArn,
  EXECUTION_ROLE_ARN: executionRoleArn,
  // Lambda@Edge does not support environment variables. Embed the stable
  // secret name instead of an unresolved CDK token so asset hashes remain
  // deterministic and Secrets Manager resolves the current ARN at runtime.
  AUTH_SECRET_ID: config.edge.accessSecretName,
  // 省略
});
```

Lambda@Edge側は、このファイルを`require`するだけです。

```js:artifact/edge/index.js
const cfg = require('./config.json');
```

ここで気をつけたことが2つあります。

1つ目は、CDKのtoken(デプロイ時に決まる値)を書き込まないことです。たとえば`secret.secretArn`をそのまま書くと、`${Token[...]}`のような未解決の文字列が入ります。アセットのハッシュも安定しません。そこでSecretには固定の名前(`omp-cloud-ide/access-password`)を付け、`config.json`にはその名前を書いています。Secrets Managerの`GetSecretValue`は名前でも取得できるので、実行時にはこれで十分です。ARNも同じ理由で、`lib/config.ts`でアカウントIDと固定の名前から組み立てた文字列を使っています。

2つ目は、秘密の値を書き込まないことです。`config.json`に入れるのは、名前やARNなど知られても困らない値だけにしました。パスワードは、Lambda@Edgeが実行時にSecrets Managerから取ります。

`config.json`はsynthのたびに生成されるので、`.gitignore`に入れています。

# ハマり2: CDKの.gitignoreが.jsファイルを無視する
これは地味にハマりました。`cdk init`で作ったTypeScriptのCDKアプリの`.gitignore`には、最初からこう書かれています。

```text:.gitignore
*.js
!jest.config.js
*.d.ts
node_modules
```

TypeScriptをコンパイルした`.js`を無視するための設定です。ところがこのプロジェクトでは、Lambda@EdgeのコードやVS Code拡張を、素のJavaScriptで書いてCDKアプリの中に置いています。つまり`*.js`のルールで、これらのファイルも無視されてしまいます。

Lambda@Edgeのファイルには例外を足していました。

```text:.gitignore
*.js
!jest.config.js
!artifact/edge/index.js
!artifact/edge-response/index.js
```

ところが、あとからMicroVMのImageに入れる自作のVS Code拡張(`artifact/base-image/omp-cloud-ide-controls/extension.js`)を追加したとき、最初のcommitに`package.json`だけが入り、`extension.js`が漏れていました。手元にはファイルがあるので、ローカルのビルドやテストではこの漏れに気づけません。

`git check-ignore`を使うと、どのルールで無視されているかがわかります。例外を足す前は、こう表示されていました。

```bash
$ git check-ignore --no-index -v artifact/base-image/omp-cloud-ide-controls/extension.js
.gitignore:1:*.js	artifact/base-image/omp-cloud-ide-controls/extension.js
```

今は拡張のディレクトリにも例外を足しています。

```text:.gitignore
!artifact/base-image/omp-cloud-ide-controls/*.js
```

CDKアプリの中に素のJavaScriptを置く場合は、例外を足すか、`*.js`のルールを`lib/`や`bin/`などのディレクトリに限定しておくのが安全です。commit前に`git status --short`で新しいファイルが出ているかを見る習慣も大事ですね。

# ハマり3: Lambda@EdgeのVersionはすぐには消せない
Lambda@Edgeのコードを変えてデプロイすると、新しいVersionが公開され、CloudFrontの関連付けが新しいVersionに切り替わります。このとき、古いVersionを削除しようとして失敗しました。

CloudFront開発者ガイドによると、Lambda@EdgeのVersionはCloudFrontが各地に複製しており、その複製が消えるまで削除できません。複製は関連付けを外してから、通常数時間以内に消えるそうです。

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-delete-replicas.html

関連付けを切り替えた直後に古いVersionを消そうとすると失敗し、デプロイ全体が失敗扱いになります。そこでVersionにはRETAINを付けて、削除しないようにしました。

```ts:lib/lambda-microvm-stack.ts
// Lambda@Edge replicates published versions to edge regions. AWS rejects
// immediate deletion while those replicas exist, so version replacements
// must leave the retired physical versions in place for later cleanup.
const edgeVersion = edgeFn.currentVersion;
const edgeResponseVersion = edgeResponseFn.currentVersion;
edgeVersion.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
edgeResponseVersion.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
```

代わりに、古いVersionがデプロイのたびに残っていきます。定期的に棚卸しする手順は、まだ作れていません。

# ハマり4: --full-waitを付けないと古いLambda@Edgeで確認してしまう
MicroVM Imageのビルドと、CloudFrontのDistributionの更新は、どちらも完了まで時間がかかります。cdkdは、デフォルトでもリソースの作成・更新を待ちますが、CloudFrontの反映完了まで待つには`--full-wait`が必要です。cdkdのREADMEのベンチマークでも、CloudFrontが`Deployed`になるまで待つケースに`--full-wait`を付けています。

`--full-wait`を付けないと、コマンドが終わった時点ではまだCloudFrontの反映が終わっておらず、古いLambda@Edgeが動いている可能性があります。この状態で動作確認を始めると、変更が効いていないように見えて混乱します。

今は`npm run deploy`に`--full-wait`を付けています。

# ハマり5: AWS CLIでは有効なSSOがcdkdでは期限切れになる
AWS SSOでログインしていて、`aws sts get-caller-identity --profile <profile>`は成功するのに、cdkdを実行すると`Token is expired`で失敗することがありました。AWS CLIと、cdkdが内部で使うNode.jsのAWS SDKとで、SSOのキャッシュの扱いが違うようです。

AWS CLIで一時的な認証情報を環境変数として書き出し、それをcdkdに使わせることで回避しました。

```bash
eval "$(aws configure export-credentials --profile <profile> --format env)"
unset AWS_PROFILE
AWS_REGION=ap-northeast-1 npm run diff
```

出力には認証情報がそのまま入るので、ログに残さないよう注意してください。

cdkdは実行している人の認証情報で直接AWS APIを呼ぶので、デプロイする人自身に、全リソースを作る権限が必要です。CloudFormationのサービスロールに権限を持たせる運用とは、この点が違います。

# ハマり6: アカウントIDが決まらないままsynthしない
`lib/config.ts`では、`CDK_DEFAULT_ACCOUNT`がなければ例外を投げて止まるようにしています。

```ts:lib/config.ts
const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;

if (!ACCOUNT) {
  throw new Error('CDK_DEFAULT_ACCOUNT is required. Run with an authenticated AWS profile.');
}
```

2リージョンの間でCDKのクロスリージョン参照を使わず、アカウントIDと固定の名前からARNやバケット名を組み立てているためです。アカウントIDが空のままだと、壊れたARNが`config.json`に書き込まれてしまいます。

テストでは、固定のテスト用アカウントIDをスタックのpropsに渡しています。

# ハマり7: S3のライフサイクルルールにprefixを付けると拒否される
認証情報を置くS3バケットはVersioningを有効にしているので、古いversionを消すライフサイクルルールを足しました。30日たった古いversionを消しつつ、新しい10個は残す設定です。

```ts:lib/lambda-microvm-stack.ts
lifecycleRules: [
  {
    id: 'expire-old-auth-state-versions',
    noncurrentVersionExpiration: cdk.Duration.days(30),
    noncurrentVersionsToRetain: 10,
    abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
  },
],
```

最初は認証情報のprefix(`personal/`)だけに効くよう`prefix`を付けていたのですが、これがデプロイで`InvalidRequest`になりました。cdkdは、prefixだけを持つルールを古いV1の形式(ルール直下の`Prefix`)で送っていて、S3はV1の形式と`NewerNoncurrentVersions`(`noncurrentVersionsToRetain`)の組み合わせを受け付けないようです。cdkdが自動でロールバックしてくれたので、壊れた状態は残りませんでした。

prefixを外すと、cdkdは`Filter: {Prefix: ""}`というV2の形式で送るので通ります。そこでprefixは付けず、バケット全体に効かせることにしました。

# ハマり8: 中断したデプロイのロックが残る
`npm run deploy`を、300秒でタイムアウトするツールから実行したことがありました。デプロイが終わる前にタイムアウトし、cdkdは途中で止められてしまいました。

このとき、cdkdはスタックのロックを残していました。ロックの持ち主だったプロセスはゾンビになっていて、そのままでは次のデプロイを進められません。生きているcdkdのプロセスがないことを確かめてから、ロックを外して再デプロイしたところ、正常に収束しました。

```bash
cdkd force-unlock <stack> --stack-region <region>
```

`--full-wait`を付けるとImageのビルドとCloudFrontの反映まで待つので、デプロイには時間がかかります。短いタイムアウトの中で実行しないのが一番の対策です。

# 小ネタ: CloudFrontのoriginはダミーでいい
今回のLambda@Edgeは、リクエストごとにoriginをLambda MicroVMのendpointに書き換えます。とはいえCDKのDistributionにはoriginの指定が必須なので、ダミーとして`example.com`を置いています。

```ts:lib/lambda-microvm-stack.ts
defaultBehavior: {
  origin: new origins.HttpOrigin('example.com', {
    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    // 省略
  }),
  cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
  originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
  edgeLambdas: [
    { functionVersion: edgeVersion, eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST, includeBody: true },
    { functionVersion: edgeResponseVersion, eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE, includeBody: false },
  ],
},
```

注意点は、Lambda@Edgeの処理から漏れたリクエストが本当に`example.com`へ飛んでしまうことです。どの分岐でもoriginを書き換えるか、Lambda@Edgeが自分でレスポンスを返すようにして、テストでも確認しておく必要があります。

もう1つ、`includeBody: true`にするとLambda@Edgeでリクエストの本文を読めます。CloudFront開発者ガイドによると、本文はbase64でエンコードされて渡され、origin requestイベントでは1MBを超えると切り詰められます。ログインフォームのPOSTを読むときは、切り詰められていたら拒否するようにしています。

```js:artifact/edge/index.js
function parseFormBody(body) {
  if (!body?.data || body.inputTruncated) {
    return null;
  }
  // 省略
}
```

# まとめ
Lambda@EdgeとLambda MicroVMの2リージョン構成を、cdkdでデプロイしたときのハマりどころをまとめました。

| ハマりどころ | 対応 |
| --- | --- |
| Lambda@Edgeで環境変数を使えない | synth時に`config.json`を書き出してバンドルする。tokenと秘密の値は入れない |
| CDKの`.gitignore`が`*.js`を無視する | 素のJavaScriptには例外を足す。`git check-ignore`で確認する |
| Lambda@EdgeのVersionをすぐ消せない | VersionをRETAINにする |
| デプロイ直後に古いLambda@Edgeが動く | `--full-wait`を付ける |
| SSOがcdkdだけ期限切れになる | `aws configure export-credentials`で渡す |
| アカウントIDが空のままsynthされる | `CDK_DEFAULT_ACCOUNT`がなければ止める |

どれも一度ハマれば覚えられるのですが、Lambda@Edgeは反映やログが各地に散らばる分、原因にたどり着くまでが長くなりがちです。同じ構成を作る方の参考になれば嬉しいです。

## 参考リンク

https://github.com/go-to-k/cdkd

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-delete-replicas.html

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-logs.html
