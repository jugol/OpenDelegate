# OpenDelegate

語言：[English](README.md) · [한국어](README.ko.md) · **繁體中文**

OpenDelegate 是一個透過 SSH 在多台電腦上安裝與運行 Hermes Agent 的儲存庫，而不是獨立的管理網站。

目前的運作方式：

- Origin Agent 透過 SSH 在各個 Device 上安裝、更新與修復 Hermes；
- 設定完成後，一般 Agent 工作透過 Hermes Peer API 傳送；
- Tailscale、區域網路或現有 VPN 提供連線；
- Hermes 設定、憑證、Session、Memory 與 Database 保留在各自 Device 上；
- OpenDelegate 不使用 Admin Web 或 Enrollment Grant。

## 快速開始

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

在新的 Hermes Session 中提出以下要求：

> 將這台電腦作為 Origin。使用我現有的 SSH
> Alias 連線其他 Device，安裝或更新 Hermes，設定每台 Device 的角色、Peer API 與 Gateway
> Service，在 Origin 註冊並驗證一次真實的請求與回覆。憑證與 Hermes
> State 必須保留在各個 Device 本機，絕不接受意外變更的 SSH Host Key。

完整步驟請參閱 [English README](README.md)、[한국어 README](README.ko.md) 與
[Getting Started](docs/GETTING_STARTED.md)。
