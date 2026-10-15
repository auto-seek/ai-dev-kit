import { CARD, layoutGraph, edgePath } from "./layout.js";

(() => {
  const states = new Set(["PENDING", "READY", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED"]);
  const labels = { PENDING: "等待前置任务", READY: "待领取", ACTIVE: "执行中", COMPLETED: "已报完成", FAILED: "失败", CANCELLED: "已取消" };
  const eventLabels = { node_added: "发布任务", node_edited: "更新任务", task_claimed: "领取任务", task_completed: "报告完成", task_failed: "报告失败", task_released: "释放任务", task_renewed: "续租", task_timed_out: "租约超时", node_cancelled: "取消任务", rework_requested: "要求返工" };
  const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
  const formatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  let lastSnapshot = null, inFlight = false, pendingTarget = Boolean(location.hash);
  let selectedId = null, allTasks = false, geometry = null, openDetails = new Set();
  let byId = new Map(), cards = new Map(), paths = [];
  const returnLink = document.querySelector(".header a");
  let pan = null;
  let zoom = 1;
  function applyZoom() {
    ui.graph.style.transform = `scale(${zoom})`;
    ui["graph-space"].style.width = `${geometry.width * zoom}px`;
    ui["graph-space"].style.height = `${geometry.height * zoom}px`;
    ui["zoom-reset"].textContent = `${Math.round(zoom * 100)}%`;
    ui["zoom-reset"].setAttribute("aria-label", `当前缩放 ${Math.round(zoom * 100)}%，恢复 100%`);
    ui["zoom-out"].disabled = zoom <= 0.25;
    ui["zoom-in"].disabled = zoom >= 2;
  }
  function setZoom(value, clientX, clientY) {
    if (!geometry?.nodes.length) return;
    const next = Math.max(0.25, Math.min(2, value));
    if (next === zoom) return;
    if (pan) endPan({ pointerId: pan.pointerId });
    const viewport = ui.viewport.getBoundingClientRect();
    const x = clientX ?? viewport.left + ui.viewport.clientWidth / 2;
    const y = clientY ?? viewport.top + ui.viewport.clientHeight / 2;
    const before = ui.graph.getBoundingClientRect();
    const anchor = { x: (x - before.left) / zoom, y: (y - before.top) / zoom };
    zoom = next; applyZoom();
    const after = ui.graph.getBoundingClientRect();
    ui.viewport.scrollLeft += after.left + anchor.x * zoom - x;
    ui.viewport.scrollTop += after.top + anchor.y * zoom - y;
  }
  ui["zoom-out"].addEventListener("click", () => setZoom(zoom - 0.25));
  ui["zoom-in"].addEventListener("click", () => setZoom(zoom + 0.25));
  ui["zoom-reset"].addEventListener("click", () => setZoom(1));
  ui.viewport.addEventListener("wheel", event => {
    if ((!event.ctrlKey && !event.metaKey) || !geometry?.nodes.length) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ui.viewport.clientHeight : 1;
    setZoom(zoom * Math.exp(-event.deltaY * unit * 0.002), event.clientX, event.clientY);
  }, { passive: false });
  ui.viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === "touch" || event.target.closest(".task-card, button, a")) return;
    pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: ui.viewport.scrollLeft, top: ui.viewport.scrollTop };
    ui.viewport.setPointerCapture(event.pointerId);
    ui.viewport.classList.add("panning");
    ui.viewport.focus({ preventScroll: true });
    event.preventDefault();
  });
  ui.viewport.addEventListener("pointermove", event => {
    if (!pan || pan.pointerId !== event.pointerId) return;
    ui.viewport.scrollLeft = pan.left + pan.x - event.clientX;
    ui.viewport.scrollTop = pan.top + pan.y - event.clientY;
  });
  function endPan(event) {
    if (!pan || pan.pointerId !== event.pointerId) return;
    pan = null; ui.viewport.classList.remove("panning");
    if (ui.viewport.hasPointerCapture(event.pointerId)) ui.viewport.releasePointerCapture(event.pointerId);
  }
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) ui.viewport.addEventListener(name, endPan);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svg(tag, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  function button(text, action, className = "") {
    const node = element("button", className, text);
    node.type = "button"; node.addEventListener("click", action); return node;
  }
  function navigateButton(id, text) {
    const node = button(text, () => selectTask(id, true), "dependency-link");
    node.dataset.focusKey = `navigate:${id}`; return node;
  }
  function updateReturnLink() {
    if (!returnLink) return;
    const source = new URLSearchParams(location.hash.slice(1));
    returnLink.href = "/"; returnLink.textContent = "返回团队中心";
    for (const kind of ["request", "candidate"]) {
      const id = source.get(kind);
      if (/^[a-f0-9-]{36}$/.test(id || "")) {
        returnLink.href = `/#${kind}=${id}`;
        returnLink.textContent = kind === "request" ? "返回这条需求" : "返回这个候选"; break;
      }
    }
  }
  function revealTask() {
    updateReturnLink();
    const id = new URLSearchParams(location.hash.slice(1)).get("task");
    ui["target-notice"].hidden = true;
    if (!id) { pendingTarget = false; return; }
    if (!byId.has(id)) {
      ui["target-notice"].textContent = "当前快照中未找到指定任务。请核对任务来源或等待快照更新。";
      ui["target-notice"].hidden = false; return;
    }
    selectTask(id, true, false);
  }
  window.addEventListener("hashchange", () => { pendingTarget = Boolean(location.hash); revealTask(); });
  function assert(condition, message) {
    if (!condition) throw new Error(`快照数据错误：${message}`);
  }

  function nullableText(value) { return value === null || typeof value === "string"; }
  function isDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

  function validate(payload) {
    assert(payload && ["fresh", "error", "loading"].includes(payload.status), "未知读取状态");
    assert(typeof payload.refreshing === "boolean" && nullableText(payload.error), "读取状态字段缺失");
    assert(payload.checkedAt === null || isDate(payload.checkedAt), "检查时间无效");
    if (payload.snapshot === null) {
      assert(payload.status !== "fresh", "成功响应缺少快照");
      return;
    }
    const snapshot = payload.snapshot;
    assert(snapshot && /^[a-f0-9]{40,64}$/.test(snapshot.revision) && isDate(snapshot.fetchedAt), "快照来源无效");
    assert(typeof snapshot.project === "string" && Array.isArray(snapshot.nodes) && Array.isArray(snapshot.flow) && Array.isArray(snapshot.history), "任务列表缺失");
    assert(snapshot.lastEventAt === null || isDate(snapshot.lastEventAt), "任务事件时间无效");
    const ids = new Set();
    for (const node of snapshot.nodes) {
      assert(node && typeof node.id === "string" && node.id && !ids.has(node.id), "任务标识缺失或重复");
      ids.add(node.id);
      assert(states.has(node.state), `未知任务状态：${String(node.state)}`);
      assert(typeof node.title === "string" && typeof node.summary === "string", "任务文字字段无效");
      assert([node.owner, node.reservedFor, node.tier, node.gitRef, node.artifactRef].every(nullableText), "任务详情字段无效");
      assert(node.leaseExpiresAt === null || isDate(node.leaseExpiresAt), "租约时间无效");
      assert(Array.isArray(node.dependencies) && Array.isArray(node.events), "依赖或事件缺失");
      for (const dependency of node.dependencies) {
        assert(dependency && [dependency.id, dependency.title, dependency.expectation, dependency.promise].every(value => typeof value === "string") && states.has(dependency.state), "依赖数据无效");
      }
      for (const event of node.events) {
        assert(event && typeof event.type === "string" && isDate(event.at) && nullableText(event.agent) && nullableText(event.reason), "任务事件无效");
      }
    }
    const visible = [...snapshot.flow, ...snapshot.history];
    assert(visible.every(id => ids.has(id)) && new Set(visible).size === visible.length && visible.length === ids.size, "任务流与节点列表不一致");
    assert(snapshot.nodes.every(node => node.dependencies.every(dependency => ids.has(dependency.id))), "依赖任务不存在");
  }

  function time(value) { return formatter.format(new Date(value)); }
  function expired(node) { return node.state === "ACTIVE" && node.leaseExpiresAt !== null && Date.parse(node.leaseExpiresAt) <= Date.now(); }
  function stateLabel(node) {
    if (expired(node)) return "租约已过期 · 待确认";
    if (node.state === "PENDING" && node.dependencies.length === 0) return "等待就绪";
    return labels[node.state];
  }

  function addFact(list, title, value, className) {
    list.append(element("dt", "", title), element("dd", className, value));
  }


  function disclosure(title, key, content, open) {
    const node = element("details", "technical-details");
    node.dataset.section = key;
    node.open = open.has(key);
    const heading = element("summary", "", title); heading.dataset.focusKey = key;
    node.append(heading, content);
    node.addEventListener("toggle", () => {
      if (!ui.nodes.contains(node) || openDetails.has(key) === node.open) return;
      if (node.open) openDetails.add(key); else openDetails.delete(key);
      relayout();
    });
    return node;
  }
  function taskDetails(node, snapshot, open) {
    const details = element("div", "task-details"); details.id = "task-details";
    const lookup = new Map(snapshot.nodes.map(item => [item.id, item]));
    if (node.summary) details.append(element("p", "summary-text", node.summary));
    if (expired(node)) details.append(element("p", "state-note", "租约已到期，执行情况待确认；不代表任务失败。"));
    if (node.state === "COMPLETED") details.append(element("p", "state-note", "任务已报告完成，独立验收结论需另行核对。"));
    const dependencies = element("div", "dependency-group");
    dependencies.append(element("h2", "", "前置任务"));
    if (!node.dependencies.length) dependencies.append(element("p", "", "没有前置任务"));
    for (const dependency of node.dependencies) {
      dependencies.append(navigateButton(dependency.id, `${dependency.title || dependency.id} · ${stateLabel(lookup.get(dependency.id))}`));
    }
    details.append(dependencies);
    const downstream = snapshot.nodes.filter(item => item.dependencies.some(dependency => dependency.id === node.id));
    if (downstream.length) {
      const next = element("div", "dependency-group"); next.append(element("h2", "", "后续任务"));
      for (const child of downstream) next.append(navigateButton(child.id, `${child.title || child.id} · ${stateLabel(child)}`));
      details.append(next);
    }
    const technical = element("div", "technical-content");
    const facts = element("dl", "facts");
    addFact(facts, "任务 ID", node.id, "reference");
    addFact(facts, "原生状态", node.state);
    addFact(facts, "执行人", node.owner || "未记录");
    if (node.reservedFor) addFact(facts, "保留对象", node.reservedFor);
    addFact(facts, "最低层级", node.tier || "未指定");
    if (node.leaseExpiresAt) addFact(facts, "租约截止", time(node.leaseExpiresAt));
    technical.append(facts);
    if (node.state === "READY") technical.append(element("p", "", "待领取只表示任务状态，不证明员工在线。"));
    if (node.dependencies.length) {
      technical.append(element("h3", "", "依赖合同"));
      for (const dependency of node.dependencies) {
        const contract = element("div", "contract");
        contract.append(element("h4", "", dependency.title || dependency.id), element("p", "reference", dependency.id), element("p", "", `期望：${dependency.expectation}`), element("p", "", `承诺：${dependency.promise}`));
        technical.append(contract);
      }
    }
    technical.append(element("h3", "", "交付引用"));
    if (node.gitRef || node.artifactRef) {
      const references = element("dl", "facts");
      if (node.gitRef) addFact(references, "代码引用", node.gitRef, "reference");
      if (node.artifactRef) addFact(references, "产物引用", node.artifactRef, "reference");
      technical.append(references);
    } else technical.append(element("p", "", "当前快照未提供代码或产物引用。"));
    technical.append(element("h3", "", "最近保留的事件"));
    const recent = node.events.slice(-5);
    if (recent.length) {
      const events = element("ol", "event-list");
      for (const event of recent) {
        const item = element("li", "", `${time(event.at)} · ${eventLabels[event.type] || event.type}${event.agent ? ` · ${event.agent}` : ""}`);
        if (event.reason) item.append(element("p", "", event.reason));
        events.append(item);
      }
      technical.append(events);
      if (node.events.length > recent.length) technical.append(element("p", "", `显示 ${node.events.length} 条保留事件中最近的 5 条。`));
    } else technical.append(element("p", "", "没有保留事件；不能据此推断从未领取或执行。"));
    technical.append(element("h3", "", "快照来源"), element("p", "reference", snapshot.revision));
    details.append(disclosure("技术详情与交付记录", `technical:${node.id}`, technical, open));
    return details;
  }
  function card(node, snapshot, selection, open) {
    const expanded = node.id === selection;
    const item = element("article", `task-card state-${node.state.toLowerCase()}${expired(node) ? " lease-expired" : ""}${expanded ? " expanded" : ""}`);
    item.dataset.nodeId = node.id;
    const toggle = button("", () => selectedId === node.id ? clearSelection() : selectTask(node.id, true), "task-toggle");
    toggle.dataset.focusKey = `task:${node.id}`;
    toggle.setAttribute("aria-label", `${node.title || node.id}，${stateLabel(node)}，${node.dependencies.length} 项前置任务`);
    toggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) toggle.setAttribute("aria-controls", "task-details");
    const name = element("span", "name", node.title || node.id); name.title = node.title || node.id;
    toggle.append(name, element("span", "state", stateLabel(node))); item.append(toggle);
    if (expanded) item.append(taskDetails(node, snapshot, open));
    return item;
  }
  function expandedWidth() { return Math.max(CARD.width, Math.min(320, ui.viewport.clientWidth - 48)); }
  function prepareGraph(snapshot, scope, selection = selectedId, open = openDetails) {
    const lookup = new Map(snapshot.nodes.map(node => [node.id, node]));
    const nodes = (scope ? [...snapshot.flow, ...snapshot.history] : snapshot.flow).map(id => lookup.get(id));
    const items = new Map(nodes.map(node => [node.id, card(node, snapshot, selection, open)]));
    const dimensions = new Map();
    const expanded = items.get(selection);
    if (expanded) {
      expanded.style.width = `${expandedWidth()}px`;
      ui.measure.append(expanded);
      try {
        const box = expanded.getBoundingClientRect();
        dimensions.set(selection, { width: box.width, height: box.height });
      } finally { expanded.remove(); }
    }
    return { geometry: layoutGraph(nodes, dimensions), items };
  }
  function graphError(error) {
    ui.notice.hidden = false; ui.notice.dataset.kind = "error";
    ui["notice-title"].textContent = "依赖图绘制失败 · 保留当前视图";
    ui["notice-message"].textContent = error.message;
  }
  function readingAnchor() {
    const active = ui.nodes.contains(document.activeElement) ? document.activeElement : null;
    const target = active || cards.get(selectedId)?.querySelector(".task-toggle");
    return target ? { key: target.dataset.focusKey, top: target.getBoundingClientRect().top, left: target.getBoundingClientRect().left, focused: Boolean(active) } : null;
  }
  function restoreAnchor(anchor) {
    if (!anchor) return;
    const target = [...ui.nodes.querySelectorAll("[data-focus-key]")].find(item => item.dataset.focusKey === anchor.key);
    if (!target) return;
    const box = target.getBoundingClientRect();
    ui.viewport.scrollLeft += box.left - anchor.left;
    ui.viewport.scrollTop += box.top - anchor.top;
    if (anchor.focused) target.focus({ preventScroll: true });
  }
  function placeGraph(next) {
    geometry = next;
    const defs = svg("defs", {});
    for (const kind of ["default", "related"]) {
      const marker = svg("marker", { id: `arrow-${kind}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
      marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: `arrow ${kind}` })); defs.append(marker);
    }
    ui.edges.replaceChildren(defs); paths = [];
    for (const edge of geometry.edges) {
      const path = svg("path", { d: edgePath(edge.points), class: "edge", "marker-end": "url(#arrow-default)" });
      path.dataset.from = edge.from; path.dataset.to = edge.to;
      ui.edges.append(path); paths.push({ edge, path });
    }
    ui.edges.setAttribute("width", geometry.width); ui.edges.setAttribute("height", geometry.height);
    ui.graph.style.width = `${geometry.width}px`; ui.graph.style.height = `${geometry.height}px`;
    applyZoom();
    for (const point of geometry.nodes) {
      const item = cards.get(point.id);
      Object.assign(item.style, { left: `${point.x - point.width / 2}px`, top: `${point.y - point.height / 2}px`, width: `${point.width}px`, height: point.id === selectedId ? "auto" : `${point.height}px` });
    }
    updateHighlight();
  }
  function updateHighlight() {
    for (const { edge, path } of paths) {
      const onPath = edge.from === selectedId || edge.to === selectedId;
      path.setAttribute("class", `edge${onPath ? " related" : selectedId ? " muted" : ""}`);
      path.setAttribute("marker-end", `url(#arrow-${onPath ? "related" : "default"})`);
      if (onPath) ui.edges.append(path);
    }
  }
  function centerTask(id, focus = true) {
    const point = geometry?.nodes.find(node => node.id === id);
    if (!point) return;
    ui.viewport.scrollLeft = point.x * zoom - ui.viewport.clientWidth / 2;
    ui.viewport.scrollTop = point.height * zoom > ui.viewport.clientHeight - 48 ? (point.y - point.height / 2) * zoom - 24 : point.y * zoom - ui.viewport.clientHeight / 2;
    if (focus) cards.get(id)?.querySelector(".task-toggle").focus({ preventScroll: true });
  }
  function relayout() {
    if (!lastSnapshot || !selectedId) return;
    const anchor = readingAnchor(), expanded = cards.get(selectedId);
    if (!expanded) return;
    const previousWidth = expanded.style.width;
    expanded.style.width = `${expandedWidth()}px`;
    try {
      // Layout uses unscaled dimensions; getBoundingClientRect includes zoom.
      const box = { width: expanded.offsetWidth, height: expanded.offsetHeight };
      const nodes = geometry.nodes.map(point => byId.get(point.id));
      const next = layoutGraph(nodes, new Map([[selectedId, { width: box.width, height: box.height }]]));
      placeGraph(next); restoreAnchor(anchor);
    } catch (error) { expanded.style.width = previousWidth; graphError(error); }
  }
  window.addEventListener("resize", () => {
    relayout();
    if (!selectedId) return;
    if (document.activeElement?.closest(".task-details")) {
      const point = geometry.nodes.find(node => node.id === selectedId);
      if (point) ui.viewport.scrollLeft = point.x * zoom - ui.viewport.clientWidth / 2;
    } else centerTask(selectedId, false);
  });
  function drawGraph(snapshot, prepared) {
    const anchor = readingAnchor();
    const scroll = { x: ui.viewport.scrollLeft, y: ui.viewport.scrollTop };
    cards = prepared.items; ui.nodes.replaceChildren(...cards.values());
    placeGraph(prepared.geometry);
    ui["scope-current"].setAttribute("aria-pressed", String(!allTasks)); ui["scope-all"].setAttribute("aria-pressed", String(allTasks));
    ui["graph-count"].textContent = `${geometry.nodes.length} 项任务`;
    ui.empty.hidden = geometry.nodes.length > 0;
    ui.empty.firstElementChild.textContent = allTasks ? "当前快照没有任务" : "当前没有待执行的任务";
    ui.empty.lastElementChild.hidden = allTasks || !snapshot.history.length;
    ui.viewport.scrollLeft = scroll.x; ui.viewport.scrollTop = scroll.y;
    restoreAnchor(anchor);
  }
  function selectTask(id, locate = false, writeHash = true) {
    if (!byId.has(id)) return;
    const nextAll = allTasks || !lastSnapshot.flow.includes(id);
    const nextOpen = selectedId === id ? openDetails : new Set();
    let prepared;
    try { prepared = prepareGraph(lastSnapshot, nextAll, id, nextOpen); }
    catch (error) { graphError(error); return; }
    selectedId = id; allTasks = nextAll; openDetails = nextOpen;
    drawGraph(lastSnapshot, prepared);
    ui["selection-status"].textContent = `已展开 ${byId.get(id).title || id} 的详情。`;
    if (writeHash) { const source = new URLSearchParams(location.hash.slice(1)); source.set("task", id); history.replaceState(null, "", `#${source}`); }
    ui["target-notice"].hidden = true; pendingTarget = false;
    if (locate) centerTask(id);
  }
  function clearSelection() {
    if (!selectedId) return;
    let prepared;
    try { prepared = prepareGraph(lastSnapshot, allTasks, null, new Set()); }
    catch (error) { graphError(error); return; }
    const previous = selectedId; selectedId = null; openDetails = new Set();
    drawGraph(lastSnapshot, prepared);
    const source = new URLSearchParams(location.hash.slice(1)); source.delete("task"); history.replaceState(null, "", `${location.pathname}${source.size ? `#${source}` : ""}`);
    centerTask(previous);
    ui["selection-status"].textContent = "任务详情已收起。";
  }
  function changeScope(value) {
    if (!lastSnapshot || allTasks === value) return;
    const nextSelected = value || lastSnapshot.flow.includes(selectedId) ? selectedId : null;
    const nextOpen = nextSelected ? openDetails : new Set();
    let prepared;
    try { prepared = prepareGraph(lastSnapshot, value, nextSelected, nextOpen); }
    catch (error) { graphError(error); return; }
    if (!nextSelected && selectedId) {
      const source = new URLSearchParams(location.hash.slice(1)); source.delete("task"); history.replaceState(null, "", `${location.pathname}${source.size ? `#${source}` : ""}`);
    }
    allTasks = value; selectedId = nextSelected; openDetails = nextOpen;
    drawGraph(lastSnapshot, prepared);
    if (selectedId) centerTask(selectedId, false); else { ui.viewport.scrollTop = 0; ui.viewport.scrollLeft = 0; }
  }
  ui["scope-current"].addEventListener("click", () => changeScope(false));
  ui["scope-all"].addEventListener("click", () => changeScope(true));

  function headline(nodes) {
    const parts = [["ACTIVE", "执行中"], ["READY", "待领取"], ["PENDING", "等待"], ["FAILED", "失败"]].map(([state, label]) => {
      const count = nodes.filter(node => node.state === state && !expired(node)).length; return count ? `${count} 项${label}` : "";
    }).filter(Boolean);
    const uncertain = nodes.filter(expired).length; if (uncertain) parts.push(`${uncertain} 项租约过期待确认`);
    return parts.join(" · ") || "当前没有进行中的任务。";
  }
  function render(payload) {
    const snapshot = payload.snapshot;
    ui.notice.hidden = payload.status === "fresh";
    ui.notice.dataset.kind = payload.status;
    if (payload.status === "error") {
      ui["notice-title"].textContent = snapshot ? "更新失败 · 以下为旧快照" : "读取失败 · 尚无可用快照";
      ui["notice-message"].textContent = payload.error || "服务未提供错误详情。";
    } else if (payload.status === "loading") {
      ui.notice.hidden = !snapshot; ui.notice.dataset.kind = "loading";
      ui["notice-title"].textContent = "正在更新 · 当前显示上次快照";
      ui["notice-message"].textContent = "新快照读取完成前，不将旧内容标记为最新状态。";
    }
    ui.tasks.hidden = !snapshot;
    if (!snapshot) { ui.headline.textContent = payload.status === "error" ? "暂时无法读取任务。" : "正在读取任务…"; ui.intro.textContent = "读取错误不代表队列为空。页面会自动重新检查。"; return; }
    // Validate new geometry before replacing the last usable snapshot or DOM.
    const nextById = new Map(snapshot.nodes.map(node => [node.id, node]));
    const nextAll = allTasks || Boolean(selectedId && nextById.has(selectedId) && !snapshot.flow.includes(selectedId));
    const prepared = prepareGraph(snapshot, nextAll);
    byId = nextById;
    lastSnapshot = snapshot;
    if (selectedId && !byId.has(selectedId)) { selectedId = null; pendingTarget = Boolean(location.hash); }
    if (selectedId && !snapshot.flow.includes(selectedId)) allTasks = true;
    drawGraph(snapshot, prepared);
    ui.project.textContent = `/ ${snapshot.project}`; document.title = `${snapshot.project} · 任务依赖图`;
    ui.headline.textContent = headline(snapshot.flow.map(id => byId.get(id)));
    ui.intro.textContent = payload.status === "error" ? "以下任务状态来自上次成功读取，不代表当前状态。" : payload.refreshing ? "正在后台检查更新，当前显示上次成功读取的任务依赖与状态。" : "从左到右看依赖，拖动空白处移动，点击任务展开详情。";
    ui["fetched-at"].textContent = `${payload.status === "fresh" && !payload.refreshing ? "读到快照" : "旧快照读于"} · ${time(snapshot.fetchedAt)}`;
    ui["last-event-at"].textContent = `最近任务事件 · ${snapshot.lastEventAt ? time(snapshot.lastEventAt) : "暂无保留记录"}`;
    if (pendingTarget) revealTask();
  }
  const portalMode = document.body.dataset.portal === "true";
  let portalSession = null, lastActivity = 0, leaving = false;
  function loginRequired() {
    if (leaving) return; leaving = true;
    document.body.hidden = true;
    location.replace(`/login?next=%2Fflow${location.hash}`);
  }
  async function activity() {
    if (!portalMode || leaving || document.visibilityState !== "visible" || Date.now() - lastActivity < 60000) return;
    lastActivity = Date.now();
    try {
      if (!portalSession) {
        const check = await fetch("/api/auth/session", { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (check.status === 401) { loginRequired(); return; }
        if (!check.ok) return; portalSession = await check.json();
      }
      const response = await fetch("/api/auth/activity", { method: "POST", headers: { "Content-Type": "application/json", "X-Cascade-CSRF": portalSession.csrfToken }, body: "{}", signal: AbortSignal.timeout(12000) });
      if ([401, 403].includes(response.status)) loginRequired();
    } catch { /* The ordinary snapshot read displays connection failures. */ }
  }
  if (portalMode) {
    for (const name of ["pointerdown", "keydown"]) document.addEventListener(name, event => { if (event.isTrusted) void activity(); }, { passive: true });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void activity(); });
    if (typeof BroadcastChannel === "function") {
      const channel = new BroadcastChannel("cascade-portal-session");
      channel.addEventListener("message", event => { if (["logout", "changed"].includes(event.data?.type)) loginRequired(); });
    }
  }

  async function refresh() {
    if (inFlight || leaving) return;
    inFlight = true;
    let nextRefreshMs = 15000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/snapshot", { method: "GET", cache: "no-store", signal: controller.signal });
      if (portalMode && response.status === 401) { loginRequired(); return; }
      // A failed Git refresh returns HTTP 503 with its last valid snapshot.
      const payload = await response.json();
      validate(payload);
      if (!response.ok && payload.status !== "error") throw new Error(`读取失败：HTTP ${response.status}`);
      if (payload.status === "loading" || payload.refreshing) nextRefreshMs = 1000;
      if (payload.snapshot === null && lastSnapshot) payload.snapshot = lastSnapshot;
      render(payload);
      if (payload.snapshot) lastSnapshot = payload.snapshot;
    } catch (error) {
      render({ status: "error", refreshing: false, snapshot: lastSnapshot, error: controller.signal.aborted ? "请求超过 12 秒，未获得新快照。" : error.message });
    } finally {
      clearTimeout(timeout);
      inFlight = false;
      if (!leaving) setTimeout(refresh, nextRefreshMs);
    }
  }

  refresh();
})();
