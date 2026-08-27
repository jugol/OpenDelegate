# OpenDelegate

语言：[English](README.md) · [한국어](README.ko.md) · **简体中文**

OpenDelegate 是一个通过 SSH 在多台计算机上安装和运行 Hermes Agent 的仓库，而不是单独的管理网站。

当前工作方式：

- Origin Agent 通过 SSH 在各个 Device 上安装、更新和修复 Hermes；
- 完成设置后，普通 Agent 工作通过 Hermes Peer API 发送；
- Tailscale、局域网或现有 VPN 提供网络连接；
- Hermes 配置、凭据、会话、记忆和数据库保留在各自 Device 上；
- OpenDelegate 不使用 Admin Web 或 Enrollment Grant。

## 快速开始

```sh
hermes doctor
git clone https://github.com/jugol/OpenDelegate.git
cd OpenDelegate
hermes skills trust
hermes
```

在新的 Hermes Session 中提出以下请求：

> 将这台计算机作为 Origin。使用我现有的 SSH Alias 连接其他 Device，安装或更新 Hermes，配置每台
> Device 的角色、Peer API 和 Gateway Service，在 Origin 注册并验证一次真实的请求和回复。凭据与
> Hermes State 必须保留在各个 Device 本地，绝不接受意外变化的 SSH Host Key。

完整步骤请参阅 [English README](README.md)、[한국어 README](README.ko.md) 和
[Getting Started](docs/GETTING_STARTED.md)。
