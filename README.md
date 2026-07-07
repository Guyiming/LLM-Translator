# LLM Translator（Firefox 扩展）

基于 **LLM API**（Anthropic / OpenAI / DeepSeek / GLM 等兼容接口）的网页双语对照翻译扩展。保留原文，在原文下方插入译文（浅灰文字 + 左侧蓝色边框）。

## 功能

- ✅ 整页翻译：识别正文段落，逐段在原文下方追加译文
- ✅ 选中文本翻译：右键 / popup 翻译选中内容
- ✅ 双语对照样式（浅灰 + 左边框 + 缩进），支持暗色模式自适应
- ✅ 并发翻译 + 进度浮层
- ✅ 用户自定义 Base URL / API Key / 模型 / 目标语言 / Prompt
- ✅ 兼容 Anthropic、OpenAI、DeepSeek、GLM 等 API 及第三方代理（兼容 OpenAI 风格返回）
- ✅ 中英文界面自动切换（跟随浏览器 UI 语言：`zh*` 中文，其它英文）

## 安装（Firefox）

1. 打开 Firefox，地址栏输入 `about:debugging#/runtime/this-firefox`
2. 点击「临时加载附加组件…」
3. 选择本目录下的 `manifest.json` 文件
4. 扩展图标出现在工具栏，即可使用

> 临时加载的扩展重启 Firefox 后会消失。如需长期使用，可使用 Firefox Developer Edition / Nightly 通过 `about:debugging` 加载，或签名后安装。

## 配置

1. 点击工具栏扩展图标 →「设置」（或右键扩展 → 选项）
2. 填写：
   - **API 协议**：根据服务商选择
     - `Anthropic 风格` → 端点 `/v1/messages`，用 `x-api-key` 认证（Anthropic 官方及兼容代理）
     - `OpenAI 风格` → 端点 `/v1/chat/completions`，用 `Authorization: Bearer` 认证（OpenAI、DeepSeek、GLM、one-api 等）
   - **Base URL**：API 服务地址（带不带 `/v1` 都行，扩展会自动归一化）。仅存储在本地，不上传
   - **API Key**：对应服务的密钥
   - **模型**：如 `claude-sonnet-5`、`gpt-4o`、`deepseek-chat`、`glm-4-plus` 等
   - **API Version**：仅 Anthropic 风格生效，默认 `2023-06-01`
3. 点击「测试连接」验证配置
4. 设置目标语言、源语言、并发数、Prompt 模板后保存

### 常见服务商配置示例

| 服务商 | 协议 | Base URL | 模型示例 |
|--------|------|----------|----------|
| Anthropic 官方 | Anthropic | `https://api.anthropic.com` | `claude-sonnet-5` |
| OpenAI 官方 | OpenAI | `https://api.openai.com` | `gpt-4o` |
| DeepSeek | OpenAI | `https://api.deepseek.com` | `deepseek-chat` |
| 智谱 GLM | OpenAI | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| one-api / new-api | OpenAI | 自部署地址 | 对应模型名 |
| OpenRouter | OpenAI | `https://openrouter.ai/api` | `openai/gpt-4o` |

## 使用

| 操作 | 动作 |
|------|------|
| 翻译整页 | 点击工具栏图标 →「翻译整页」；或右键页面 →「LLM 翻译：整页」 |
| 翻译选中 | 选中文字 → 点击工具栏图标 →「翻译选中内容」；或右键 →「LLM 翻译：选中内容」 |

翻译过程中右上角显示进度（已翻译/总段数）。译文以浅灰带左边框样式插入到原文下方。

## 文件结构

```
aitranslator/
├── manifest.json        扩展清单（MV3, Firefox）
├── background.js        后台：右键菜单 + Anthropic API 调用
├── content.js           页面注入：段落识别 + 双语对照渲染
├── content.css          译文样式
├── options.html/js      配置页
├── popup.html/js        工具栏弹窗
├── _locales/
│   ├── zh_CN/messages.json   中文文案
│   └── en/messages.json      英文文案（default_locale 兜底）
└── icons/               16/48/128 图标
```

## 界面语言

扩展使用标准 WebExtensions i18n。`manifest.json` 中 `default_locale` 为 `en`，并包含 `zh_CN` 语言包。加载时：

- 浏览器 UI 语言为 `zh*`（zh-CN / zh-TW / zh-HK 等）→ 自动使用中文界面
- 其它语言 → 使用英文界面（en 兜底）

目标语言 / 源语言在配置页以代码存储（`zh`/`en`/`auto`…），调用 API 时按当前界面语言映射为本地化名称填入 prompt。

## 关于 Base URL

扩展在选项页读取用户填写的 Base URL，归一化（去掉结尾 `/` 与 `/v1`）后，按所选 **API 协议** 拼接端点调用 LLM API：

- **Anthropic 风格** → `POST {base}/v1/messages`，请求头 `x-api-key` + `anthropic-version`，解析 `content[].text`
- **OpenAI 风格** → `POST {base}/v1/chat/completions`，请求头 `Authorization: Bearer`，解析 `choices[0].message.content`

两种风格都做了返回格式的交叉兼容回退，方便接入各类代理。

- 第三方代理：填代理完整地址即可（带不带 `/v1` 都行）
- 不依赖本地 CLI，跨设备可用

## 备注

- 浏览器内部页面（`about:*`、`moz-extension:*` 等）无法注入，扩展会提示
- 代码块、输入框、脚本等节点会自动跳过
- 单页超过 500 段会提示确认，避免大量 token 消耗
