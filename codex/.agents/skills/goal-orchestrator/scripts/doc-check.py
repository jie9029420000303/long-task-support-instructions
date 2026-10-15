#!/usr/bin/env python3
"""文件類成品的執行端檢查：只用這支腳本，不另派子代理預檢內容或外觀（2026-10-15 定案）。

用法：
  python3 doc-check.py --md 完整說明.md --facts 事實表.md
         [--derived 簡報.html 旁白.txt ...] [--source-map 出處對照.json] [--keep 保留清單.txt]
         [--repo 專案根] [--ignore-number 正規式 ...] [--json]

檢查項目（全部只讀，不改任何檔）：
  簡體字    .md、衍生件與事實表裡出現只在簡體中文使用的字。
  連結      Markdown 連結與 HTML href／src 指向的本機檔不存在。
  程式行號  檔名:行號（給 --repo 時）指向的檔不存在或行號超出檔案長度。
  事實表    事實表缺讀取時間；.md 裡的數字在事實表找不到（清單編號、標題編號、檔名:行號不算）。
  衍生件    簡報、旁白等衍生件裡的數字在 .md 找不到（衍生件只從 .md 取材，不另寫新數字）。
  保留清單  保留清單的每一行在 .md 與衍生件都找不到。
  出處對照  對照表指向的 .md 標題不存在；有衍生件完全沒有對照紀錄。
  占位字    .md 或衍生件還留著模板的「（填入：…）」或 {{…}}。
結束碼：0 沒有問題；1 有問題（逐項列出檔名與行號）；2 參數或檔案錯誤。

背景：GDB v1.2.0（2026-10-14～15）開發 76 分鐘，文件做了 12 小時以上；退件 21 項中 15 項是內容與程式或主機不符，
外觀查核跑了 14 輪、82 個子代理。事實表先行加上這支腳本，讓執行端不必再派子代理預檢，獨立驗收只由監督做一次。
"""
import argparse
import html
import json
import re
import sys
import urllib.parse
from pathlib import Path

# 只收在繁體中文不使用的簡體字；后、里、面、干、台、系、着、云、范、涂、内這類兩岸都可能出現的字不收，避免誤報。
SIMPLIFIED = set(
    "这们来时说为会个国发过对动与关开没还进实现点问题应样种机数据务设计认证号码页图录视频让场当网络统体记产节业东车长门见头书写"
    "学习买卖亲观觉边经结给线组织终维级纪约红绝续编请读谁调谈论讨访试详语误话该识译选连运远适递达钱铁银错链锁镜闭间闻阅队阶际"
    "陆险随难须顺预领风飞饭马驱验鱼鸟龙齐齿将专两严丢乐乡乱争亏亚亿仅从仓仪价众优伞伟传伤伦伪侠侣侦侧侨俭债倾偿储党兰兴"
    "养兽册军农冯决况冻净凉减凑凤凭凯击创删别剂剧劝办励劲劳势勋华协单卢卫却厂厅历压厌厕厢厦县参双变叙叠叹吓吕吗启吴员呜响"
    "哑哗唤啸喷嘱团园围圆圣坏块坚坛坝坟坠垄垒执扩扫扬扰抚抛抢护报担拟拢拣拥拦拨择挂挡挣挤挥捞损换捣掷摄摆摇撑敌斋断无旧旷显"
    "晋晒晓晕暂术杀杂权条杨极构枪柜标栏树档桥检楼欢欧残毁毕气汇汉汤沟沪泪泻泼泽洁浅浆测济浏浓涛涨润涩渊渐渔湾湿满滚滞滤滥"
    "灭灯灵灾炉炼烂烛烟热爱爷牵犹狭猎献环画畅疗疯痒盏盐监盖盘矫矿砖础硕确碍礼祷祸离积称稳穷窃窍竞笔笋筑签简类粮紧纠纤纬纯纱"
    "纲纳纵纷纸纹纺练细绍绑绕绘继绩综绿缓缘缩缴罗罚罢翘耸职联聪肃肠肤肿胀胁胜脉脏脑脚脱舰艺芦苏苹茎荐荡荣药莱获萝营葱蓝虑"
    "虚虽蚀蛮补衬袭装规览触誉订训议讯讲许评诉诊词诗诚询诸课谋谓谢谱贝负贡财责贤败货质贩购贯贴贵费贺资赏赔赖赚赛赞赠赶趋跃践"
    "踪轨转轮软轰轻载较辅辆辈辑输辞辩辽迁迈违迟逻遗邮邻郑酱释钟钢钥钮铃铜铭铺销锅锋键镇闪闲闷闹阀阔阳阴阵陈隐雾韩顶项顾顿频"
    "颜额饥饮饰饱馆驶驻驾骑骗鲁鲜鸡鸣鸭麦黄龟"
)
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")
CODE_EXT = ("py|js|cjs|mjs|ts|tsx|jsx|go|rb|java|kt|swift|sh|sql|yml|yaml|json|toml|ini|cfg|conf|service|timer|"
            "md|html|css|php|rs|c|h|cpp|txt|env")
LINE_REF = re.compile(r"(?<![\w/.-])((?:[\w.-]+/)*[\w.-]+\.(?:" + CODE_EXT + r")):(\d+)(?:[-–](\d+))?")
MD_LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
HTML_LINK = re.compile(r"(?:href|src)\s*=\s*[\"']([^\"']+)[\"']", re.I)
LIST_MARK = re.compile(r"^\s*(?:[-*+]\s+)?\d+[.)、．]\s")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
READ_AT = re.compile(r"讀取時間|readAt|read_at|讀取於")
PLACEHOLDER = re.compile(r"（填入[^）]*）|\{\{[^}]*\}\}")


def visible_text(path, raw):
    """HTML 只留讀者看得到的文字（保留換行，行號仍對得上原檔）；其他格式原樣。"""
    if path.suffix.lower() not in (".html", ".htm"):
        return raw
    blank = lambda match: " " + "\n" * match.group(0).count("\n")
    raw = re.sub(r"<(script|style)\b.*?</\1>", blank, raw, flags=re.S | re.I)
    raw = re.sub(r"<!--.*?-->", blank, raw, flags=re.S)
    return html.unescape(re.sub(r"<[^>]+>", blank, raw))


def numbers(text, ignore, skip_structure):
    found = {}
    for no, line in enumerate(text.splitlines(), 1):
        if skip_structure:
            line = LIST_MARK.sub(" ", line)
            heading = HEADING.match(line)
            if heading:
                line = re.sub(r"^[\d.]+\s*", "", heading.group(2))
        line = LINE_REF.sub(" ", line)
        for token in NUMBER.findall(line):
            value = token.replace(",", "")
            if value and not any(rule.fullmatch(value) for rule in ignore):
                found.setdefault(value, no)
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description="文件類成品的執行端腳本檢查")
    parser.add_argument("--md", required=True, help="唯一內容來源（完整說明 .md）")
    parser.add_argument("--facts", required=True, help="事實表（同一時點由腳本讀出，表頭寫讀取時間）")
    parser.add_argument("--derived", nargs="*", default=[], help="從 .md 取材的衍生件：簡報 HTML、旁白文字、流程圖文字等")
    parser.add_argument("--source-map", help="出處對照表 JSON：[{\"file\":…,\"page\":…,\"md\":\"## 標題\"}]")
    parser.add_argument("--keep", help="保留清單：每行一項，必須仍出現在 .md 或衍生件")
    parser.add_argument("--repo", help="專案根；給了才核對「檔名:行號」")
    parser.add_argument("--ignore-number", action="append", default=[], help="不需對照的數字（正規式，整段比對）")
    parser.add_argument("--json", action="store_true", help="輸出 JSON")
    args = parser.parse_args(argv)

    try:
        md_path, facts_path = Path(args.md), Path(args.facts)
        md_text, facts_text = md_path.read_text(encoding="utf-8"), facts_path.read_text(encoding="utf-8")
        derived = [(Path(p), Path(p).read_text(encoding="utf-8")) for p in args.derived]
        source_map = json.loads(Path(args.source_map).read_text(encoding="utf-8")) if args.source_map else None
        keep = [l.strip() for l in Path(args.keep).read_text(encoding="utf-8").splitlines()
                if l.strip() and not l.strip().startswith("#")] if args.keep else []
        ignore = [re.compile(rule) for rule in args.ignore_number]
    except (OSError, ValueError, re.error) as error:
        print(f"doc-check：參數或檔案錯誤：{error}", file=sys.stderr)
        return 2
    if source_map is not None and not isinstance(source_map, list):
        print("doc-check：出處對照表必須是 JSON 陣列", file=sys.stderr)
        return 2

    problems = []

    def report(kind, where, detail):
        problems.append({"kind": kind, "where": where, "detail": detail})

    for path, raw in [(md_path, md_text), (facts_path, facts_text)] + derived:
        for no, line in enumerate(visible_text(path, raw).splitlines(), 1):
            chars = sorted({c for c in line if c in SIMPLIFIED})
            if chars:
                report("簡體字", f"{path}:{no}", "、".join(chars))

    for path, raw in [(md_path, md_text)] + derived:
        for no, line in enumerate(raw.splitlines(), 1):
            for target in MD_LINK.findall(line) + HTML_LINK.findall(line):
                if re.match(r"^(?:[a-z][a-z0-9+.-]*:|#|//)", target, re.I):
                    continue
                local = urllib.parse.unquote(target.split("#")[0].split("?")[0])
                if local and not (Path(local) if Path(local).is_absolute() else path.parent / local).exists():
                    report("連結", f"{path}:{no}", f"找不到 {target}")

    if args.repo:
        repo = Path(args.repo)
        for path, raw in [(md_path, md_text), (facts_path, facts_text)] + derived:
            for no, line in enumerate(raw.splitlines(), 1):
                for name, start, end in LINE_REF.findall(line):
                    target = repo / name
                    if not target.is_file():
                        report("程式行號", f"{path}:{no}", f"{name} 不在 {repo}")
                        continue
                    total = len(target.read_text(encoding="utf-8", errors="replace").splitlines())
                    last = int(end or start)
                    if int(start) < 1 or last > total:
                        report("程式行號", f"{path}:{no}", f"{name}:{start}{'-' + end if end else ''} 超出檔案長度 {total} 行")

    if not READ_AT.search("\n".join(facts_text.splitlines()[:15])):
        report("事實表", str(facts_path), "表頭缺讀取時間（同一時點由腳本讀出，寫明讀取時間）")
    fact_numbers = set(numbers(facts_text, ignore, False))
    for value, no in sorted(numbers(md_text, ignore, True).items(), key=lambda item: item[1]):
        if value not in fact_numbers:
            report("事實表", f"{md_path}:{no}", f"數字 {value} 在事實表找不到")

    md_numbers = set(numbers(md_text, ignore, False))
    for path, raw in derived:
        for value, no in sorted(numbers(visible_text(path, raw), ignore, False).items(), key=lambda item: item[1]):
            if value not in md_numbers:
                report("衍生件", f"{path}:{no}", f"數字 {value} 在 .md 找不到")

    combined = md_text + "\n" + "\n".join(visible_text(p, r) for p, r in derived)
    for path, raw in [(md_path, md_text)] + derived:
        for no, line in enumerate(raw.splitlines(), 1):
            for hit in PLACEHOLDER.findall(line):
                report("占位字", f"{path}:{no}", f"還沒替換：{hit}")

    for item in keep:
        if item not in combined:
            report("保留清單", args.keep, f"找不到「{item}」")

    if source_map is not None:
        headings = {HEADING.match(l).group(2) for l in md_text.splitlines() if HEADING.match(l)}
        mapped = set()
        for at, entry in enumerate(source_map, 1):
            heading = HEADING.match(str(entry.get("md", "")).strip()) if isinstance(entry, dict) else None
            title = heading.group(2) if heading else str(entry.get("md", "")).strip() if isinstance(entry, dict) else ""
            if not title or title not in headings:
                report("出處對照", f"{args.source_map}#{at}", f"對到的 .md 標題「{title}」不存在")
            if isinstance(entry, dict) and entry.get("file"):
                mapped.add(Path(str(entry["file"])).name)
        for path, _ in derived:
            if path.name not in mapped:
                report("出處對照", str(path), "這份衍生件沒有任何出處對照紀錄")

    if args.json:
        print(json.dumps({"problems": problems, "count": len(problems)}, ensure_ascii=False, indent=1))
    else:
        for item in problems:
            print(f"[{item['kind']}] {item['where']}：{item['detail']}")
        print(f"doc-check：{len(problems)} 項問題" if problems else "doc-check：沒有問題")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
