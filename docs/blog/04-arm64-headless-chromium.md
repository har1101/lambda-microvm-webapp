---
title: ARM64のLambda MicroVMにヘッドレスChromiumを入れてAIエージェントにブラウザを持たせる
tags:
  - AWS
  - lambda
  - Chromium
  - puppeteer
  - AIエージェント
private: false
updated_at: ''
id: null
organization_url_name: null
slide: false
ignorePublish: false
---

# はじめに
こんにちは、ふくちです。

AWS Lambda MicroVMの上に、code-serverとコーディングエージェントのOMP(Oh My Pi)を載せた自分専用のCloud IDEを作っています。全体の構成は「Lambda MicroVMで自分専用のCloud IDEを作った(AWS構成・認証・接続フロー編)」という記事に書きました。

OMPにはブラウザを操作する機能があり、MicroVMの中で起動したWebアプリをAIエージェント自身に開かせて、クリックやスクリーンショットで動作確認させられます。アプリを外部に公開せず、MicroVMの中の`localhost`だけで確認が完結するのが良いところです。

ただ、MicroVMのImageをARM64で作っていたので、ブラウザを用意するところで少し工夫が必要でした。この記事ではその方法をまとめます。

# 何が困ったか
OMPのブラウザ機能は、puppeteer-coreでChromiumを操作します。puppeteerは、ブラウザが見つからない場合にGoogleのChrome for Testingをダウンロードして使います。

ところが開発時点のChrome for Testingには、Linux arm64向けの配布物がありませんでした。MicroVMはARM64なので、この自動ダウンロードに頼れません。

:::note
2026年9月25日にChrome for Testingの配布一覧(known-good-versions-with-downloads.json)を確認したところ、`linux-arm64`の配布物は153.0.8001.0以降に追加されていました。今から作る場合は、Chrome for Testingを使う案も比較してみてください。
https://googlechromelabs.github.io/chrome-for-testing/
:::

もう1つの問題が、共有ライブラリです。MicroVMのDockerfileのベースは`public.ecr.aws/lambda/microvms:al2023-minimal`で、名前のとおり最小構成のAmazon Linux 2023です。Chromiumを動かすのに必要なライブラリの多くが入っていません。

# Sparticuz/chromiumのarm64 packを使う
そこで使ったのが、Sparticuz/chromiumです。AWS Lambdaなどのサーバーレス環境でChromiumを動かすためのパッケージで、Chromiumのbinaryと、Amazon Linux 2023向けの共有ライブラリ、フォントをまとめて配布しています。

https://github.com/Sparticuz/chromium

GitHubにあるSparticuz/chromiumのREADMEのFAQには、arm64について次のように書かれています。

> Starting at Chromium v135, arm64 binaries are available as a Lambda layer zip and a pack tar in each GitHub release.

> The npm package (`@sparticuz/chromium`) includes only x64 binaries. For arm64, use the `@sparticuz/chromium-min` package and then use one of these options:

つまりARM64で使う場合は、GitHub Releasesにあるarm64のpack(`chromium-v<version>-pack.arm64.tar`)をダウンロードし、`@sparticuz/chromium-min`で展開します。

Lambda関数で使う場合は、この展開を関数の実行時に`/tmp`へ行うのが普通です。今回はMicroVMのImageを作る時点で展開しておけば、毎回の起動で展開する必要がありません。

# Dockerfile
Chromiumまわりの部分を抜き出すとこうなります。

```dockerfile:Dockerfile
ARG CHROMIUM_VERSION=149.0.0
ARG CHROMIUM_ARM64_PACK_SHA256=9c42e7850d746cbf0ac0e68eaa48af277af8255a5ee12a813c08573671f231f6

RUN mkdir -p /opt/chromium /tmp/chromium-installer/node_modules /tmp/chromium-pack \
    && curl -fsSL \
      "https://github.com/Sparticuz/chromium/releases/download/v${CHROMIUM_VERSION}/chromium-v${CHROMIUM_VERSION}-pack.arm64.tar" \
      -o /tmp/chromium-pack.tar \
    && echo "${CHROMIUM_ARM64_PACK_SHA256}  /tmp/chromium-pack.tar" | sha256sum -c - \
    && tar -xf /tmp/chromium-pack.tar -C /tmp/chromium-pack \
    && npm install --prefix /tmp/chromium-installer --ignore-scripts \
      "@sparticuz/chromium-min@${CHROMIUM_VERSION}" \
    && AWS_EXECUTION_ENV=AWS_Lambda_nodejs24.x TMPDIR=/opt/chromium node --input-type=module -e \
      'import Chromium from "/tmp/chromium-installer/node_modules/@sparticuz/chromium-min/build/index.js"; await Chromium.executablePath("/tmp/chromium-pack");' \
    && chmod 0755 /opt/chromium/chromium \
    && LD_LIBRARY_PATH=/opt/chromium/al2023/lib:/opt/chromium /opt/chromium/chromium --version \
    && rm -rf /tmp/chromium-installer /tmp/chromium-pack /tmp/chromium-pack.tar \
    && npm cache clean --force

ENV PUPPETEER_EXECUTABLE_PATH=/opt/chromium/chromium
ENV FONTCONFIG_PATH=/opt/chromium/fonts
ENV LD_LIBRARY_PATH=/opt/chromium/al2023/lib:/opt/chromium
```

やっていることは次の順番です。

1. arm64のpackをダウンロードし、SHA-256を照合する
2. packを展開する
3. `@sparticuz/chromium-min`を一時ディレクトリにインストールする
4. `Chromium.executablePath()`を呼んで、binaryとライブラリを`/opt/chromium`へ展開する
5. `chromium --version`を実行して、実際に起動できることを確認する
6. 一時ファイルを消す

versionとSHA-256を固定しているので、GitHub Releasesのファイルが差し替えられた場合はbuildが失敗します。5番で実際にbinaryを起動しているので、ライブラリが足りない場合もImageのbuildの時点で気づけます。

# 2つの環境変数のトリック
4番のところで、`AWS_EXECUTION_ENV`と`TMPDIR`という2つの環境変数を付けています。ここが今回のポイントです。

## AWS_EXECUTION_ENV
`@sparticuz/chromium-min`は、Amazon Linux 2023の上で動いているかどうかを環境変数で判定し、そうであればAL2023向けの共有ライブラリ(`al2023.tar.br`)も展開します。Sparticuz/chromiumのソースコード(`source/helper.ts`)には、判定に使う環境変数についてこう書かれています。

```ts:source/helper.ts
/**
 * Determines if the running instance is inside an Amazon Linux 2023 container,
 * AWS_EXECUTION_ENV is for native Lambda instances
 * AWS_LAMBDA_JS_RUNTIME is for netlify instances
 * CODEBUILD_BUILD_IMAGE is for CodeBuild instances
 * ...
 */
export const isRunningInAmazonLinux2023 = (nodeMajorVersion: number) => {
  const awsExecEnv = process.env["AWS_EXECUTION_ENV"] ?? "";
  // 省略
```

https://github.com/Sparticuz/chromium/blob/master/source/helper.ts

MicroVMのImage作成中は、この環境変数がどれも設定されていません。そこで`AWS_EXECUTION_ENV=AWS_Lambda_nodejs24.x`を付けて、Lambdaのnode.js 24ランタイムで動いていると判定させています。こうすると`al2023/lib`にライブラリが展開されます。

## TMPDIR
`@sparticuz/chromium-min`は、展開先にNode.jsの`os.tmpdir()`を使います。Lambdaでは`/tmp`になる場所です。

`os.tmpdir()`は`TMPDIR`環境変数を見るので、`TMPDIR=/opt/chromium`を付けると展開先を`/opt/chromium`に変えられます。展開後の中身はこうなります。

```text
/opt/chromium/chromium       Chromiumのbinary
/opt/chromium/al2023/lib     AL2023向けの共有ライブラリ
/opt/chromium/fonts          フォント
```

# 実行時の設定
展開したChromiumを使ってもらうため、Imageに3つの環境変数を設定しています。

| 環境変数 | 値 | 役割 |
| --- | --- | --- |
| `PUPPETEER_EXECUTABLE_PATH` | `/opt/chromium/chromium` | puppeteerが起動するbinaryを指定する |
| `FONTCONFIG_PATH` | `/opt/chromium/fonts` | フォントの設定を読む場所 |
| `LD_LIBRARY_PATH` | `/opt/chromium/al2023/lib:/opt/chromium` | 共有ライブラリを探す場所 |

OMPの設定ファイル(`~/.omp/agent/config.yml`)では、ブラウザ機能をヘッドレスで有効にし、スクリーンショットの保存先をworkspaceの中にしています。

```yaml:config.yml
browser:
  enabled: true
  headless: true
  screenshotDir: /home/vscode/workspace/.artifacts/screenshots
```

スクリーンショットをworkspaceに置いておくと、code-serverのエクスプローラーからそのまま開いて確認できます。

# 今の状況
正直に書いておくと、ここまでで確認できているのは次の範囲です。

- Imageのbuild時に、`/opt/chromium/chromium --version`が成功すること
- 環境変数と設定ファイルがImageに入っていること(Jestのテストで確認)

OMPから実際にブラウザを開き、`localhost`のアプリを操作してスクリーンショットを撮るところまでを、再現できる形のE2Eとしてはまだ用意できていません。ここは次にやりたいことです。

## Edgeの画面を描画すると落ちる
実際に使ってみて、困ったこともわかりました。デプロイしたCloud IDEをこのChromiumで確認しようとしたところ、Lambda@Edgeが返すログイン画面やセッション選択画面を描画した時点で、Chromiumが次のメッセージで異常終了しました。

```text
FATAL: SkFontMgr_FontConfigInterface.cpp:163 Not implemented
```

フォントのfallbackが起きたときに落ちているようです。`about:blank`からCloudFrontのURLへの最初の移動が`Navigating frame was detached`で失敗することもありました。一方でcode-serverの画面は描画できます。ただし文字のglyphはほとんど表示されません。

そこでデプロイ後のE2Eでは、ログイン、セッション選択、Suspend、ResumeをCookie付きのHTTP(`fetch`)で操作し、ブラウザではcode-serverの画面だけを開くようにしました。code-serverは準備ができると`/`に対して`./?folder=...`への302を返すので、起動を待つ目印に使えます。

また、ステータスバーの項目に合成の`element.click()`を送っても反応しませんでした。本物のマウスクリックが必要ですが、文字が描画されていないと位置を当てにくく、安定しません。フォントまわりが直るまでは、Chromiumで確認するのはcode-serverの画面に絞るのが無難です。

# まとめ
ARM64のLambda MicroVMでヘッドレスChromiumを使うために、Sparticuz/chromiumのarm64 packをImageのbuild時に展開しました。

- arm64のpackをversionとSHA-256を固定してダウンロードする
- `AWS_EXECUTION_ENV`でAL2023向けライブラリも展開させる
- `TMPDIR`で展開先を`/opt/chromium`にする
- `PUPPETEER_EXECUTABLE_PATH`でpuppeteerに使わせる

Sparticuz/chromiumはLambda関数向けのパッケージですが、Lambda MicroVMのImageでも同じAL2023向けの成果物がそのまま使えました。サーバーレスで積み上げられてきた知見が、新しいサービスでも活きるのは面白いですね。ただしフォントのfallbackで落ちる画面があるので、画面の確認に使うときは描画できる範囲を見極めておく必要があります。

## 参考リンク

https://github.com/Sparticuz/chromium

https://googlechromelabs.github.io/chrome-for-testing/

https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html

https://github.com/can1357/oh-my-pi
