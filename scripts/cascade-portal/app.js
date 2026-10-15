"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const labels = { received: "待中心处理", clarification: "需要补充", planned: "任务已整理", dispatching: "派单中 · 已冻结", published: "已派单", rejected: "已关闭" };
  const taskLabels = { PENDING: "等待前置", READY: "待领取", ACTIVE: "执行中", COMPLETED: "已报完成", FAILED: "失败", CANCELLED: "已取消" };
  const time = value => new Date(value).toLocaleString("zh-CN", { hour12: false });
  const el = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
  let model = null, reading = null, writing = 0, submission = null, firstRender = true;
  let auth = null, previousUser = null, authEpoch = 0, loginBusy = false, lastActivity = 0;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("cascade-portal-session") : null;
  const drafts = new Map(), reviewKeys = new Map(), replyAttempts = new Map(), notices = new Map(), rendered = new WeakMap();
  function preserveDraft(field, id) {
    field.dataset.draft = id;
    field.value = drafts.get(id) || "";
    field.addEventListener("input", () => drafts.set(id, field.value));
  }
  async function api(route, data) {
    const epoch = authEpoch;
    let response;
    try {
      response = await fetch(route, { method: data === undefined ? "GET" : "POST", cache: "no-store",
        headers: data === undefined ? {} : { "Content-Type": "application/json", ...(auth ? { "X-Cascade-CSRF": auth.csrfToken } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(65000) });
    } catch (error) {
      if (route === "/api/auth/login") throw new Error("登录暂未确认，请检查网络后重新登录。");
      throw new Error(`${error.name === "TimeoutError" ? "请求超时" : "网络连接失败"}。${data === undefined ? "请重新读取。" : "提交结果尚未确认，请重新读取记录后再重试；输入内容已保留。"}`);
    }

    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`服务未返回有效记录（HTTP ${response.status}），请重新读取。`);
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`服务返回内容不完整（HTTP ${response.status}），请重新读取记录。输入内容已保留。`); }
    if (epoch !== authEpoch) { const error = new Error("登录状态已变化，已忽略旧请求结果。"); error.stale = true; throw error; }
    if ((response.status === 401 || result.code === "csrf_invalid") && !route.startsWith("/api/auth/")) requireLogin();
    if (!response.ok) { const error = new Error(result.error || `请求失败：${response.status}`); error.status = response.status; throw error; }
    return result;
  }
  function showError(message) { $("error").hidden = false; $("error-message").textContent = message; }
  function statusText(node, message, error = false) {
    node.textContent = message; node.dataset.error = String(error);
    if (node.dataset.noticeKey) notices.set(node.dataset.noticeKey, { message, error });
  }
  function formStatus(key) {
    const node = el("p", "inline-status"); node.setAttribute("role", "status"); node.dataset.noticeKey = key;
    const saved = notices.get(key); if (saved) statusText(node, saved.message, saved.error);
    return node;
  }
  function heading(title, meta, badge, kind = "") {
    const head = el("div", "card-heading"), identity = el("div");
    identity.append(el("h2", "", title), el("div", "meta", meta)); head.append(identity);
    if (badge) head.append(el("span", `badge ${kind}`, badge));
    return head;
  }
  function details(key, title, ...content) {
    const node = el("details"); node.dataset.detailKey = key; node.append(el("summary", "", title), ...content); return node;
  }
  function taskState(node) {
    if (node.state === "ACTIVE" && node.leaseExpiresAt && Date.parse(node.leaseExpiresAt) <= Date.now()) return "租约已过期 · 待确认";
    return taskLabels[node.state] || node.state;
  }
  function taskLink(id, origin) {
    const node = model.coordination.snapshot?.nodes.find(item => item.id === id);
    const link = el("a", "", node?.title || id);
    link.href = `/flow#task=${encodeURIComponent(id)}${origin ? `&${origin}` : ""}`;
    return link;
  }
  function proposalView(proposal) {
    const container = el("div", "proposal");
    container.append(el("h3", "", "目标"), el("p", "summary", proposal.goal));
    for (const [key, title] of [["scope", "范围"], ["nonGoals", "这次不做"], ["acceptance", "怎么验收"]]) {
      const list = el("ul"); for (const item of proposal[key]) list.append(el("li", "", item)); container.append(el("h3", "", title), list);
    }
    container.append(el("p", "meta", `最低能力 ${proposal.requiredTier} · 前置任务 ${proposal.dependencies.length}`), el("p", "sha", `批准基线 ${proposal.baseSha}`));
    return container;
  }
  async function submit(form, status, work, saved) {
    if (form.getAttribute("aria-busy") === "true") return;
    if (writing) { statusText(status, "另一次提交仍在保存，请等待结果后再提交。", true); return; }
    if (!auth) { requireLogin(); return; }
    writing++; $("logout").disabled = true; form.setAttribute("aria-busy", "true");
    const buttons = [...form.querySelectorAll("button")], fields = [...form.querySelectorAll("textarea")];
    buttons.forEach(button => button.disabled = true); fields.forEach(field => field.readOnly = true);
    statusText(status, "正在保存…");
    let conflict = false;
    try { await work(); saved(); statusText(status, "本次提交已保存，等待中心处理。"); }
    catch (error) { conflict = error.status === 409; statusText(status, `${error.message}${conflict ? "。正在重新读取，输入内容会保留。" : ""}`, true); }
    finally { writing--; $("logout").disabled = Boolean(writing); form.setAttribute("aria-busy", "false"); buttons.forEach(button => button.disabled = false); fields.forEach(field => field.readOnly = false); }
    const ok = await refresh(true);
    if (conflict && ok) statusText($("freshness"), notices.get(status.dataset.noticeKey)?.error === false ? "已从记录确认保存成功，无需重复提交。" : "已读取新记录，请核对后重新提交；草稿已保留。");
  }
  function messageView(message, question = false) {
    const row = el("div", `message${question ? " question" : ""}`);
    row.append(el("span", "meta", `${message.author === "center" ? "中心" : message.author} · ${time(message.createdAt)}`), el("p", "", message.body)); return row;
  }
  function requestCard(request) {
    const card = el("article", "card"); card.dataset.requestId = request.id; card.id = `request=${request.id}`; card.tabIndex = -1;
    const title = request.proposal?.title || request.description.split("\n")[0].slice(0, 80);
    card.append(heading(title, `${request.author === model.user ? "我提交的" : request.author} · ${time(request.createdAt)}`, labels[request.state], request.state === "clarification" ? "attention" : ""));
    if (request.proposal) card.append(details("description", "原始需求", el("p", "description", request.description)));
    else if (request.description !== title) card.append(el("p", "description", request.description));
    const notes = {
      received: "已保存，等待中心整理。需要补充时会在这里提问。",
      clarification: request.author === model.user ? "下一步：回答中心的问题。" : `等待 ${request.author} 补充说明。`,
      planned: "中心已整理任务要求，尚未派单。补充说明后会重新整理。",
      dispatching: "中心正在核对正式任务，当前合同已冻结；变更请另提需求。",
      published: "已建立正式任务。查看各项任务，了解执行与审查进展。",
      rejected: "此需求已关闭，原因见中心说明。如有新情况，可另提需求。",
    };
    card.append(el("p", "state-note", notes[request.state]));
    if (request.proposal) card.append(details("proposal", "任务要求与验收标准", proposalView(request.proposal)));
    const last = request.messages.at(-1);
    const showLast = last && ["clarification", "rejected"].includes(request.state);
    if (showLast) card.append(messageView(last, request.state === "clarification"));
    const earlier = showLast ? request.messages.slice(0, -1) : request.messages;
    if (earlier.length) card.append(details("messages", `往来记录 · ${earlier.length}`, ...earlier.map(message => messageView(message))));
    if (request.dispatch) {
      const list = el("ul", "task-links");
      for (const id of request.dispatch.taskIds) {
        const node = model.coordination.snapshot?.nodes.find(item => item.id === id), row = el("li");
        const state = el("span", "meta", node ? `${model.coordination.status === "fresh" ? "" : "旧快照 · "}${taskState(node)}${node.owner ? ` · ${node.owner}` : ""}` : "任务状态暂不可用");
        state.dataset.taskState = id;
        row.append(taskLink(id, `request=${encodeURIComponent(request.id)}`), state); list.append(row);
      }
      card.append(list);
      for (const candidate of model.candidates.filter(item => request.dispatch.taskIds.includes(item.taskId))) {
        const link = el("a", "flow-link", `查看候选：${candidate.title} →`); link.href = `/#candidate=${candidate.id}`; card.append(link);
      }
    } else if (request.author === model.user && !["rejected", "dispatching"].includes(request.state)) {
      const form = el("form", "reply-form"), field = el("textarea"), button = el("button", "", "提交补充"), status = formStatus(`request:${request.id}`);
      field.required = true; field.maxLength = 20000; field.rows = 2; field.id = `reply-${request.id}`;
      const label = el("label", "", "补充需求说明"); label.htmlFor = field.id;
      field.placeholder = "回答问题，或补充希望的行为。"; button.type = "submit"; status.setAttribute("role", "status");
      preserveDraft(field, `request:${request.id}`);
      const actions = el("div", "actions"); actions.append(button); form.append(label, field, actions, status);
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (writing || !auth) { statusText(status, "请等待当前提交完成后再提交。", true); return; }
        const body = field.value;
        if (replyAttempts.get(request.id)?.body !== body) replyAttempts.set(request.id, { body, version: request.version, messageCount: request.messages.length });
        const attempt = replyAttempts.get(request.id);
        void submit(form, status, async () => {
          try { return await api(`/api/requests/${request.id}/reply`, { version: attempt.version, body: attempt.body }); }
          catch (error) { if (error.status === 409) attempt.conflict = true; throw error; }
        }, () => { if (replyAttempts.get(request.id) === attempt) replyAttempts.delete(request.id); if (drafts.get(`request:${request.id}`) === body) drafts.delete(`request:${request.id}`); field.value = ""; });
      });
      const reply = details("reply", "补充说明", form); reply.open = request.state === "clarification"; card.append(reply);
    }
    const unsent = drafts.get(`request:${request.id}`);
    if (unsent && request.author === model.user && ["dispatching", "published", "rejected"].includes(request.state)) {
      const field = el("textarea"), button = el("button", "quiet", "作为新需求继续编辑");
      field.value = unsent; field.readOnly = true; field.setAttribute("aria-label", "未提交的补充草稿");
      button.type = "button";
      button.addEventListener("click", () => {
        const existing = $("description").value;
        $("description").value = `${existing ? `${existing}\n\n` : ""}关于「${title}」的变更：\n${unsent}`;
        location.hash = "compose"; navigate(); $("description").focus();
      });
      card.append(el("p", "explanation", "原需求已冻结或关闭。这段补充尚未提交，你可以复制，或作为新需求继续编辑。"), field, button);
    }
    return card;
  }
  function candidateCard(candidate) {
    const card = el("article", "card"); card.dataset.candidateId = candidate.id; card.id = `candidate=${candidate.id}`; card.tabIndex = -1;
    card.append(heading(candidate.title, time(candidate.createdAt), candidate.manifestSha256 ? "产物已封存 · 可记录意见" : "准备产物中", candidate.manifestSha256 ? "ready" : ""));
    card.append(el("p", "summary", candidate.summary));
    const link = taskLink(candidate.taskId, `candidate=${encodeURIComponent(candidate.id)}`);
    link.textContent = `查看对应任务：${link.textContent} →`; card.append(link);
    const facts = details("binding", `提交 ${candidate.sha.slice(0, 8)} · 核对完整来源`, el("p", "sha", `提交 SHA ${candidate.sha}`), el("p", "sha", `任务 ${candidate.taskId}`));
    if (candidate.manifestSha256) facts.append(el("p", "hash", `封存清单 SHA256 ${candidate.manifestSha256}`));
    card.append(facts, el("h3", "", "查看产物"));
    if (!candidate.artifacts.length) card.append(el("p", "explanation", "尚未上传产物。等待中心提供实际截图、录像或下载文件。"));
    for (const artifact of candidate.artifacts) {
      const part = el("div", "artifact"), url = `/artifacts/${artifact.id}`;
      const download = el("a", "", `下载 ${artifact.name} · ${artifact.bytes < 1048576 ? `${Math.max(.1, artifact.bytes / 1024).toFixed(1)} KB` : `${(artifact.bytes / 1048576).toFixed(1)} MB`}`);
      download.href = url; download.download = artifact.name; part.append(download);
      if (artifact.mime.startsWith("image/") || artifact.mime.startsWith("video/")) {
        const video = artifact.mime.startsWith("video/"), media = el(video ? "video" : "img"); media.src = url;
        if (video) { media.controls = true; media.preload = "metadata"; media.playsInline = true; media.setAttribute("aria-label", artifact.name); }
        else { media.alt = artifact.name; media.loading = "lazy"; }
        media.addEventListener("error", () => { if (!part.querySelector(".media-error")) part.append(el("p", "media-error explanation", "预览加载失败。可重新读取页面，或下载文件检查；预览失败不代表已验证产物。")); });
        part.append(media);
      }
      part.append(details(`artifact:${artifact.id}`, "文件校验信息", el("p", "hash", `SHA256 ${artifact.sha256}`), el("p", "meta", `${artifact.bytes} 字节`))); card.append(part);
    }
    if (!candidate.manifestSha256) card.append(el("p", "explanation", "中心尚未核验封存清单，暂不能登记验收意见。"));
    for (const review of candidate.reviews) {
      const row = el("div", "verdict"); row.append(el("span", "meta", `${review.author} · ${review.verdict === "accepted" ? "记录了通过意见" : "要求返工"} · ${time(review.createdAt)}`), el("p", "", review.body));
      row.append(el("p", "meta", review.response ? `中心处理：${review.response}` : "意见已保存，等待中心处理。")); card.append(row);
    }
    if (candidate.manifestSha256) {
      const form = el("form", "review-form"), field = el("textarea"), actions = el("div", "actions"), status = formStatus(`review:${candidate.id}`);
      field.required = true; field.rows = 3; field.maxLength = 20000; field.id = `review-${candidate.id}`;
      field.placeholder = "写下实际验证的内容和结果；返工请说明问题、复现步骤与期望。";
      const label = el("label", "", "实际验证结果"); label.htmlFor = field.id;
      status.setAttribute("role", "status"); preserveDraft(field, `review:${candidate.id}`);
      for (const [verdict, text] of [["accepted", "记录通过"], ["rework", "需要返工"]]) {
        const button = el("button", verdict === "rework" ? "quiet" : "", text); button.type = "submit"; button.value = verdict; actions.append(button);
      }
      form.append(label, field, el("p", "explanation", `意见绑定提交 ${candidate.sha.slice(0, 8)} 与当前封存清单，仅记录人工验收结论。`), actions, status);
      form.addEventListener("submit", event => {
        event.preventDefault(); if (writing || !auth) { statusText(status, "请等待当前提交完成后再提交。", true); return; } const verdict = event.submitter?.value; if (!verdict) return;
        const body = field.value, signature = JSON.stringify([verdict, body]);
        if (reviewKeys.get(candidate.id)?.signature !== signature) reviewKeys.set(candidate.id, { signature, key: crypto.randomUUID() });
        void submit(form, status, () => api(`/api/candidates/${candidate.id}/reviews`, { verdict, body, idempotencyKey: reviewKeys.get(candidate.id).key }), () => { if (reviewKeys.get(candidate.id)?.signature === signature) reviewKeys.delete(candidate.id); if (drafts.get(`review:${candidate.id}`) === body) drafts.delete(`review:${candidate.id}`); field.value = ""; });
      }); card.append(form);
    }
    return card;
  }
  function reconcile(container, records, makeCard, force, empty) {
    if (!records.length) { container.replaceChildren(el("p", "empty", empty)); return; }
    const current = new Map([...container.children].filter(node => node.dataset.recordId).map(node => [node.dataset.recordId, node]));
    container.querySelector(".empty")?.remove();
    for (const record of records) {
      let old = current.get(record.id); current.delete(record.id);
      const signature = JSON.stringify(record);
      // Keep unchanged forms/media mounted, and defer changed records while a person is using them.
      const playing = [...old?.querySelectorAll("video") || []].some(video => !video.paused && !video.ended);
      const interacting = old?.contains(document.activeElement);
      if (old && rendered.get(old) !== signature && (playing || (interacting && !force)) && !old.querySelector(".deferred-update")) {
        old.append(el("p", "deferred-update explanation", "记录有更新。结束编辑或暂停播放后会更新；提交仍会核对原版本。"));
      }
      if (!old || (rendered.get(old) !== signature && !playing && (!interacting || force))) {
        const field = old?.querySelector("textarea:focus"), selection = field ? [field.dataset.draft, field.selectionStart, field.selectionEnd] : null;
        const opened = new Map([...old?.querySelectorAll("details[data-detail-key]") || []].map(item => [item.dataset.detailKey, item.open]));
        const card = makeCard(record); card.dataset.recordId = record.id; rendered.set(card, signature);
        for (const item of card.querySelectorAll("details[data-detail-key]")) if (opened.has(item.dataset.detailKey)) item.open = opened.get(item.dataset.detailKey);
        if (old) old.replaceWith(card); else container.append(card); old = card;
        if (selection) { const next = [...card.querySelectorAll("textarea")].find(item => item.dataset.draft === selection[0]); if (next) { next.focus({ preventScroll: true }); next.setSelectionRange(selection[1], selection[2]); } }
      }
      // Inserting only out-of-order rows avoids restarting media on unchanged refreshes.
      const index = records.indexOf(record), at = container.children[index];
      if (at !== old) container.insertBefore(old, at || null);
    }
    for (const node of current.values()) node.remove();
  }
  const requestTitle = request => request.proposal?.title || request.description.split("\n")[0].slice(0, 80);
  function row(title, meta, status, href, attention = false) {
    const link = el("a", "record-row"), copy = el("div"); link.href = href;
    copy.append(el("div", "record-title", title), el("div", "meta", meta));
    link.append(copy, el("span", `badge ${attention ? "attention" : ""}`, status)); return link;
  }
  function requestRow(request) { return row(requestTitle(request), `${request.author === model.user ? "我提交的" : request.author} · ${time(request.createdAt)}`, labels[request.state], `/#request=${request.id}`, request.state === "clarification"); }
  function candidateRow(candidate) { return row(candidate.title, `${candidate.artifacts.length} 份产物 · ${time(candidate.createdAt)}`, candidate.manifestSha256 ? "可验收" : "准备中", `/#candidate=${candidate.id}`); }
  function renderStatus() {
    const c = model.coordination, snapshot = c.snapshot;
    const errors = [];
    if (c.status === "error") errors.push(`任务状态更新失败：${c.error}。${snapshot ? "任务内容来自旧快照。" : "尚无可用任务快照。"}`);
    if (model.storageError) errors.push(model.storageError);
    $("error").hidden = !errors.length; $("error-message").textContent = errors.join("\n");
    const active = snapshot?.nodes.filter(node => node.state === "ACTIVE") || [];
    const uncertain = active.filter(node => node.leaseExpiresAt && Date.parse(node.leaseExpiresAt) <= Date.now());
    $("headline").textContent = c.status === "error" ? "任务进展暂时无法更新。" : !snapshot ? "正在读取团队进展…" : `${c.refreshing ? "上次快照：" : ""}${active.length - uncertain.length} 项任务正在执行${uncertain.length ? ` · ${uncertain.length} 项租约过期，待确认` : ""}${c.refreshing ? " · 正在更新快照" : ""}。`;
    const tasks = (snapshot?.nodes || []).filter(node => ["FAILED", "ACTIVE", "READY"].includes(node.state)).slice(0, 4);
    reconcile($("task-status"), tasks.map(node => ({ ...node, snapshotStatus: c.status, displayedState: taskState(node), refreshing: c.refreshing })), node => row(node.title || node.id, node.owner || "等待团队处理", `${c.status !== "fresh" || c.refreshing ? "上次快照 · " : ""}${taskState(node)}`, `/flow#task=${encodeURIComponent(node.id)}`, node.state === "FAILED"), false, snapshot ? "当前没有待执行的任务。" : "任务快照暂不可用。");
    const todo = [
      ...model.requests.filter(item => item.state === "clarification" && item.author === model.user).map(item => ({ ...item, kind: "request" })),
      ...model.candidates.filter(item => item.manifestSha256 && !item.reviews.some(review => review.author === model.user)).map(item => ({ ...item, kind: "candidate" })),
    ];
    reconcile($("next-step"), todo, item => item.kind === "request" ? requestRow(item) : candidateRow(item), false, "暂时没有需要你处理的事。");
    for (const label of document.querySelectorAll("[data-task-state]")) {
      const node = snapshot?.nodes.find(item => item.id === label.dataset.taskState);
      label.textContent = node ? `${c.status === "fresh" && !c.refreshing ? "" : "上次快照 · "}${taskState(node)}${node.owner ? ` · ${node.owner}` : ""}` : "任务状态暂不可用";
    }
    $("processor-status").textContent = model.processorCheckedAt ? `中心上次读取：${time(model.processorCheckedAt)}` : "中心尚无读取记录 · 需求会排队保存";
    $("request-count").textContent = model.requests.length; $("candidate-count").textContent = model.candidates.length;
  }
  function navigate(focus = false, force = false) {
    if (!auth) return;
    const hash = location.hash.slice(1), kind = hash.startsWith("candidate=") ? "candidate" : hash.startsWith("request=") ? "request" : null;
    const page = kind ? "detail" : ["home", "requests", "candidates", "compose"].includes(hash) ? hash : "home";
    const selected = kind === "candidate" ? "candidates" : kind === "request" || page === "compose" ? "requests" : page;
    for (const link of document.querySelectorAll("[data-page]")) {
      if (link.dataset.page === selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    for (const id of ["home", "requests", "candidates", "compose", "detail"]) $(id).hidden = id !== page;
    const titles = { home: "工作台", requests: "需求", candidates: "候选验收", compose: "提交新需求", detail: kind === "candidate" ? "候选详情" : "需求详情" };
    const intros = { home: "先处理需要你参与的事。", requests: "从想法到交付，持续跟进每一条需求。", candidates: "查看交付内容，留下你的验证结果。", compose: "把问题讲清楚，团队会继续与你确认。", detail: "" };
    $("page-title").textContent = titles[page]; $("page-intro").textContent = intros[page]; $("compose-link").hidden = page === "compose";
    if (model && kind) {
      const record = (kind === "request" ? model.requests : model.candidates).find(item => item.id === hash.slice(kind.length + 1));
      $("detail-back").href = `/#${selected}`; $("detail-back").textContent = kind === "request" ? "← 返回需求" : "← 返回候选验收";
      reconcile($("detail-record"), record ? [{ ...record, snapshot: model.coordination, linkedCandidates: model.candidates }] : [], kind === "request" ? requestCard : candidateCard, force, "未找到这条记录。请返回列表，或刷新后重试。");
    } else if (page !== "detail") {
      // Drafts are held in memory; only the selected detail keeps forms/media mounted.
      $("detail-record").replaceChildren();
    }
    if (focus) { $("page-title").focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  }
  async function refresh(force = false) {
    if (reading) { const ok = await reading; if (!force) return ok; }
    if (writing || !auth) return false;
    reading = (async () => {
      $("retry").disabled = true;
      try {
        const next = await api("/api/portal");
        if (!auth || next.user !== auth.user) { clearAccount(); requireLogin(); return false; }
        model = next;
        for (const [id, attempt] of replyAttempts) {
          const request = model.requests.find(item => item.id === id);
          const confirmed = request && request.version > attempt.version && request.messages.slice(attempt.messageCount).some(message => message.author === model.user && message.body === attempt.body.trim());
          if (confirmed) {
            if (drafts.get(`request:${id}`) === attempt.body) drafts.delete(`request:${id}`);
            notices.set(`request:${id}`, { message: "已从记录确认补充保存成功，无需重复提交。", error: false });
            replyAttempts.delete(id);
          } else if (attempt.conflict && request && request.version > attempt.version) replyAttempts.delete(id);
        }
        $("identity").textContent = model.user; $("project").textContent = model.project;
        document.title = `${model.project} · 团队中心`; renderStatus();
        if (!writing) {
          reconcile($("request-list"), model.requests, requestRow, force, "还没有需求。点击「提交需求」，写下想解决的问题。");
          reconcile($("candidate-list"), model.candidates, candidateRow, force, "还没有候选产物。交付准备好后会出现在这里。");
          navigate(firstRender, force); firstRender = false;
        }
        statusText($("freshness"), `记录读于 ${time(new Date().toISOString())}`); return true;
      } catch (error) {
        if (error.stale || !auth) return false;
        showError(`${error.message}${model ? " 下方记录来自上次读取，当前状态尚未确认。" : ""}`);
        $("headline").textContent = "暂时无法读取团队记录。";
        if (!model) { $("request-list").replaceChildren(el("p", "empty", "需求读取失败；不能据此判断没有需求。")); $("candidate-list").replaceChildren(el("p", "empty", "候选读取失败；不能据此判断没有候选。")); $("processor-status").textContent = "处理记录暂不可用"; }
        return false;
      } finally { $("retry").disabled = false; }
    })();
    try { return await reading; } finally { reading = null; }
  }
  $("new-request").addEventListener("submit", event => {
    event.preventDefault(); if (writing || !auth) return; const form = event.currentTarget, body = $("description").value;
    if (submission?.body !== body) submission = { body, key: crypto.randomUUID() };
    void submit(form, $("submit-status"), () => api("/api/requests", { description: body, idempotencyKey: submission.key }), () => { submission = null; if ($("description").value === body) $("description").value = ""; });
  });
  $("retry").addEventListener("click", () => void refresh(true));
  function clearAccount() {
    model = null; submission = null; firstRender = true;
    drafts.clear(); reviewKeys.clear(); replyAttempts.clear(); notices.clear();
    $("description").value = ""; $("submit-status").textContent = "";
    for (const id of ["request-list", "candidate-list", "detail-record", "next-step", "task-status"]) $(id).replaceChildren();
    $("error").hidden = true; $("freshness").textContent = ""; $("processor-status").textContent = "";
  }
  function requireLogin(message = "登录已失效，请重新登录。使用同一账号可继续编辑本页草稿。") {
    authEpoch++; auth = null;
    $("workspace").hidden = true; $("login-screen").hidden = false;
    for (const video of document.querySelectorAll("video")) video.pause();
    $("login-intro").textContent = message;
    $("login-submit").disabled = false; $("login-submit").textContent = "登录";
    $("password").value = ""; $("password").type = "password";
    $("show-password").setAttribute("aria-pressed", "false"); $("show-password").setAttribute("aria-label", "显示密码"); $("show-password").textContent = "显示";
    if (previousUser) $("username").value = previousUser;
  }
  async function acceptSession(session) {
    if (previousUser && previousUser !== session.user) clearAccount();
    authEpoch++; auth = session; previousUser = session.user;
    $("identity").textContent = session.user;
    $("login-screen").hidden = true; $("workspace").hidden = false;
    $("login-error").textContent = ""; $("password").value = "";
    if (location.pathname === "/login") {
      const next = new URLSearchParams(location.search).get("next");
      if (next === "/flow") { location.replace(`/flow${location.hash}`); return; }
      history.replaceState(null, "", `/${location.hash || "#home"}`);
    }
    navigate(); await refresh(true);
  }
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault(); if (loginBusy || writing) return;
    loginBusy = true; $("login-submit").disabled = true; $("login-submit").textContent = "正在登录…";
    $("login-form").setAttribute("aria-busy", "true"); $("login-error").textContent = "";
    try {
      const session = await api("/api/auth/login", { username: $("username").value.trim(), password: $("password").value });
      $("password").value = ""; channel?.postMessage({ type: "changed" }); await acceptSession(session);
    } catch (error) { if (!error.stale) statusText($("login-error"), error.message, true); }
    finally { loginBusy = false; $("login-submit").disabled = false; $("login-submit").textContent = "登录"; $("login-form").setAttribute("aria-busy", "false"); }
  });
  $("show-password").addEventListener("click", () => {
    const show = $("password").type === "password"; $("password").type = show ? "text" : "password";
    $("show-password").setAttribute("aria-pressed", String(show)); $("show-password").setAttribute("aria-label", show ? "隐藏密码" : "显示密码"); $("show-password").textContent = show ? "隐藏" : "显示";
  });
  $("forgot-password").addEventListener("click", () => { $("login-help").hidden = !$("login-help").hidden; });
  $("logout").addEventListener("click", async () => {
    if (writing) return;
    $("logout").disabled = true;
    try {
      await api("/api/auth/logout", {}); channel?.postMessage({ type: "logout" });
      clearAccount(); previousUser = null; $("username").value = "";
      history.replaceState(null, "", "/login"); requireLogin("已安全退出。登录后继续处理团队工作。"); $("username").focus();
    } catch (error) {
      if (error.status === 401 || (error.stale && !auth)) {
        clearAccount(); previousUser = null; $("username").value = "";
        history.replaceState(null, "", "/login"); requireLogin("已清理本页内容，请重新登录。");
      } else if (error.stale) { /* A newer authenticated account owns this page. */ }
      else statusText($("logout-status"), `${error.message} 退出尚未确认，请重试。`, true);
    } finally { $("logout").disabled = false; }
  });
  async function checkSession() {
    try { await acceptSession(await api("/api/auth/session")); }
    catch (error) { if (error.stale) return; requireLogin("使用团队账号，继续处理需求与验收。"); if (error.status !== 401) statusText($("login-error"), error.message, true); }
  }
  channel?.addEventListener("message", event => {
    if (!["logout", "changed"].includes(event.data?.type)) return;
    if (event.data.type === "logout") { clearAccount(); previousUser = null; }
    requireLogin("登录状态已在另一页面变化，正在确认…");
    if (!loginBusy) void checkSession();
  });
  async function activity() {
    if (!auth || document.visibilityState !== "visible" || Date.now() - lastActivity < 60000) return;
    lastActivity = Date.now();
    try { const current = await api("/api/auth/activity", {}); if (auth && current.user === auth.user) auth = current; }
    catch (error) { if (!error.stale && (error.status === 401 || error.status === 403)) requireLogin(); }
  }
  for (const name of ["pointerdown", "keydown"]) document.addEventListener(name, event => { if (event.isTrusted) void activity(); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void activity(); });
  window.addEventListener("hashchange", () => navigate(true));
  void checkSession(); setInterval(() => { if (auth) void refresh(); }, 15000);
})();
