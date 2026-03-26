# MoFa Notebook 使用说明书

> 基于 Playwright 自动化测试验证，所有功能均已通过端到端测试。

---

## 1. 登录

打开 http://localhost:5174/login

两种登录方式：
- **Email OTP** — 输入邮箱，收到验证码后输入 6 位数字
- **Auth Token** — 点击 "Auth Token" 标签页，输入管理员 token

登录成功后自动跳转到主页（Chat 模式）。

---

## 2. 侧边栏导航

左侧侧边栏顶部有两个 Tab：

| Tab | 功能 |
|---|---|
| **Notebooks** | 进入 Notebook 管理模式（创建/浏览/编辑 notebooks） |
| **Chat** | 进入自由 AI 对话模式（不绑定 notebook） |

底部显示当前模型信息（provider/model）和用户邮箱。

---

## 3. Notebook 列表

路径：`/notebooks`

| 操作 | 说明 |
|---|---|
| **搜索** | 顶部搜索框，按标题/描述过滤 |
| **新建 Notebook** | 右上角 "+ New Notebook" 按钮 → 输入标题 → Create |
| **打开 Notebook** | 点击卡片进入详情页 |
| **删除 Notebook** | hover 卡片右上角出现删除图标 |
| **模板** | 点击 "Templates" 展开模板列表，点击 "Use Template" 创建预填 notebook |

---

## 4. Notebook 详情

进入 Notebook 后，顶部有 4 个 Tab + 分享/日程按钮：

```
← [Notebook Title]     Sources | Chat | Notes | Studio | 📅 | Share
```

### 4.1 Sources（来源管理）

管理 Notebook 的知识来源。AI 对话和课件生成都基于这些来源。

**添加来源的三种方式：**

| 方式 | 操作 |
|---|---|
| **Upload File** | 点击按钮选择 PDF/DOCX/PPTX/TXT/MD/图片文件上传 |
| **Add URL** | 点击按钮 → 输入网页 URL → Add。后端自动抓取网页内容 |
| **Paste Text** | 点击按钮 → 输入标题（可选）+ 粘贴文本内容 → Add |

添加后来源会显示状态：
- `ready` — 解析完成，可以用于对话
- `parsing` — 正在解析中
- `error` — 解析失败

**来源过滤：**
每个来源前有勾选框，可以选择哪些来源参与 AI 对话。点击 "Select All" / "Deselect All" 快速操作。

### 4.2 Chat（AI 对话）

基于来源的 RAG（检索增强生成）对话。

**使用流程：**
1. 首次打开显示 5 个推荐问题（可直接点击发送）
2. 在底部输入框输入问题，按 Enter 或点击发送按钮
3. AI 回复基于你上传的来源内容，并附带引用标记

**引用标记 `¹²³`：**
- AI 回复中的蓝色上标数字是来源引用
- 对应 `[src:N]` 格式，N 为来源编号
- 点击引用可跳转到来源内容（TODO: 完善跳转交互）

**保存到笔记：**
每条 AI 回复底部有 "Save" 按钮，点击将回复保存为笔记。

### 4.3 Notes（笔记）

管理学习笔记。

| 操作 | 说明 |
|---|---|
| **New Note** | 手动创建笔记，支持 Markdown 格式 |
| **编辑** | hover 笔记卡片出现编辑图标，点击进入编辑模式 |
| **删除** | hover 出现删除图标 |
| **Export All** | 导出所有笔记为 Markdown 文件下载 |
| **Select 多选** | 进入多选模式，选中多条笔记后可用 AI 整合生成摘要 |

### 4.4 Studio（课件生成工坊）

基于来源内容一键生成 9 种课件格式：

| 课件类型 | 说明 | 配置项 |
|---|---|---|
| **Slides** | PPT 演示文稿大纲 | 6 种风格（Corporate/Minimal/Cyberpunk/Chinese Traditional/Academic/Creative）+ 页数（8/12/16） |
| **Quiz** | 交互式测验题 | 自动生成 3-5 道选择题，可点击作答，即时评分 |
| **Flashcards** | 翻转学习闪卡 | 正面问题/反面答案，支持"认识/不认识"标记 |
| **Mind Map** | 思维导图 | 自动生成 Mermaid 图表渲染 |
| **Audio** | 播客对话脚本 | 两位主持人对话格式（Deep Dive/Brief/Critique） |
| **Infographic** | 信息图 | 4 种风格（Cyberpunk/Magazine/Minimal/Multi-section） |
| **Comic** | 漫画讲解 | 4 种风格（xkcd/manga/pop-art/snoopy）+ 格数（4/6/8） |
| **Report** | 结构化报告 | 3 种格式（Summary/Detailed/Data Table），可下载 Word/Excel |
| **Research** | 深度研究 | Fast Search（快速搜索 + 导入为来源）/ Deep Research（多角度深度研究） |

**使用流程：**
1. 点击想要的课件类型
2. 选择配置（风格/格式/页数等）
3. 点击 "Generate" 按钮
4. 等待 AI 生成（通常 5-60 秒，取决于内容复杂度）
5. 查看结果，可下载或重新生成

**Share to Chat：**
Studio 底部有 IM 推送区域，可选择渠道（WeChat/Feishu/Telegram/Discord）和内容，一键推送。

---

## 5. 分享

Notebook 详情页右上角 "Share" 按钮：

- 输入邮箱 + 选择角色（Viewer/Editor）→ 分享
- 查看已分享列表，可撤销
- 复制分享链接

---

## 6. 定时推送

详情页的日历图标按钮，设置定时推送：

- 选择频率（Daily/Weekly）
- 选择时间
- 选择内容类型（Flashcard Review/Daily Summary）

---

## 7. Library（图书馆）

路径：`/library`

两个视图：

### Bookshelf（书架）
- 网格展示所有书籍（彩色封面 + 标题/作者/分类号）
- 左侧筛选栏：按学科（Science/Math/Literature/History）和年级过滤
- 顶部搜索栏：按标题/作者/ISBN 搜索
- 点击书籍 → 创建对应的 Notebook

### Stats（统计）
- 总量卡片：Notebooks / Sources / Notes / Users
- 本周活跃度柱状图
- 热门书籍排行榜

---

## 启动方式

```bash
# 1. 启动 Octos 后端
ANTHROPIC_API_KEY=your-key octos serve --port 9326 --auth-token your-token --config ~/.crew/config.json

# 2. 启动前端
cd octos-web && npm run dev

# 3. 打开浏览器
open http://localhost:5174
```

---

## 测试验证

所有功能已通过 Playwright 自动化测试：

| # | 功能 | 状态 |
|---|---|---|
| 1 | Login (Auth Token) | ✅ PASS |
| 2 | Sidebar → Notebooks | ✅ PASS |
| 3 | Sidebar → Chat | ✅ PASS |
| 4 | Notebook Search | ✅ PASS |
| 5 | Templates | ✅ PASS |
| 6 | Create Notebook | ✅ PASS |
| 7 | Add Text Source | ✅ PASS |
| 8 | Add URL Source | ✅ PASS |
| 9 | Suggested Questions | ✅ PASS |
| 10 | Chat RAG Response | ✅ PASS |
| 11 | Chat Citations [src:N] | ✅ PASS |
| 12 | Save to Note | ✅ PASS |
| 13 | Create Note | ✅ PASS |
| 14 | Export Notes | ✅ PASS |
| 15 | Studio: Slides | ✅ PASS (15s) |
| 16 | Studio: Quiz | ✅ PASS (10s) |
| 17 | Studio: Flashcards | ✅ PASS (5s) |
| 18 | Studio: Mind Map | ✅ PASS (5s) |
| 19 | Studio: Audio | ✅ PASS (10s) |
| 20 | Studio: Infographic | ✅ PASS (10s) |
| 21 | Studio: Comic | ✅ PASS (10s) |
| 22 | Studio: Report | ✅ PASS (10s) |
| 23 | Share Dialog | ✅ PASS |
| 24 | Library Bookshelf | ✅ PASS |
| 25 | Library Filter | ✅ PASS |
| 26 | Library Stats | ✅ PASS |
