# Vocab Podcast Web — 需求与设计

目标

- 为 `/Users/sungeng/Documents/danish-vocabulary` 里已清洗的单词表，建立一个可以部署在 GitHub Pages 的静态学习系统。
- 系统以播客/听力材料为中心：上传音频 + transcript（或提供已对齐的 WebVTT/JSON），可以逐句同步高亮、播放控制（暂停、倍速、点读）。
- 文本与词表联动：悬停单词显示快速释义，支持标记掌握程度（识别/未识别/部分掌握），并在 transcript 中以同色系深浅反映掌握度。
- 与 Anki 集成：可从词表导出 TSV/Note，以便导入 Anki；允许从 Anki 导入/对照（初版为导出功能）。

用户故事

- 学习者上传/选择一集音频 + transcript（或直接拖入 WebVTT）；播放器自动逐句高亮并支持点读与倍速。
- 当句子播放时，当前句高亮并滚动到视野中央；单词悬停显示 `lemma`、中文、英文释义与示例；点击单词切换掌握/未掌握。
- 用户可打开词汇面板查看本集词汇（按频率排序），标记若干词导出为 Anki TSV。

设计原则

- 纯静态优先：易部署到 GitHub Pages（无后端）；所有用户数据（掌握标记）保存在 `localStorage`，并提供导出/导入按钮用于在设备间同步。
- 可再现的数据流程：词表由 `data/enrichment/manual/cleaned_outputs`（由已存在的清洗脚本生成）构建成前端友好的 `vocab_index.json`。
- 对齐/时间戳采用行业工具生成：推荐 `aeneas`（离线）或 `gentle`（Docker），把对齐结果导出为 WebVTT/JSON，由前端直接消费。
- 保守自动化：自动化只做明确且可回滚的变换（字符串正规化、字段标准化、倒排/词形映射）；语义修正由人工复核。

架构概览

- 静态前端：`apps/vocab-podcast-web/`（HTML/CSS/JS），托管在 GitHub Pages。
- 构建脚本：`scripts/build_vocab_index.py` 从清洗过的 JSONL 生成 `apps/vocab-podcast-web/vocab_index.json`。
- 可选离线对齐：外部使用 `aeneas` 或 `gentle` 生成 WebVTT，前端直接加载并渲染。
- Anki 导出：可直接在前端导出简单 TSV，或使用仓库现有的 `scripts/export_manual_enrichment_to_anki.py` 生成完整 Note 类型 TSV（更适合批量导出）。

数据格式

- 输入（已有）：`*.output.jsonl`（清洗后存放在 `data/enrichment/manual/cleaned_outputs`），每条记录包含 `lemma`, `zh`, `en`, `rank`, `inflection` 等。
- 生成（前端）：`vocab_index.json` — 一个 mapping，键为小写表面词形（surface form），值为对象：
  - `lemma`、`zh`、`en`、`rank`、`pos`、`forms`（所有变形）
- transcript 接口：首选 WebVTT（`start`/`end`/`text`），若无则按行分句（粗略对齐）。

前端组件（页面与核心交互）

- Uploader：选择音频与 transcript（支持 WebVTT 与纯文本）。
- 播放器：HTML5 `audio`，支持 `play/pause/seek/playbackRate`，`timeupdate` 每 250ms 更新高亮。
- Transcript 渲染器：将每句拆词并用 `<span class="word">` 包裹，单词事件：hover 显示悬浮释义卡，click 标记掌握。
- Mastery 管理：`localStorage` 保存 { surfaceForm: masteryScore }（0/1/2），并以颜色深浅映射。
- Vocab 面板：展示本集词汇（按 `rank` 升序），快速切换掌握状态并导出 Anki TSV。
- Anki 导出：导出 TSV（字段：`Lemma<TAB>MeaningZH<TAB>Tags`）或触发仓库 Python 脚本进行完整导出。

词形/映射策略

- 前端的词查找使用 `vocab_index.json` 的 surface→lemma 映射。
- 构建脚本会：
  - 将 `lemma` 与所有可用的 `inflection`/`forms`/`lexical` 中的表面形式收集为 surface forms（小写化）
  - 若表面形式重复，选择 `rank` 更低（更高频）的 lemma 作为映射目标
  - 导出包含 `forms` 列表以供未来的模糊匹配或词形还原

对齐流程（推荐）

- 如果 transcript 没有时间戳，推荐使用 `aeneas` 做自动对齐（Python，离线）或 `gentle`（Docker，本地可运行）将音频与完整 transcript 对齐，输出 WebVTT/JSON。
- 生成 WebVTT 后前端直接解析并按 cue 渲染句子。

障碍与权衡

- 无后端：掌握数据只能保存在 localStorage，需要手动导出/导入到其他设备；可选：使用 GitHub Gist 或私有后端做同步（后续功能）。
- 词形消歧：仅靠表面形式无法总是精确匹配 lemma（需词形还原工具或更多上下文）。
- 自动对齐质量依赖 transcript 精度与对齐工具；需要用户复核关键帧。

部署

- 将 `apps/vocab-podcast-web` 目录添加到仓库并启用 GitHub Pages（`gh-pages` branch 或 `main/docs` 目录），或使用 GitHub Actions 自动部署。

开发计划（短期 MVP，4 周内分阶段）

1. 需求与设计（现在完成）
2. Scaffold 静态站点（完成）
3. 构建词表索引脚本（完成）
4. 前端基本功能：播放、高亮、悬浮释义、标记（原型完成）
5. 对齐指南与自动化脚本示例（`aeneas` 运行脚本/指令）
6. 导出到 Anki（前端导出 + 结合 Python 导出）
7. 用户测试与修正

交付物（当前仓库路径）

- 前端： `apps/vocab-podcast-web/`（包含 `index.html`、`app.js`、`styles.css`、样例文件）
- 构建： `scripts/build_vocab_index.py`（从清洗后的 JSONL 生成 `vocab_index.json`）
- 词表源： `data/enrichment/manual/cleaned_outputs/`（已生成）
- 报告/说明： `apps/vocab-podcast-web/DESIGN.md`

下一步建议

- 我可以现在：
  - A) 实现并运行 `scripts/build_vocab_index.py`（把 `vocab_index.json` 写入前端目录），
  - B) 完善前端的掌握颜色渐变（根据掌握分数渲染深浅），
  - C) 添加对 WebVTT/逐词对齐的更细粒度处理（点读/跳到词边界）。

请回复你希望我先做哪项（A/B/C），或者有额外的设计偏好。
