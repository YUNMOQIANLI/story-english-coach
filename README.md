# 连载故事英语私教

**把你喜欢的故事，变成可以持续学习的英语课程。**

`story-english-coach` 是一套面向 AI 助手的技能：根据你喜欢的原创或二创题材创作英文连载，用中文逐句讲解，再通过真实答题、错题补测和间隔复习巩固学习。故事设定、教学断点和学习记录保存在本地，方便下次接着学。

适合想通过科幻、奇幻、推理、校园、恋爱等故事学习英语的人，也支持从简单短句开始、固定难度或调整每集词数。

## 能做什么

- **按你的喜好设计故事**：确定世界观、主人公、人物关系和主线，持续记录伏笔与剧情发展。
- **按词数创作英文片段**：默认每集约 200 词，可调整为 500 词或要求恰好指定词数。
- **用中文逐句精讲**：先抓句意和主干，再讲语法、搭配、词汇、表达思维、叙事效果与发音。
- **根据实际作答过关**：分批出题，逐项目标评分；错误先补讲，再换新语境补测。
- **安排间隔复习**：依据真实学习表现，按 1、3、7、14、30、60 天逐级安排复习，让旧词自然回到新故事中。
- **跨会话接续**：本地档案保存正文、完整教案、作答、评分、复习时间与教学断点。

## 安装

需要支持 `SKILL.md` 技能的 AI 助手。配套脚本需要 **Node.js 18+**，仅使用 Node.js 内置库，无需安装第三方依赖。

以当前用户的 `.agents/skills` 技能目录为例：

Windows PowerShell：

```powershell
git clone https://github.com/YUNMOQIANLI/story-english-coach.git "$env:USERPROFILE\.agents\skills\story-english-coach"
```

macOS / Linux：

```bash
git clone https://github.com/YUNMOQIANLI/story-english-coach.git ~/.agents/skills/story-english-coach
```

也可以下载仓库 ZIP，将整个目录解压为技能目录中的 `story-english-coach/`。确保该目录直接包含 `SKILL.md`、`agents/`、`references/` 和 `scripts/`。安装目录若已有同名技能，请先备份。安装后重新打开或刷新助手的技能列表；其他客户端按其技能安装规则放置。

## 开始使用

第一次开课：

```text
使用 $story-english-coach。
我想用原创科幻冒险故事学英语，由我担任主人公。
我的基础比较薄弱，每集 200 个英文单词，用中文逐句讲解。
先帮我确定角色和短期主线，再开始第一集，保存学习进度。
```

接着上次的课程：

```text
使用 $story-english-coach，继续我的故事英语课程。
```

收录不熟悉的表达：

```text
这集的 hesitate 和 in charge of 我不熟，请重点讲解并加入复习。
```

“继续”会根据学习档案接续：正在讲解就继续讲解，有待答题就先完成作答，需要补测就先补测；当前学习和本日复习完成后，再接下一段故事。你也可以明确提出调整学习节奏、暂缓复习或跳过某次考核，档案会如实记录你的选择。

## 一次课程怎样进行

1. 确认题材、角色、难度与学习量。
2. 创作一段英文故事，核对词数并保存完整教案。
3. 每批精讲 2–3 句，保存教学断点。
4. 分批完成故事理解、重点词汇、语法与表达题，通常每次约 3 题。
5. 针对错误补讲、补测，按实际作答记录掌握情况。
6. 完成本日复习，再继续剧情；下次从本地档案接续。

逐句讲解采用八个步骤：**快速拆读 → 语法结构 → 固定搭配 → 核心词汇 → 中英思维 → 叙事与镜头 → 纯英文回读 → 发音语流**。

## 学习记录

技能规则放在安装目录；个人课程数据另存于你的课程项目：

```text
story-language-learning/
└── data/
    └── courses/
        └── <课程标识>/
            └── memory.json
```

可以指定课程项目位置；助手也会遵守所在工作区的目录规范。`memory.json` 保存课程设定、故事、教案、词条、真实回答、评分、复习历史与断点。写入采用文件锁、临时文件、原子替换及上一版备份，并支持重复事件去重。

本地脚本负责记录、词数核对和日期计算；故事创作、中文教学与语义评分由 AI 助手完成。学习安排是辅助建议，实际效果取决于持续练习与反馈。

## 仓库结构

```text
story-english-coach/
├── SKILL.md                  # 技能入口与教学流程
├── agents/openai.yaml        # 技能显示名称与默认调用提示
├── references/               # 故事、教学、学习体验和本地记录协议
└── scripts/
    ├── story_memory.mjs      # 学习档案、词数、教学状态与考核记录
    ├── learning_model.mjs    # 学习画像与课程规划
    └── review_forecast.mjs   # 复习负担与新增词汇规划
```

查看脚本命令：

```bash
node scripts/story_memory.mjs --help
```

查看已有课程状态：

```bash
node scripts/story_memory.mjs status --file /path/to/course/memory.json
```

更多细节见 [技能规则](SKILL.md)、[教学与考核](references/teaching-and-assessment.md)、[学习者体验](references/learner-experience.md) 和 [本地记录协议](references/local-memory.md)。
