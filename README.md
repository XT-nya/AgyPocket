# AgyPocket · 反重力随身远程终端（v2.1 开源版）

> 用手机随时随地指挥电脑桌面版 **Antigravity**，并附带低延迟 Windows 远程桌面遥控台与原生 Android 扫码客户端。

---

## ✨ 核心特性

- **Tab 1 — Antigravity 双向联动工作台**
  - 通过官方插件机制（`agy-pocket-bridge` Sidecar + Hooks）无缝接管桌面版 Antigravity 对话，支持新建对话、已有对话续聊、模型与思考强度切换（Fork）、实时工具审批（`remote_smart` / `remote_all` / `desktop_only`）。
  - **桌面输入框原生同步优先（`native_first`）**：续聊时优先同步注入桌面版 Antigravity 对话输入框，电脑端界面同步显示用户气泡，不可用时无感回退 Sidecar。
  - **完整气泡保真同步**：`local_sync` v3 同时解析 `USER_INPUT` 与 `agentapi send-message` 产生的用户 `SYSTEM_MESSAGE`，同时精准过滤内部提示与子智能体消息。

- **Tab 2 — 桌面遥控台交互与鼠标高阶操控**
  - **自由留白拖动（`free_margin`）与自动边缘对齐（`edge_snap`）**：默认 1.0x 下即可拖动画布，手指在暗色点阵留白区起手也能将准星精确推到屏幕 `0.0 / 1.0` 边角（任务栏、关闭按钮、开始菜单）。
  - **双指捏合缩放与一键居中**：支持 1.0x–3.5x 缩放、横屏全屏与 90° 顺时针虚拟横屏旋转。
  - **鼠标高阶动作与可定制工具栏**：支持左/右键按住（`left_hold` / `right_hold`）、带起点锚环与虚线引导的交互式拖动（`drag`）、短按/长按连点（`rapid_click`），以及 `Esc` 急停自动防卡键释放。
  - **UIA 按钮编号模式**：自动扫描前台窗口可点击控件并编号，小屏一指直点中心。

- **原生 Android 扫码端（`android-app/`）**
  - 内置 Camera2 + ZXing 原生二维码扫描器，**无个人默认地址**，开箱即用。
  - **智能探活路由**：支持 **固定模式（Fixed）** 与 **临时模式（Temp）**。临时模式下若检测到旧隧道失效（2.5 秒探活超时），自动唤醒扫码页换新地址；固定模式下停留离线重试页。
  - **TOFU 自签证书自动信任 + 二合一免密配对**：扫码自动提取目标域名 TLS SHA-256 指纹并记住，同时支持多台已保存电脑在三指菜单内快速切换。
  - **双端离线使用说明书**：Web 端（锁屏页 & 设置抽屉）与原生 Android 端均内置完整图文使用说明。

---

## 🖼️ 界面预览
<img width="240" height="536" alt="Screenshot_20261126_133239_com_tencent_mobileqq_" src="https://github.com/user-attachments/assets/c6a7e2ee-2023-4e8a-8449-9633ba682311" />
<img width="240" height="536" alt="11月26日3" src="https://github.com/user-attachments/assets/71a34d8f-c3a8-4134-87d6-4a65da2ad1af" />
<img width="240" height="536" alt="11月26日 (2)" src="https://github.com/user-attachments/assets/64df0296-6fbd-4e04-a623-db2b37432a7b" />
<img width="240" height="538" alt="11月26日 (1)" src="https://github.com/user-attachments/assets/f4ae3b7b-1982-47fe-a695-9ab0199fee48" />
：<img width="240" height="538" alt="6694966ec61d8c0a953ec6a446ed528e" src="https://github.com/user-attachments/assets/da5261f6-2e90-462e-8fbf-f46eec903d93" />
<img width="240" height="538" alt="Screenshot_20261126_144733_com_agypocket_app_Mai" src="https://github.com/user-attachments/assets/145cb323-8ae2-44c3-9ebe-7a24f8b0551a" />

---

## 🤖 给 AI 助手的自动化安装与配置协议（Agent Setup Protocol）

如果你正在使用 **Antigravity / AI 编程助手** 帮你部署本项目，只需把本仓库地址或目录发给它，助手将严格按以下协议自动完成本地安装与引导：

1. **前置环境检查与仓库准备**
   - 检查本机已安装：Python 3.11+（推荐 3.13）、Node.js 18+、Windows 官方 `agy` CLI 与 Antigravity Desktop。
   - 若尚未克隆仓库，先克隆到用户指定目录。
2. **创建 Python 虚拟环境并安装后端依赖**
   ```powershell
   python -m venv backend\.venv
   .\backend\.venv\Scripts\pip.exe install -r backend\requirements.txt
   ```
3. **构建前端静态资源**
   ```powershell
   cd frontend
   npm install
   npm run build
   cd ..
   ```
4. **初始化配置与注册桌面联动插件**
   - 若 `config\settings.json` 不存在，从 `config\settings.example.json` 复制初始化，自动填入本机主机名（`device_name`）和当前选定工作区路径（`workspace_dir`）。
   - 执行 `.\install-bridge-plugin.ps1` 将 `agy-pocket-bridge` 插件注册到 `%USERPROFILE%\.gemini\config\plugins\` 与 `config.json`。
5. **运行后端单元测试自检**
   ```powershell
   .\backend\.venv\Scripts\pytest.exe .\backend\tests -v
   ```
   确保全部测试通过。
6. **【强制互动反馈节点 — 穿透方案选型询问】**
   - **AI 助手在完成上述 1~5 步本地基础安装与自检后，必须暂停并主动向用户汇报安装与测试结果，同时询问用户选择哪种内网穿透方案**：
     - **推荐零成本入门路线：Cloudflare 免费隧道（Cloudflare Tunnel）**
       - 支持零配置免域名的 **临时随机链接（Temp 模式，快速体验）**；
       - 也支持绑定自己域名的 **固定链接（Fixed 模式，长期稳定）**。
     - **其他可选方案**：
       - **SakuraFrp**（国内节点低延迟固定地址）；
       - **Tailscale**（个人虚拟局域网组网直连）；
       - **frp 自建服务端**；
       - **纯局域网直连**（手机与电脑同 Wi-Fi，零配置）。
   - **等待用户拍板后再继续**：根据用户选择的方案，帮用户配置好 `tunnel_mode`、`connection_mode`、`external_public_url`（或协助安装 `cloudflared`），并引导用户双击 `start.bat`（或中文入口 `启动反重力远程终端.bat` / `start-agy-pocket.ps1`）设置访问口令、重启一次 Antigravity Desktop 后扫码连接。

---

## 🛠️ 开发者手动安装指南

### 1. 环境准备
- Windows 10 / 11
- Python 3.11+（已验证 Python 3.13.14）
- Node.js 18+（已验证 Node.js v24.18.0）
- 官方 Antigravity Desktop 与 `agy` CLI

### 2. 安装后端与前端
```powershell
python -m venv backend\.venv
.\backend\.venv\Scripts\pip.exe install -r backend\requirements.txt

cd frontend
npm ci
npm run build
cd ..
```

### 3. 注册官方联动插件（首次执行）
```powershell
powershell -ExecutionPolicy Bypass -File .\install-bridge-plugin.ps1
```
执行后重启一次桌面版 Antigravity，使 `agy-pocket-bridge` Sidecar 与 Hooks 生效。

### 4. 启动服务并扫码配对
双击 `start.bat`（非中文系统推荐）或 `启动反重力远程终端.bat`，也可直接运行：
```powershell
powershell -ExecutionPolicy Bypass -File .\start-agy-pocket.ps1
```
（若需单独登录 Antigravity CLI，可运行 `login-agy.bat` 或 `一键登录agy.bat`。）
首次运行会引导设置访问口令，并探测局域网 IP / 外部穿透地址 / 已安装的 `cloudflared`，随后生成 2 分钟有效的一次性二合一配对二维码。

启动器交互快捷键：
- `[R]` 刷新 2 分钟一次性配对二维码
- `[O]` 打开二维码图片 `pair_qr.png`
- `[M]` 在 `fixed`（固定模式）与 `temp`（临时模式）间切换
- `[U]` 更新外部接入地址（`external` 模式）
- `[N]` 重建隧道
- `[K]` 注销全部已登录手机会话
- `[Q]` 彻底停止后台服务与隧道（直接关闭窗口 `[×]` 则保持后台常驻）

---

## 📱 原生 Android APK 自编译指引

项目提供零 Gradle、零 Google Play Services 的纯命令行 Android APK 构建脚本 `android-app\build-apk.ps1`：

1. 安装 **JDK 17**（`JAVA_HOME` 或 `C:\Program Files\Java\jdk-17`）与 **Android SDK**（`platforms\android-35`、`build-tools\35.0.0`）。
2. （可选）通过环境变量指定签名口令（不入库）：
   ```powershell
   $env:AGYPOCKET_KS_PASS = "your-keystore-password"
   $env:AGYPOCKET_KEY_PASS = "your-key-password"
   $env:AGYPOCKET_KS_ALIAS = "agypocket"
   ```
3. 执行编译（首次会自动从 Maven Central 下载纯 Java 依赖 `zxing-core-3.5.3.jar` 到 `android-app\libs\`）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\android-app\build-apk.ps1
   ```
4. 输出签名后的安装包位于 `android-app\dist\AgyPocket.apk`。

> **分发说明**：成品 `AgyPocket.apk` 仅通过 **GitHub Releases** 分发，不随源码提交进 Git 仓库。

---

## 🔒 安全架构说明

- **口令加盐 scrypt 哈希**：访问口令仅保存盐值与哈希，不存明文；首次口令初始化仅允许本机环回（Loopback）或启动器终端执行。
- **防爆破锁定 + HttpOnly Cookie + CSRF + TOTP**：连续输错 5 次触发 15 分钟 IP 锁定；WebSocket 强制校验 Origin 防御 CSWSH；可选绑定 Google / Microsoft Authenticator 6 位动态验证码。
- **内部 Hook 环回隔离**：`/api/internal/hook/*` 仅放行本机直连并校验 64 位随机密钥 `X-AgyPocket-Hook-Secret`，拒绝任何带代理转发头的请求。
- **一次性二合一扫码配对**：配对令牌 2 分钟过期且单次消费即作废；Android 客户端仅对扫码确认的目标域名存储 TOFU 证书 SHA-256 指纹。
- **公网暴露务必走 HTTPS**：任何公网穿透访问入口（如 Cloudflare Tunnel、SakuraFrp、frp + 反向代理等）必须启用 HTTPS 加密传输；明文 HTTP 仅限可信局域网直连或 Tailscale / WireGuard 等端到端加密组网环境。
- **Windows 锁屏状态下桌面交互受限**：Windows 锁屏或进入 UAC 安全桌面时，系统会拦截桌面 UI 自动化（UIA）、抓屏与鼠标/键盘注入（同时影响桌面输入框原生同步 `native_first`），远程桌面操控需保持系统处于解锁状态（建议仅熄屏、不自动锁屏/休眠）。

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。
