# 人物分析质量样本

`evaluation/ai-corpus.json` 是人工标注的少量中英文回归样本，包含直接对话、代词不明、身份揭示、同名不同人、缩写引号、人工纠错，以及公版文学的节选。标签不是模型回答，不能用标签本身宣称模型准确率。

真实文学样本来自鲁迅《孔乙己》（1919）及 Lewis Carroll 的 *Alice's Adventures in Wonderland*（1865）第五章。原文来源、作者与权利说明保存在 corpus 的 `sources`；原作公有领域状态分别见[维基文库](https://zh.wikisource.org/wiki/%E5%AD%94%E4%B9%99%E5%B7%B1)及[Project Gutenberg 目录](https://www.gutenberg.org/ebooks/11)。仅使用少量原文节选，没有现代译文或插图；英文段落合并了源文件的排版换行。其余场景是本项目原创。

`npm test` 检查实际对白扫描器的 UTF-16 定位、英文缩写及引号边界，并把提取统计写入忽略目录 `artifacts/qa/v04-dialogue-quality.json`。引用题辞也可能被扫描为候选，这是单独记录的假阳性；模型应保留未知，而不是猜说话人。中英文真实模型归属质量在获得新的付费授权前不作结论。

本轮无费用提取回归：9 个场景、24 句人工标注对白全部准确定位，另提取了《孔乙己》题辞中的 1 段引用，提取精确率 96%、召回率 100%。这些数字只针对这份小样本的对白定位，不能代表说话人归属准确率。故障注入检查能分别发现漏句、未知被强猜、同人拆分、同名错合并和人工纠正被覆盖。

离线评估命令不包含网络或模型调用：

```sh
node scripts/evaluate-ai-quality.mjs
node scripts/evaluate-ai-quality.mjs --predictions recorded-results.json --provenance "model/version, consent and run date" --out quality-report.json
```

输入是已记录结果的规范化数组，每条包含 `caseId, chapterIndex, paragraph, start, end, speaker, characterId, source`。章节、段落及字符位置从 0 开始，字符位置采用 JavaScript UTF-16；`speaker` 和 `characterId` 在未知时为 `null`，`source` 为 `ai` 或 `manual`。ID 应先按已确认的身份合并链归一化；未知实体不计入跨章一致性分母。报告分别给出定位精确率/召回率、已定位句的归属正确率、未知比例、跨章同人/异人矛盾、人工修改保留数及按场景分组的错误。它只评估提供的记录，不能验证记录确实来自某个模型。

测试会故意注入漏句、强猜、错合并、拆分身份和覆盖人工修改，确认这些错误能被单独发现；这组故障注入结果不代表 DeepSeek 实测成绩。整本复杂小说的质量评估需要更多人工金标和单独授权的真实输出。
