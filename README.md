# 🤖 CF ChatUI

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/stephenlzc/cf-chatui)
[![Workers AI](https://img.shields.io/badge/Powered%20by-Workers%20AI-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers-ai/)
[![License](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

> 🎯 **零門檻使用大模型** - 無需部署服務器，無需申請 API Key，直接調用 [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) 的免費/付費模型

CF ChatUI 是一個基於 **Cloudflare Workers AI** 的多功能 AI 對話 Web 界面，讓您在幾分鐘內即可搭建自己的 AI 聊天平臺。支持文本對話、圖像生成和文本嵌入，所有計算都在 Cloudflare 邊緣節點完成。

<!-- 截圖佔位符 - 上傳 screenshot.png 後解除註釋
![CF ChatUI Screenshot](https://raw.githubusercontent.com/stephenlzc/cf-chatui/main/screenshot.png)
-->

## ✨ 功能特性

### 🤖 AI 模型支持
- 💬 **多模型對話** - GLM-4.7-Flash、GPT-OSS-120B 等
- 🎨 **AI 圖像生成** - FLUX.2 Dev 高質量圖像創作
- 📊 **文本嵌入** - Plamo Embedding 向量化處理

### 🛠️ 平臺特性
- 🔐 **安全認證** - JWT 身份驗證，保護您的 AI 服務
- 🌓 **深色主題** - 現代化的 ChatGPT 風格界面
- 📱 **響應式設計** - 適配桌面和移動設備
- ⚡ **邊緣計算** - 基於 Cloudflare Workers 全球部署
- 🆓 **零運維成本** - 無需管理服務器，按需付費

### 🔧 可配置性
本項目採用高度模塊化設計，未來版本將支持更多自定義配置：
- 自定義系統提示詞
- 模型參數調整（temperature、max_tokens 等）
- 主題和皮膚定製
- 插件擴展系統
- 多用戶角色管理
- API 速率限制配置
- 更多 AI 模型接入

## 🌟 爲什麼選擇 CF ChatUI？

### vs 傳統 AI API 方案

| 特性 | OpenAI/Claude API | **CF ChatUI + Workers AI** |
|------|-------------------|---------------------------|
| API Key 申請 | ❌ 需要信用卡，審覈嚴格 | ✅ 無需申請，即開即用 |
| 服務器部署 | ❌ 需要 VPS/雲服務器 | ✅ 純 Serverless，零運維 |
| 全球訪問速度 | ⚠️ 依賴服務器位置 | ✅ Cloudflare 全球邊緣節點 |
| 成本 | 💰 按量付費，可能較高 | 🆓 免費額度 + 低價按量 |
| 隱私安全 | ⚠️ 數據發送到第三方 | ✅ 數據在 Cloudflare 邊緣處理 |

### 誰適合使用？

- 👨‍💻 **開發者** - 快速搭建 AI 演示或原型
- 🏢 **小團隊** - 無需 DevOps 的 AI 解決方案
- 🎓 **學習者** - 零成本體驗大模型能力
- 🔒 **隱私敏感用戶** - 數據不經過第三方服務

## 🚀 快速開始

### 前置要求

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 安裝:
  ```bash
  npm install -g wrangler
  ```
- [Cloudflare](https://dash.cloudflare.com/sign-up) 賬戶

### 獲取所需密鑰

在部署之前，您需要獲取以下信息：

#### 1. Cloudflare 賬戶 ID

1. 登錄 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 在右側邊欄找到 **賬戶 ID** (Account ID)
3. 複製備用

#### 2. Cloudflare API Token

1. 訪問 [API Tokens 頁面](https://dash.cloudflare.com/profile/api-tokens)
2. 點擊 **創建令牌 (Create Token)**
3. 使用 **自定義令牌 (Custom token)** 模板
4. 權限設置:
   - **賬戶 (Account)** - **Cloudflare AI** - **編輯 (Edit)**
   - **賬戶 (Account)** - **Worker 腳本 (Worker Scripts)** - **編輯 (Edit)** (可選)
5. 賬戶資源: 包含您的賬戶
6. 創建並複製令牌

#### 3. 自定義配置 (可選)

- `AUTH_PASSWORD` - 登錄密碼 (默認: `Admin12345%`)
- `SESSION_SECRET` - JWT 簽名密鑰 (建議使用隨機字符串)

### 部署步驟

#### 方式一: 使用 Wrangler CLI

```bash
# 1. 克隆倉庫
git clone https://github.com/stephenlzc/cf-chatui.git
cd cf-chatui

# 2. 安裝依賴
npm install

# 3. 設置 Secrets (推薦方式)
# 注意: wrangler.toml 已包含在倉庫中，無需額外配置
wrangler secret put CF_ACCOUNT_ID
# 輸入您的 Cloudflare 賬戶 ID

wrangler secret put CF_API_TOKEN
# 輸入您的 Cloudflare API Token

wrangler secret put AUTH_PASSWORD
# 輸入您想要的登錄密碼

wrangler secret put SESSION_SECRET
# 輸入隨機生成的密鑰 (可使用: openssl rand -base64 32)

# 4. 部署
wrangler deploy
```

#### 方式二: 使用 .dev.vars (本地開發)

```bash
# 1. 創建本地環境變量文件
cp .dev.vars.example .dev.vars

# 2. 編輯 .dev.vars 填入實際值
# CF_ACCOUNT_ID=your_account_id
# CF_API_TOKEN=your_api_token
# AUTH_PASSWORD=your_password
# SESSION_SECRET=your_secret

# 3. 本地開發
wrangler dev

# 4. 部署到生產環境
wrangler deploy
```

#### 方式三: Cloudflare Dashboard (無需命令行)

1. Fork 此倉庫到您的 GitHub 賬戶
2. 登錄 [Cloudflare Dashboard](https://dash.cloudflare.com)
3. 進入 **Workers & Pages**
4. 點擊 **創建** → **使用 Git 創建**
5. 連接您的 GitHub 賬戶並選擇 fork 的倉庫
6. 設置環境變量:
   - 變量名: `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `AUTH_PASSWORD`, `SESSION_SECRET`
   - 加密: 建議啓用加密 (Secret)
7. 部署

### 部署後配置

部署成功後，您將獲得一個類似 `https://cf-chatui.your-account.workers.dev` 的 URL。

**首次訪問:**
- 使用設置的密碼登錄
- 默認密碼: `Admin12345%` (如果未自定義)

## 🛠️ 技術棧

- **運行時**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **AI 服務**: [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
- **前端**: 原生 JavaScript + [Tailwind CSS](https://tailwindcss.com/)
- **認證**: JWT (JSON Web Tokens)
- **圖標**: [Heroicons](https://heroicons.com/)

## 📝 支持的 AI 模型

| 類型 | 模型 | 描述 |
|------|------|------|
| 對話 | `@cf/zai-org/glm-4.7-flash` | 智譜AI快速對話模型 |
| 對話 | `@cf/openai/gpt-oss-120b` | OpenAI 開源大語言模型 |
| 圖像 | `@cf/black-forest-labs/flux-2-dev` | FLUX 高質量圖像生成 |
| 嵌入 | `@cf/pfnet/plamo-embedding-1b` | 文本嵌入向量模型 |

## 🔧 開發指南

```bash
# 安裝依賴
npm install

# 本地開發 (需配置 .dev.vars)
wrangler dev

# 部署到生產環境
wrangler deploy

# 查看日誌
wrangler tail
```

### 項目結構

```
cf-chatui/
├── src/
│   └── index.ts          # 主入口 (Worker + 前端)
├── wrangler.toml         # Cloudflare Workers 配置
├── .wrangler.toml.example # 配置文件模板
├── .dev.vars.example     # 本地環境變量模板
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## 💰 Workers AI 定價

Cloudflare Workers AI 提供**免費額度**，對於個人使用通常足夠：

| 模型類型 | 免費額度 | 超出後價格 |
|---------|---------|-----------|
| 文本生成 (GLM/GPT) | 每天 10,000 次請求 | $0.001-0.003 / 1K tokens |
| 圖像生成 (FLUX) | 每天 100 張 | $0.02-0.05 / 張 |
| 文本嵌入 | 每天 100,000 次 | $0.0001 / 1K tokens |

> 📌 **提示**: 免費額度每日重置，足夠個人日常使用。查看 [官方定價](https://developers.cloudflare.com/workers-ai/pricing/) 獲取最新信息。

## 🔒 安全建議

1. **更改默認密碼** - 部署後立即修改 `AUTH_PASSWORD`
2. **使用強密鑰** - `SESSION_SECRET` 建議使用 `openssl rand -base64 32` 生成
3. **保護 API Token** - 使用 `wrangler secret put` 加密存儲
4. **定期輪換密鑰** - 建議定期更新 `SESSION_SECRET` 和 `CF_API_TOKEN`

## 🐛 已知問題

**⚠️ 詳細的 Bug 清單請看 [BUGS.md](./BUGS.md)**

主要已知問題：
- 🔴 **GPT-OSS-120B** 模型響應不穩定
- 🟠 **中文編碼** 在某些瀏覽器下有問題
- 🟡 **聊天記錄** 頁面刷新後丟失
- 🟡 **Token 過期** 前端無自動檢測

我們持續跟蹤和修復問題，歡迎提交 [Issue](https://github.com/stephenlzc/cf-chatui/issues) 報告新 Bug！

## 🗺️ 路線圖

### 近期計劃 (v1.x)
- [ ] 📝 **聊天記錄持久化** - 支持查看歷史對話
- [ ] 💾 **本地存儲** - 瀏覽器本地緩存對話
- [ ] 🎨 **主題系統** - 可自定義界面顏色和風格
- [ ] ⚙️ **模型參數配置** - 調整 temperature、max_tokens 等

### 中期計劃 (v2.x)
- [ ] 🌐 **多語言支持** - 界面國際化 (i18n)
- [ ] 🔑 **多用戶支持** - 用戶管理和權限控制
- [ ] 🧩 **插件系統** - 支持自定義擴展
- [ ] 📤 **文件上傳** - 支持文檔和圖片上傳分析
- [ ] 🤖 **更多模型** - 集成更多 Workers AI 模型

### 長期願景
- [ ] 🏗️ **可視化配置器** - 無需代碼即可定製功能
- [ ] 🔌 **API 網關** - 統一的 AI 模型接入層
- [ ] 📊 **使用分析** - 用量統計和成本監控

## 🤝 貢獻

歡迎提交 Issue 和 Pull Request！

1. Fork 本倉庫
2. 創建您的功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打開 Pull Request

## 📄 許可證

本項目採用 [MIT](LICENSE) 許可證。

## 🙏 致謝

<p align="center">
  <b>本項目由 <a href="https://kimi.moonshot.cn"><img src="https://img.shields.io/badge/Built%20with-Kimi%20K2.5-FF6B6B?style=for-the-badge&logo=openai&logoColor=white" alt="Kimi K2.5" height="28"></a> 協助開發</b>
</p>

### 特別感謝

<table align="center">
  <tr>
    <td align="center" width="200">
      <a href="https://www.moonshot.cn/">
        <img src="https://img.shields.io/badge/Moonshot%20AI-Kimi%20大模型-8B5CF6?style=flat-square&logo=openai&logoColor=white" alt="Moonshot AI" height="24">
      </a>
      <br>
      <sub>
        <a href="https://github.com/MoonshotAI"><img src="https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white" height="16"></a>
        <a href="https://huggingface.co/moonshotai"><img src="https://img.shields.io/badge/HuggingFace-FFD21E?style=flat-square&logo=huggingface&logoColor=black" height="16"></a>
      </sub>
    </td>
    <td align="center" width="200">
      <a href="https://www.cloudflare.com/">
        <img src="https://img.shields.io/badge/Cloudflare-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare" height="24">
      </a>
      <br>
      <sub>Workers & Workers AI 平臺</sub>
    </td>
    <td align="center" width="200">
      <a href="https://tailwindcss.com/">
        <img src="https://img.shields.io/badge/Tailwind%20CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" height="24">
      </a>
      <br>
      <sub>優秀的 CSS 框架</sub>
    </td>
  </tr>
</table>

---

<p align="center">
  <img src="https://img.shields.io/badge/Made%20with-❤️-ff69b4?style=for-the-badge" alt="Made with love">
  <br><br>
  <sub>Powered by <a href="https://kimi.moonshot.cn">Kimi K2.5</a> × <a href="https://workers.cloudflare.com">Cloudflare Workers</a></sub>
</p>
