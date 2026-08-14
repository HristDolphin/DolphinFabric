# 社区哈希集（Community）

社区贡献者通过 PR 提交的哈希规则，以及**第三方开源词库的本地化转换**。
**仓库只收哈希，明文永不入库**——维护者无法也不需验证内容，贡献者对自己提交的哈希负责。

## 当前收录

| 文件 | 来源 | 说明 |
|---|---|---|
| porn.hash.json | [andybrier/sensitive-words](https://github.com/andybrier/sensitive-words) 色情类.txt | 本地清洗（tools/clean_dict.py）后转哈希；明文存档 tools/raw_dicts/（gitignore，不入库） |
| weapon.hash.json | 同源 涉枪涉爆违法信息关键词.txt | 同上 |

> 政治类/广告类/网址类未收录：政治人物名单不适合开源分发且易误伤正文；广告词误报爆炸；网址列表不适合 n-gram 哈希匹配。

## 提交规则

1. 用 `tools/build_dict.py` 在本地把词表转为哈希集（明文留在自己机器）
2. 把生成的 `.hash.json` 放入本目录并 PR；文件名 = `<类别>.hash.json`
3. 每个文件必须含 `cat`（英文标识）与 `label`（中文标签）
4. 若与官方类别冲突（同 `cat`），社区版本在加载时覆盖官方对应词条——请尽量复用官方 `cat` 以归并，或改用新 `cat`

## 加载优先级

`official`（官方）→ `community`（社区）→ `user`（用户本地，最高优先）
