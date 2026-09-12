---
name: handoff
description: 把当前对话压缩成一份交接文档，供下一个全新 agent 接续。
argument-hint: "下一个会话将用来做什么？"
disable-model-invocation: true
---

把当前对话压缩成一份交接文档，让全新 agent 无需重读父会话即可接续工作。

## 存放与复用

- **已有则复写**：若会话上下文中已存在交接文档（本会话早前写过，或会话开启时注入了一份），整篇重写该文件，不新建。
- **否则新建**：工作区有 `.workspace-docs/` 时写 `.workspace-docs/notes/<仓库或主题>/`，交接本质上就是一篇 note；否则写目标仓库现有的文档目录。文件名带日期前缀，沿用目录内现有命名风格。
- 写入 `.workspace-docs/` 时新建文件带 OKF 头（`type: Note` 及 `title`/`description`/`tags`/`status`/`repos`），不登记 `index.md`；提交/推送遵循该仓库既有纪律。目标仓库无此约定时用其现有文档格式。
- 两个位置都不存在时，回退写 OS 临时目录。

## 内容要求

- 含「建议技能」一节，提示接手 agent 应调用的技能。
- 不复述已落盘物（spec、plan、ADR、issue、commit、diff）的内容，只给路径或 URL。
- 只写客观事实与验证证据，不写自我免责叙事。
- 脱敏 API key、密码、个人身份信息等敏感内容。
- 用户带参数调用时，参数即下一会话焦点，据此裁剪文档。
