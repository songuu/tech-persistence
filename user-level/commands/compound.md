---
description: "澶嶅埄姝ラ锛氭彁鍙栫粡楠屸啋鍐欏叆鏈兘+rules+瑙ｅ喅鏂规+閲囬泦 skill 浣跨敤淇″彿"
---

# /compound 鈥?澶嶅埄寰幆锛堟牳蹇冩楠わ級

铻嶅悎 Compound Engineering 鐨勫鍒╂満鍒?+ 鏈兘绯荤粺鐨勮嚜鍔ㄥ涔?+ Skill 鑷凯浠ｇ殑淇″彿閲囬泦銆?**姣忔鏈夋剰涔夌殑宸ヤ綔缁撴潫鍚庨兘搴旀墽琛屻€?*

## 鎵ц娴佺▼

### 姝ラ 1: 鎵弿浼氳瘽锛屾彁鍙?6 绫荤煡璇?| 绫诲瀷 | 鍐欏叆浣嶇疆 |
|------|---------|
| 瑙ｅ喅鏂规 | `docs/solutions/` + CLAUDE.md 绱㈠紩 |
| 韪╁潙璁板綍 | `.claude/rules/debugging-gotchas.md` |
| 鏋舵瀯鍐崇瓥 | `.claude/rules/architecture.md` |
| 琛屼负鏈兘 | `~/.claude/homunculus/instincts/` |
| 妯″紡鍙戠幇 | `.claude/rules/` 瀵瑰簲鏂囦欢 |
| 鎬ц兘鏁版嵁 | `.claude/rules/performance.md` |

### 姝ラ 2: 鐢熸垚瑙ｅ喅鏂规鏂囨。
瀵规瘡涓В鍐崇殑閲嶈闂锛屽垱寤?`docs/solutions/{date}-{slug}.md`锛堝惈 YAML frontmatter锛夛紝骞跺湪 CLAUDE.md 鐨勮В鍐虫柟妗堢储寮曡拷鍔犱竴琛屾憳瑕併€?
### 姝ラ 3: 鎻愬彇缁忛獙鍒?rules

**榛樿**锛氭墍鏈夌粡楠屽啓鍏ラ」鐩骇锛坄<project>/CLAUDE.md` 鎶€鏈矇娣€娈?鎴?`<project>/.claude/rules/`锛夈€?
**渚嬪**锛氬彧鏈夊悓鏃舵弧瓒充笅鍒?**鍏ㄩ儴 5 鏉?* 鏃讹紝鎵嶅厑璁稿啓鍏?`~/.claude/CLAUDE.md`锛?
- **G1 路 鏃犻」鐩棔杩?* 鈥?涓嶅惈椤圭洰鍚嶃€佷骇鍝佸悕銆佹枃浠惰矾寰勩€佹帴鍙ｅ悕銆佷笟鍔℃湳璇?- **G2 路 鏃犳妧鏈爤缁戝畾** 鈥?涓嶇粦瀹氱壒瀹氬簱/妗嗘灦/鐗堟湰锛?mermaid v11"銆?React 18 hydration"銆?FastGPT SSE" 鍧囦笉绠楅€氱敤锛?- **G3 路 鏂规硶璁鸿€岄潪淇** 鈥?鏄師鍒欐垨鏂规硶锛屼笉鏄煇涓?bug 鐨勫叿浣撹В鍐虫柟妗?- **G4 路 澶氶」鐩獙璇?* 鈥?鑷冲皯鍦?2 涓笉鍚岄」鐩腑鐙珛瑙傚療杩囧悓涓€鐜拌薄锛堝崟娆¤瀵熶竴寰嬩笉閫氳繃锛?- **G5 路 鍗曞彞鏅€?* 鈥?鑳界敤涓€鍙ヨ瘽琛ㄨ堪鎴愯法鎶€鏈爤銆佽法璇█閮芥垚绔嬬殑閫氱敤瑙勫垯

鍒ゅ畾鍘熷垯锛?
- 浠讳綍涓€鏉′笉婊¤冻 鈫?蹇呴』鍐欓」鐩骇
- 瀛樼枒 鈫?鍐欓」鐩骇
- 鍐欏叆鍓嶅繀椤诲湪杈撳嚭鎶ュ憡涓€愭潯鍒楀嚭 Gate 鍒ゅ畾锛堚渽/鉂?+ 鐞嗙敱锛夛紝璁╃敤鎴疯兘 review 骞跺惁鍐?- 甯︽渚?寮曠敤鐨勬潯鐩紙"妗堜緥锛歺xx 椤圭洰"锛夊ぉ鐒朵笉閫氳繃 G1

娉ㄦ剰锛氳В鍐虫柟妗堟枃妗ｏ紙姝ラ 2锛夊缁堝啓椤圭洰绾?`docs/solutions/`锛屽叾鎽樿绱㈠紩涔熷彧鍦ㄩ」鐩?`CLAUDE.md` 缁存姢锛屼笉鍐欑敤鎴风骇銆?
### 姝ラ 4: 鍒涘缓/鏇存柊鏈兘
- 鐢ㄦ埛绾犳 鈫?type: user_correction, 缃俊搴?0.5+
- 瑙ｅ喅鑰楁椂 bug 鈫?type: error_resolution, 缃俊搴?0.3-0.7
- 鍙嶅浣跨敤宸ヤ綔娴?鈫?type: repeated_workflow, 缃俊搴?0.3
- 鏄庣‘鍋忓ソ閫夋嫨 鈫?type: tool_preference, 缃俊搴?0.5
- 宸叉湁鏈兘鍐嶆瑙傚療 鈫?缃俊搴?+0.1

### 姝ラ 5: 鏁村悎 /review 鍙戠幇
妫€鏌ュ鏌ユ姤鍛婁腑鏍囨敞 `[馃 鏂板彂鐜癩` 鐨勬潯鐩紝鎻愬彇涓烘湰鑳芥垨 rules銆?
### 姝ラ 6: 閲囬泦 Skill 浣跨敤淇″彿锛堟柊澧烇級
妫€鏌ユ湰娆′細璇濅腑鎵ц杩囧摢浜?skill/鍛戒护锛屽姣忎釜璁板綍锛?
```json
{
  "skill": "skill鍚?,
  "timestamp": "ISO鏃ユ湡",
  "signals": {
    "invocation": "explicit|auto|skipped",
    "steps_completed": [1,2,3],
    "steps_skipped": [4],
    "user_corrections": ["鍏蜂綋绾犳鍐呭"],
    "outcome": "completed|abandoned",
    "related_instincts_created": ["id"]
  }
}
```

杩藉姞鍒?`~/.claude/homunculus/skill-signals/{skill-name}.jsonl`銆?
濡傛灉鏌?skill 鐨勬斁寮冪巼 > 30% 鎴栫籂姝?3+ 娆★紝闄勫姞鎻愮ず锛?```
馃挕 /prototype 杩戞湡浣跨敤淇″彿寮傚父锛堟斁寮冪巼 40%锛夛紝寤鸿 /skill-diagnose prototype
```

### 姝ラ 7: 鏈兘涓?skill 宸紓鏍囪
妫€鏌ユ柊鍒涘缓鐨勬湰鑳芥槸鍚︿笌鏌愪釜鐜版湁 skill 鐩稿叧浣嗘湭琚惛鏀躲€傚鏋滄槸锛屽湪鏈兘鏂囦欢涓爣璁?`pending_absorption: "{skill-name}"`銆傜疮绉?5+ 涓緟鍚告敹鏈兘鏃舵彁绀猴細
```
馃挕 5 涓柊鏈兘涓?/review 鐩稿叧浣嗘湭琚惛鏀讹紝寤鸿 /skill-improve review --absorb
```

### 姝ラ 8: 杈撳嚭鎶ュ憡
```
馃攧 Compound 澶嶅埄鎶ュ憡

馃搫 瑙ｅ喅鏂规: N 涓?鈫?docs/solutions/
馃摑 缁忛獙: rules/ +N 鏉?| CLAUDE.md +N 鏉?馃 鏈兘: 馃啎 N 涓?| 猬嗭笍 N 涓?馃搳 Skill 淇″彿: 閲囬泦 N 涓?skill 鐨勪娇鐢ㄦ暟鎹?鈿狅笍 Skill 寮傚父: [濡傛灉鏈塢

鏈」鐩疮璁? N 瑙ｅ喅鏂规, M 鏈兘, K 鏉?rules
```

