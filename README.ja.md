# OpenDelegate

Languages: [English](README.md) · [한국어](README.ko.md) · **日本語**

OpenDelegate は、複数のコンピューターに Hermes Agent をセットアップして運用するための
SSH-first リポジトリです。別の管理 Web サイトではありません。

現在の運用方法:

- Origin Agent が SSH を使用して各 Device に Hermes をインストール、更新、復旧します。
- セットアップ後の通常作業は Hermes Peer API で送信します。
- Tailscale、LAN、または既存の VPN が接続経路を提供します。
- Hermes の設定、資格情報、Session、Memory、Database は各 Device に保持します。
- OpenDelegate Admin Web や Enrollment Grant は使用しません。

## クイックスタート

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

新しい Hermes Session で次のように依頼します。

> このコンピューターを Origin として、既存の SSH Alias を使って他の Device に Hermes を
> インストールまたは更新してください。各 Device の役割、Peer API、Gateway Service を設定し、
> Origin に登録して実際の request/reply を確認してください。Credential と Hermes State は各
> Device のローカルに保持し、変更された SSH Host Key は受け入れないでください。

完全な手順は [English README](README.md)、[한국어 README](README.ko.md)、
[Getting Started](docs/GETTING_STARTED.md) を参照してください。
