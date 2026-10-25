window.__ModuleLoader__.load({
	id: "dsh-memory-fish",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/** 与宿主同源的面板 API（host 插件注册的路由）。 */
		const API = "/memory-fish/api";

		async function api(path, body) {
			const res = await fetch(`${API}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			return await res.json();
		}

		const S = {
			wrap: { padding: "12px 4px", display: "flex", flexDirection: "column", gap: "14px", color: "var(--fg-primary, inherit)" },
			cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: "8px" },
			card: { border: "1px solid var(--border-default, #2a3547)", borderRadius: "8px", padding: "8px 10px" },
			k: { fontSize: "11px", opacity: 0.65 },
			v: { fontSize: "18px", fontWeight: 600, marginTop: "2px" },
			bar: { height: "6px", background: "rgba(127,127,127,.2)", borderRadius: "3px", overflow: "hidden", marginTop: "6px" },
			barFill: { height: "100%", background: "var(--accent-primary, #4cc2ff)" },
			section: { border: "1px solid var(--border-default, #2a3547)", borderRadius: "8px", padding: "10px" },
			h2: { fontSize: "13px", fontWeight: 600, margin: "0 0 8px", opacity: 0.9 },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			input: { flex: 1, minWidth: "160px", padding: "5px 8px", borderRadius: "6px", border: "1px solid var(--border-default, #2a3547)", background: "transparent", color: "inherit", fontSize: "13px" },
			textarea: { width: "100%", minHeight: "74px", padding: "6px 8px", borderRadius: "6px", border: "1px solid var(--border-default, #2a3547)", background: "transparent", color: "inherit", fontSize: "13px", fontFamily: "inherit", resize: "vertical" },
			btn: { padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--border-default, #2a3547)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12px" },
			btnPrimary: { padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--accent-primary, #4cc2ff)", background: "var(--accent-primary, #4cc2ff)", color: "#04121c", cursor: "pointer", fontSize: "12px", fontWeight: 600 },
			mem: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid rgba(127,127,127,.18)" },
			memMain: { flex: 1, minWidth: 0 },
			title: { fontSize: "13px", fontWeight: 600 },
			meta: { fontSize: "11px", opacity: 0.6, marginTop: "2px" },
			tag: { display: "inline-block", marginLeft: "5px", padding: "0 5px", borderRadius: "4px", background: "rgba(76,194,255,.14)", color: "var(--accent-primary, #4cc2ff)", fontSize: "10px" },
			pre: { whiteSpace: "pre-wrap", fontSize: "11px", lineHeight: 1.5, maxHeight: "220px", overflow: "auto", margin: "8px 0 0", opacity: 0.85 },
			muted: { fontSize: "11px", opacity: 0.6 }
		};

		const name = "dsh-memory-fish";
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-memory-fish",
				order: 75,
				label: () => "小肥鱼记忆"
			}, () => h(MemoryPanel)));
		}

		function MemoryPanel() {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState("");
			const [query, setQuery] = react.useState("");
			const [results, setResults] = react.useState(null);
			const [profileDraft, setProfileDraft] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [notice, setNotice] = react.useState("");

			const load = react.useCallback(async () => {
				try {
					const d = await api("/state");
					if (d.ok !== true) throw new Error(d.error || "加载失败");
					setData(d);
					setError("");
					setProfileDraft(prev => prev === null ? d.profile : prev);
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				}
			}, []);

			react.useEffect(() => {
				load();
				const timer = setInterval(load, 10000);
				return () => clearInterval(timer);
			}, [load]);

			const act = async (label, body) => {
				setBusy(label);
				setNotice("");
				try {
					const r = await api("/action", body);
					if (r.ok !== true) setNotice(r.message || r.error || "操作失败");
					else setNotice("已完成");
					await load();
				} catch (e) {
					setNotice(String(e && e.message ? e.message : e));
				} finally {
					setBusy("");
				}
			};

			if (error !== "") return h("div", { style: S.wrap }, h("div", { style: S.muted }, `小肥鱼记忆加载失败：${error}`));
			if (data === null) return h("div", { style: S.wrap }, h("div", { style: S.muted }, "正在加载记忆…"));

			const pct = Math.min(100, Math.round((data.injected / Math.max(1, data.budget)) * 100));
			const entries = results === null ? data.entries : results;

			return h("div", { style: S.wrap },
				h("div", { style: S.cards },
					h(Card, { k: "注入 tokens", v: `${data.injected} / ${data.budget}`, extra: h("div", { style: S.bar }, h("i", { style: { ...S.barFill, width: `${pct}%`, display: "block" } })) }),
					h(Card, { k: "活跃记忆", v: data.active }),
					h(Card, { k: "置顶", v: data.pinned }),
					h(Card, { k: "待复习", v: data.due ?? 0 }),
					h(Card, { k: "归档 / 遗忘", v: data.archived }),
					h(Card, { k: "今日对话", v: data.todayMessages }),
					h(Card, { k: "候选线索", v: data.dreamCues })
				),

				h("div", { style: S.section },
					h("h2", { style: S.h2 }, "L0 画像（每次会话常驻注入）"),
					h("textarea", {
						style: S.textarea,
						value: profileDraft === null ? data.profile : profileDraft,
						onChange: e => setProfileDraft(e.target.value)
					}),
					h("div", { style: { ...S.row, marginTop: "6px" } },
						h("button", { style: S.btnPrimary, disabled: busy !== "", onClick: () => act("profile", { action: "profile", content: profileDraft ?? data.profile }) }, busy === "profile" ? "保存中…" : "保存画像"),
						h("span", { style: S.muted }, `约 ${data.profileTokens} tokens`)
					)
				),

				h("div", { style: S.section },
					h("h2", { style: S.h2 }, "记忆（热索引 + 冷区）"),
					h("div", { style: S.row },
						h("input", {
							style: S.input,
							placeholder: "搜索记忆：标题 / 标签 / 正文",
							value: query,
							onChange: e => setQuery(e.target.value),
							onKeyDown: async e => {
								if (e.key !== "Enter") return;
								if (query.trim() === "") { setResults(null); return; }
								const r = await api("/action", { action: "search", query: query.trim() });
								setResults(r.ok === true ? (r.matches || []) : []);
							}
						}),
						h("button", { style: S.btn, onClick: async () => {
							if (query.trim() === "") { setResults(null); return; }
							const r = await api("/action", { action: "search", query: query.trim() });
							setResults(r.ok === true ? (r.matches || []) : []);
						} }, "搜索"),
						h("button", { style: S.btn, onClick: () => { setQuery(""); setResults(null); } }, "重置")
					),
					entries.length === 0
						? h("div", { style: { ...S.muted, marginTop: "8px" } }, results === null ? "还没有记忆" : "没有匹配的记忆")
						: h("div", { style: { marginTop: "8px" } }, entries.map(e => h(MemoryRow, { key: e.id, entry: e, busy, onAct: act })))
				),

				h("div", { style: S.section },
					h("h2", { style: S.h2 }, "睡梦机制"),
					h("div", { style: S.muted }, `已做梦 ${data.dreams} 次 · 最近一次：${data.lastDream === "" ? "无" : data.lastDream}`),
					h("div", { style: { ...S.row, marginTop: "6px" } },
						h("button", { style: S.btnPrimary, disabled: busy !== "", onClick: () => act("dream", { action: "dream" }) }, busy === "dream" ? "做梦ing…" : "现在做梦"),
						h("button", { style: S.btn, disabled: busy !== "", onClick: () => act("consolidate", { action: "consolidate" }) }, busy === "consolidate" ? "整理中…" : "整理记忆"),
						notice === "" ? null : h("span", { style: S.muted }, notice)
					),
					data.dreamReport === "" ? null : h("pre", { style: S.pre }, data.dreamReport)
				)
			);
		}

		function Card(props) {
			return h("div", { style: S.card },
				h("div", { style: S.k }, props.k),
				h("div", { style: S.v }, String(props.v)),
				props.extra || null
			);
		}

		function MemoryRow(props) {
			const e = props.entry;
			const isBusy = props.busy !== "";
			const mark = e.due && !e.pinned ? "⏰ " : (e.pinned ? "★ " : "");
			return h("div", { style: S.mem },
				h("div", { style: S.memMain },
					h("div", { style: S.title },
						mark,
						e.title,
						(e.tags || []).map(t => h("span", { key: t, style: S.tag }, t))
					),
					h("div", { style: S.meta }, `${e.updated} · 生效 ${e.validFrom ?? ""} · 显著性 ${e.salience ?? 5} · 重要度 ${e.importance} · 命中 ${e.hits}${e.nextReview ? ` · 复习 ${String(e.nextReview).slice(0, 10)}` : ""}`)
				),
				h("button", { style: S.btn, disabled: isBusy, onClick: () => props.onAct(e.pinned ? "unpin" : "pin", { action: e.pinned ? "unpin" : "pin", id: e.id }) }, e.pinned ? "取消置顶" : "置顶"),
				h("button", { style: S.btn, disabled: isBusy, onClick: () => props.onAct("forget", { action: "forget", id: e.id }) }, "遗忘")
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
