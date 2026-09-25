---
title: Lambda@EdgeからLambda MicroVMを操作するIAMポリシーでハマったところ
tags:
  - AWS
  - lambda
  - IAM
  - LambdaEdge
private: false
updated_at: ''
id: null
organization_url_name: null
slide: false
ignorePublish: false
---

# はじめに
こんにちは、ふくちです。

AWS Lambda MicroVMの上に自分専用のCloud IDEを作っていて、その中でLambda@EdgeからLambda MicroVMのAPIを呼ぶ構成にしました。全体の構成は「Lambda MicroVMで自分専用のCloud IDEを作った(AWS構成・認証・接続フロー編)」という記事に書いています。

Lambda@Edgeが呼んでいるLambda MicroVM APIは次の7つです。

| API | 用途 |
| --- | --- |
| `RunMicrovm` | MicroVMを起動する |
| `CreateMicrovmAuthToken` | MicroVM endpointへ入るためのtokenを発行する |
| `GetMicrovm` | MicroVMの状態を確認する |
| `SuspendMicrovm` | MicroVMを一時停止する |
| `ResumeMicrovm` | MicroVMを再開する |
| `TerminateMicrovm` | 確認画面からセッションを終了する。新規作成の登録失敗時にも補償する |
| `ListMicrovms` | DynamoDB行のない稼働中MicroVMを検出する |

このIAMポリシーを最小権限で書こうとしたところ、何回かハマりました。Lambda MicroVMは2026年6月に出たばかりのサービスなので、同じところで困る方もいるかなと思い、備忘録として残しておきます。

なお、ここに書いた挙動は2026年9月時点で私が実際に試した結果です。今後のアップデートで変わる可能性があります。

# 結論
最終的にLambda@EdgeのIAM Roleはこうなりました(CDKのコードから抜粋)。

```ts:lib/lambda-microvm-stack.ts
const imageArn = `arn:aws:lambda:ap-northeast-1:${account}:microvm-image:omp-cloud-ide`;
const microvmInstanceArn = `arn:aws:lambda:ap-northeast-1:${account}:microvm:*`;

edgeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['lambda:RunMicrovm'],
  resources: [imageArn],
}));
edgeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['lambda:CreateMicrovmAuthToken'],
  // 入力はMicroVMのIDだが、認可は元のImage ARNに対して評価される
  resources: [imageArn],
}));
edgeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['lambda:GetMicrovm', 'lambda:SuspendMicrovm', 'lambda:ResumeMicrovm', 'lambda:TerminateMicrovm'],
  // 状態によってImage ARNとMicroVM ARNのどちらでも評価され得るので両方を許可する
  resources: [imageArn, microvmInstanceArn],
}));
edgeRole.addToPolicy(new iam.PolicyStatement({
  // ListMicrovmsはresource-level認可を持たない。API入力はImage ARNでフィルタする
  actions: ['lambda:ListMicrovms'],
  resources: ['*'],
}));
edgeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['lambda:PassNetworkConnector'],
  resources: [
    'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
    'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS',
  ],
}));
edgeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['iam:PassRole'],
  // iam:PassedToServiceの条件は付けない(後述)
  resources: [`arn:aws:iam::${account}:role/omp-cloud-ide-microvm-execution`],
}));
```

AWSのLambda MicroVM開発者ガイドのNetworkingのページに「Lambda MicroVMs actions use the `lambda:` IAM action prefix.」とあるとおり、Actionのprefixは`lambda:`です。

https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html

ここからは、ハマったところを1つずつ書きます。

# ハマり1: CreateMicrovmAuthTokenはImage ARNで認可される
`CreateMicrovmAuthToken`は、起動中のMicroVMに対してtokenを発行するAPIです。入力のパラメータ名も`microvmIdentifier`なので、私は最初、MicroVMのARN(`microvm:*`)をResourceに書きました。

```ts
// 最初に書いたもの(これでは通らなかった)
edgeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['lambda:CreateMicrovmAuthToken'],
  resources: [`arn:aws:lambda:ap-northeast-1:${account}:microvm:*`],
}));
```

ところがこれだと`CreateMicrovmAuthToken`の呼び出しが権限不足で失敗しました。しかもLambda@Edgeの中で例外になるので、ブラウザには次のようなCloudFrontの503が返ってきます。

```text
The Lambda function associated with the CloudFront distribution is invalid or doesn't have the required permissions.
```

このメッセージだけを見ると、Lambda@Edgeの関連付けが壊れたように見えます。原因がIAMだとわかるのは、Lambda@Edge自身のログを見たときです。

結論として、IAMはこのAPIを、MicroVMの起動元になったImage ARNで評価していました。ResourceをImage ARNにしたら通るようになりました。

APIのパラメータ名からResourceを推測せず、実際のエラーで評価対象を確認するのが大事ですね。

ちなみにLambda@Edgeのログは、関数が実際に実行されたリージョンのCloudWatch Logsに出ます。CloudFront開発者ガイドにも「You must review CloudWatch log files in the correct Region」とあり、ロググループ名は`/aws/lambda/us-east-1.<関数名>`になります。東京からアクセスしているなら、まずap-northeast-1のロググループを探すと見つかりやすいです。

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-logs.html

# ハマり2: Get/Suspend/Resumeは状態で評価対象が変わる
`GetMicrovm`、`SuspendMicrovm`、`ResumeMicrovm`も同じ考え方でImage ARNを許可すれば良さそうに見えます。ただ実装時点の挙動では、起動中のMicroVMに対してはImage ARN、Suspend中のMicroVMに対してはMicroVMのインスタンスARNで評価されることがありました。

Suspend中のMicroVMに`ResumeMicrovm`できないと、Cloud IDEとしては致命的です。そこでImage ARNと、アカウント内のMicroVM ARN(`microvm:*`)の両方を許可しています。`*`にすれば楽ですが、せめて自アカウント・東京リージョンのMicroVMに絞りました。

# ハマり3: iam:PassRoleのiam:PassedToService条件が通らない
`RunMicrovm`では、MicroVMの中で使うExecution Roleを`executionRoleArn`で渡します。なので呼び出す側には`iam:PassRole`が必要です。

PassRoleには、よく次のような条件を付けます。

```ts
// 最初に書いたもの(これでは通らなかった)
edgeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['iam:PassRole'],
  resources: [executionRoleArn],
  conditions: {
    StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
  },
}));
```

この条件を付けた状態では、`RunMicrovm`が失敗しました。Lambda MicroVMのAPIから呼ばれたときのPassRoleの評価と、この条件が合っていないようです。

そこで条件を外し、代わりにResourceを渡してよいRoleの1つだけに絞りました。条件は、実際のAPIの呼び出し方と合っていないと正しい処理まで止めてしまいます。付けた条件が本当に評価されているかは、実際に呼んで確かめる必要があります。

# 忘れがちなもの: lambda:PassNetworkConnector
`RunMicrovm`でネットワークコネクター(`ingressNetworkConnectors`、`egressNetworkConnectors`)を指定する場合は、`lambda:PassNetworkConnector`も必要です。

AWSが用意しているコネクターは、ARNのアカウント部分が`aws`になっています。

```text
arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS
arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS
```

Resourceには、実際に渡すこの2つだけを書いています。

# MicroVM側のRoleのTrust Policy
MicroVMのImageを作るときのBuild Roleと、MicroVMの中で使うExecution Roleは、どちらも`lambda.amazonaws.com`に引き受けさせます。Trust Policyはこうしました。

```ts:lib/lambda-microvm-stack.ts
cfnRole.assumeRolePolicyDocument = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: ['sts:AssumeRole', 'sts:TagSession'],
      Condition: {
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': `arn:aws:lambda:ap-northeast-1:${account}:microvm-image:*` },
      },
    },
  ],
};
```

`aws:SourceAccount`と`aws:SourceArn`を付けて、自アカウントのMicroVM Imageからだけ引き受けられるようにしています。CDKの`iam.Role`は`assumedBy`から`sts:AssumeRole`だけのTrust Policyを作るので、L1の`CfnRole`を直接書き換えました。

`aws:SourceArn`は`microvm-image:*`なので、同じアカウントの別のImageからは引き受けられてしまいます。特定のImage ARNまで絞れるかは、まだ確認できていません。

# Execution Roleには何を付けるか
最後に、MicroVMの中で使うExecution Roleの話です。今回のCloud IDEでは、MicroVMの中でコーディングエージェントのOMPがシェルを実行します。つまり、Execution Roleに付けた権限は、そのままAIエージェントも使えます。

なのでExecution Roleには、認証情報を保存するS3バケットの`personal/*`、そのバケットのKMSキー、専用のCloudWatch Logsへの書き込みだけを付けています。開発対象のAWS環境を触る権限はここに足さず、必要になったら短命のRoleを別に引き受ける形にするつもりです。

# まとめ
Lambda MicroVMをLambda@Edgeから操作するIAMで、ハマったところをまとめました。

| Action | Resourceに書くもの |
| --- | --- |
| `lambda:RunMicrovm` | Image ARN |
| `lambda:CreateMicrovmAuthToken` | Image ARN |
| `lambda:GetMicrovm` / `SuspendMicrovm` / `ResumeMicrovm` / `TerminateMicrovm` | Image ARNとMicroVM ARNの両方 |
| `lambda:ListMicrovms` | `*`(resource-level認可なし。呼び出し時にImageを指定) |
| `lambda:PassNetworkConnector` | 使うコネクターのARN |
| `iam:PassRole` | Execution Role ARN(`iam:PassedToService`条件は付けない) |

新しいサービスはIAMの評価対象がドキュメントからは読み取りにくいことがあります。Lambda@Edgeの場合はエラーがCloudFrontの503に化けるので、実行リージョンのログを見にいくのが近道でした。

## 参考リンク

https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html

https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-logs.html

https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html
