# 本地记录协议

## 目录与调用

脚本位置相对于本技能为 `scripts/story_memory.mjs`。使用已知的技能绝对路径调用；Node.js 18+，无 npm 依赖。档案路径必须显式给出，脚本不会把数据写进安装目录，也不会根据当前目录猜测课程。

课程项目结构：

```text
连载故事语言学习/
  README.md
  data/
    courses/<课程标识>/memory.json
    events/<事件ID>.json
```

`memory.json` 是完整权威档案，不需要依赖聊天历史或另外的数据库。`events/` 是提交 payload 的暂存 / 可审计文件，可定期归档；它不替代档案。课程标识使用简短、安全的名称，一个题材 / 学习语言一份档案。新建课程项目时服从所在工作区的 README 索引规则。

命令形状：

```powershell
node "<技能绝对目录>/scripts/story_memory.mjs" status --file "<课程项目>/data/courses/<课程标识>/memory.json"
node "<技能绝对目录>/scripts/story_memory.mjs" episode --file "<档案绝对路径>" --payload "<事件JSON绝对路径>"
node "<技能绝对目录>/scripts/story_memory.mjs" show --file "<档案绝对路径>" --section sentences --offset 0 --limit 5
node "<技能绝对目录>/scripts/story_memory.mjs" count --text-file "<英文正文文件绝对路径>"
```

所有写入事件必须含独立 `eventId`，例如 `lesson-E0001-save`。相同事件 ID、相同内容的重试只返回此前结果；不同内容必须换事件 ID。未知结果时先查状态，再用完全相同 payload 重试。不要重复批改同一小题来推动复习日期。

## 档案结构与读取

schemaVersion 2 包含 `courseId/title/profile/bible/learner/episodes/items/quizzes/pendingQuizId/waivers/events/revision/migrations` 和建立 / 更新时刻。episode 额外保存 serial 与逐项 learningGoals；词条额外保存三维 mastery 证据和语境 exposures。测验分别保存每题回答日期与整套完成日期，不能混用。

schemaVersion 1 可以只读恢复，`upgradeNeeded` 为 true。首次成功写入或显式 `migrate` 才保存为 2，.bak 保留原版；旧正文、目标、题目、回答、过关状态与复习历史原样保留，三维掌握初始未知，不反推补填。schema 未知或损坏时停止覆盖。

- `status`：输出课程摘要、当前阶段、未过目标、待答题数量和首批到期词条。reviewPlan 给当天配额、已完成数、待修复数、优先词条与剩余积压；dueHasMore / focusHasMore 指示还有内容。读取不会修改学习成果。
- `show --section bible`：返回字段目录、类型、总数量和简短预览；用 `--field timeline|cast|openThreads` 读取字段并分页。嵌套对象可用 `--field cast.0.relationship`；数组 offset 是行号，字符串 offset 是字符位（每页最多 1600 字符），hasMore 表明还有内容。目录不是完整设定，不能将预览写回原件。
- `show --section learner`：学习画像字段目录；例如 `--field skills.grammar.window` 查看证据页。status 的 learningPlan 给调整建议，recyclePlan 给旧词复现优先项。
- `show --section story`：指定 / 最新集原文，超过 8000 字符时有 `storyTruncated`。长正文可用 sentences 分页重组。
- `show --section sentences|focus|items`：全文讲解、当集重点或全库词条，分页默认 10，最大 30。
- `show --section quiz`：待答题；没有待答题时展示最近一次题目，包含已答标记，不包含答案。
- `show --section next-questions`：仅未答题，默认按 profile.quizBatchSize 显示 3 题；可 --limit 覆盖。本批答完再次调用自动取下一批，不含参考答案与评分依据。
- `show --section grading`：教师批改用参考答案与已保存回答。用户回答后按需要读取，不提前向用户展示答案。quiz / grading 可用 `--quiz T0001` 查询指定历史题。
- `show --section quizzes`：历史测验摘要。`--episode E0001` 可选择历史集的正文 / 教案 / 重点。

数组和字符串输出有上限，原始档案保持完整。跨会话恢复：先 status，确认当前集和待答题，再读取所需教案或题目页；有部分作答时接续未答题，不能重新生成一份替代它。

## 写入契约

下列字段除了明确可选的项均须提供；JSON 使用 UTF-8。每个事件额外带 `eventId`。大段内容写入 payload 文件，以结构化文件传参，避免拼进 shell 字符串。

| 命令 | payload 字段与行为 |
| --- | --- |
| `init` | `courseId`、`title`、`profile`（可省略采用默认值）、`bible`；bible 至少有非空 `premise`，其余字段按故事设计文档填充；已存在的不同课程不会被覆盖 |
| `configure` | `patch`：可更新原有偏好及 dailyMinutes / teachingBatchSize / quizBatchSize / difficultyPreference / newVocabularyPreference / reviewPolicy / reviewItemsPerDay；改变学习语言另建课程，不重置已学成果 |
| `episode` | `title/story/recap/sentences/focus`，可选 `bibleUpdate/reusedIds/reuseContexts/serial/learningGoals`；未解锁、词数超限、缺句、重复词条或教案字段缺失都会拒绝 |
| `teach` | `throughSentence` 为已讲完的单元序号；可选 `focusTaught: true`；断点只能前进，全文与重点均讲完才转 `awaiting_quiz` |
| `skip-teaching` | `userRequest/reason`；用户明确自学或省略剩余讲解时才用，保留真实断点与 teachingOmission，进入待测而不通过；若明确取消待答 practice 另加 cancelPractice: true，不可取消正式试卷 |
| `quiz` | `scope: lesson/review/practice`、`questions`；结业补测另需非空 `reteachNotes`；不能覆盖已有待答测验；随堂 practice 可只覆盖当前小组目标 |
| `answer` | `quizId`、`marks`；支持分批作答；词条相关题批改齐全即可记录该词证据与日程，整套答完才判定结业；practice 不更新词条掌握或复习 |
| `reassess` | `quizId/reason/marks`；按原答案复核最近一份待答或已批改试卷。每项仅含 questionId / score / feedback，可含完整 targetMarks；原回答、日期和帮助证据不可更改 |
| `assessment-note` | `quizId/reason/note`；任一历史试卷均可附复核结论，保留说明但不更改评分、掌握或日程 |
| `items` | `userRequest`（用户指定不熟词的原请求）、`items`（词条数组）；已存在词条更新教学内容并添加来源，加入本次回忆队列，不重置复习历史，也不直接改掌握证据 |
| `dismiss` | quizId / userRequest / reason：仅取消当前可选 practice，保留已有回答与教学阶段，不跳过本段目标；lesson / review 须遵从明确的 waive 请求 |
| `waive` | `userRequest/reason`，以及 `episode: true` 和 / 或明确的 `reviewItemIds`；跳过当集且未指定词条范围时，同步暂缓该集未考重点，其他旧词仍检查；已有待答题且用户明确放弃时另设 `cancelPendingQuiz: true`，保留历史回答；暂缓只作用于当天，次日重新到期 |
| `migrate` | 仅需 eventId；将旧版档案的兼容扩展正式写入，保留旧目标和真实证据 |

`sentences` 的每个对象：`english/meaning/chunks/grammar/words` 均为非空字符串。脚本生成连续句号 ID；英文合并并规范化空白后必须与 `story` 相同，包括拼写和标点。

`focus` / `items` 的词条：`term/kind/sense/meaning`；`kind` 为 word / phrase / pattern。`focus` 还须完整提供 `pronunciation/usage/memory/example`。用户补充的词也应尽量写全，但先记录再补教案亦可。`sense` 是稳定语境义标识，如 `hesitate-reluctance`；同一个词同一个义项沿用，避免仅因中文释义换个说法就新建一条。ID 按语言、类型、规范化词形和 sense 计算，同词不同义可以分别复习。

`episode` 返回词条 ID 和 requiredTargets，新重点分别为 `item:V…:meaning|usage|production`。`learningGoals` 数组中每项为 `{kind: grammar或comprehension或expression, id: 稳定短标识, description: 必学目标说明}`；相应类别使用逐项目标，未提供的类别保留通用目标。考题引用返回的准确 ID。每题需 `id`（可省略自动 Q1…）、`prompt/expected/criteria/targets`。需要细分反馈时拆小题；综合题验证多个维度须有充分语义证据。首次结业覆盖全部目标，补测覆盖所有尚未通过目标。

每题可另设 responseLanguage 为 en / zh-CN / flexible，英语表达目标默认 en，其他默认 flexible。故事理解和结构解释可中文回答；production / transfer / goal:expression 必须有实际英语表达才给独立正确。新试卷 evidenceContract: 1 拒绝把仅中文自述标为独立英语表达，综合题仍允许中文解释保留词义和用法分。它只检查是否有拉丁文字证据，不能判断这些字母真是正确英语；语义、任务完成、拼写与结构仍由教师按 criteria 批改。不能把模型示例当成学生回答。旧契约历史保持原记录，不自动改分。

skip-teaching 是省略讲解，waive episode 是跳过当集。省略后必须真实答题才能 passed；taughtThrough / focusTaught 不伪造，重试不重复创建省略记录。后续用户要求补讲时用 teach 写实际补讲断点，保留省略历史和原考核状态，不把已通过改回待测。正式题已展示后若补讲给了目标答案，记录帮助并换新题验证，不把随后复述算独立回答。

`serial` 包含 arcId / chapterId / sceneId / sceneStatus（open / closed）。脚本按同场景自动生成 segment；省略时接续上一场景。`bibleUpdate.timeline/worldRules` 数组追加去重；cast / openThreads 的对象用稳定 id 更新同一条目、没有 id 的旧文本保留，resolved 伏笔保留历史而不删除。对象字段合并，不把增量数组当成完整替换。

`reusedIds` 只引用已有词条；`reuseContexts` 每项为 `{itemId, sentenceId, example, contextTag}`，example 必须是本集该句实际英文。曝光统计计不同学习片段和语境标签，仅阅读复现不更新间隔。recyclePlan 是建议，记录实际使用的词，不为填计划硬插对白。

`answer.marks` 每项：`questionId/answer/score/assistance/feedback`。score 为 0 / 1 / 2，assistance 为 none / hint / answer_seen。将用户的真实回答写进 answer，明确“不会”也可记录为真实回答并给 0 分；缺失答案不能由教师编造。提示或答案曝光后即使表面正确也不贡献独立过关证据。同一次测验同一词多次受测，按最低独立表现更新一次，避免重复推进。

综合题可另加 targetMarks，以本题的准确目标字符串为键，每项含 score / assistance / feedback。提供时必须恰好覆盖该题全部 targets；整体 score 为各目标原始分的最低值。目标级反馈保留正确维度，仅未通过的维度待补。局部 hint 不拖累另一个独立正确的目标；整题 assistance 为 hint / answer_seen 时仍影响所有目标，目标级 none 不能掩盖整题答案曝光。省略 targetMarks 的旧题继续使用整题评分。

用户质疑评分或教师发现误判时，先按题干、criteria、原答案及帮助证据复核。确认是评分错误后使用 reassess；不能另编 answer 或以新的教师答案替代旧回答。有 targetMarks 的题需更正相应目标分，不能只调整体分。复核不重新出题、不增加一次学习尝试；画像重新统计，词条回到本次评分前的快照后按原作答日期重算，撤销误判造成的 lapses / needsRepair。批次未答完时仍保留待答题，整套未完不能解锁。

可靠回滚限于最近试卷：结业题还须属于当前集、有目标快照，相关词条须具有应用前后快照且没有后续变化。已有后续试卷、后续剧情、跳过状态、用户新指定复习或无快照旧档时拒绝回滚并保持原件。此时使用 assessment-note 保存具体更正结论，告诉用户“原答经复核符合要求，但历史日程未重算”；需要后续能力证据时采用最新状态安排短测，不让用户为教师误判重复整套考题。教师造成的争议不能当作学生不会的证据。show 的 corrections / assessment-notes 按 --quiz 与分页查看原评分、新评分和复核说明。

reassess 示例：`{eventId: "correct-T0001-Q2", quizId: "T0001", reason: "原题允许祈使句，原回答已表达打开窗户", marks: [{questionId: "Q2", score: 2, feedback: "Please open the window. 符合原题要求；撤销误判"}]}`。以上仅是调用结构示例，不能写入真实用户课程当作学员答案。

## 日期、门槛与持久化

正文计数把数字视为词，含内部撇号或连字符的词视为一个（如 don't、well-known）；标题和教案由分开的字段排除。新语言需另行确认计量与教学方式，v1 的默认课程为英语。

日期由 IANA 时区生成自然日，默认 Asia/Shanghai。独立正确且真正到期时推进到下一个间隔（1、3、7、14、30、60 天），早于到期日的正确回忆不延后原计划，同一天不会多次跃迁。错误重置阶段并增加错误次数；有提示保持 / 缩短到次日，两者均进入当次补测。修复后从 1 天间隔重新验证。某个维度正确而其他已知弱维度仍未修复时，词条整体保持待补、次日复习，不重复增加错误次数，也不延长间隔。

新重点先到期于本日，直至完成当集测验。全文未讲完、必学目标未通过或仍有待答题都阻止 episode。新课 balanced 每天优先独立复习 reviewItemsPerDay 个旧项（默认 5，少于 15 分钟的新课默认 3），本日复习错题仍须修复；达到日计划后可以续写，其余旧项保持原到期日期与待复习事实，不自动 waive。strict 仍要求全部到期项完成。旧档没有 reviewPolicy 时按 strict 读取，不静默放宽；用户选择后 configure 可改 balanced。阅读曝光不推进间隔。

脚本用独占 `.lock`、随机临时文件、刷盘与原子替换写入；每次修改保留上一版本 `.bak`。失败时原件保持有效；损坏 / schema 不支持时保留原件并停止写入。遗留锁先检查 PID 是否仍在写入，确认进程结束后才清理；不能遇锁就强行重试。需要恢复备份时先保存损坏原件，再验证 .bak 的 JSON 和进度后恢复，不能静默丢掉更新。

本地档案可能含个人偏好和回答，保留在用户选择的位置，不自动上传。脚本保障记录、日期和门槛；故事质量、英语准确性与答案语义评分仍由教师完成，不能宣称机器文件验证了真实学习能力。
