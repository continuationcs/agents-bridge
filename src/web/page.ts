/**
 * The dashboard: one self-contained page (no build step, no external requests).
 * Everything from the bridge is rendered with textContent — trace text comes from chats and tools.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bridge</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #677085; --line: #e3e6ec;
  --accent: #3b5bdb; --accent-soft: #e8edff; --ok: #2b8a3e; --ok-soft: #e6f4ea;
  --warn: #b35c00; --warn-soft: #fff3e0; --danger: #c92a2a; --danger-soft: #ffe9e9;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111318; --panel: #1a1d24; --text: #e6e8ee; --muted: #9098aa; --line: #2b2f39;
    --accent: #8ea6ff; --accent-soft: #232b45; --ok: #69db7c; --ok-soft: #1c2e22;
    --warn: #ffb057; --warn-soft: #33281a; --danger: #ff8787; --danger-soft: #3a1f22;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--line); }
header h1 { font-size: 16px; margin: 0 8px 0 0; letter-spacing: -0.01em; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; background: var(--bg);
  border: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); display: inline-block; }
.dot.off { background: var(--danger); }
.dot.busy { background: var(--warn); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.spacer { flex: 1; }
main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; padding: 16px 20px 40px; max-width: 1400px; margin: 0 auto; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 12px; } header { padding: 10px 12px; } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
section > h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0;
  padding: 12px 14px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
section > h2 .count { background: var(--bg); border-radius: 999px; padding: 0 7px; font-size: 11px; }
#approvals { border-color: var(--warn); }
#approvals > h2 { color: var(--warn); background: var(--warn-soft); }
.empty { padding: 18px 14px; color: var(--muted); }
.row { display: flex; gap: 12px; align-items: flex-start; padding: 11px 14px; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.row.selected { background: var(--accent-soft); }
.row .main { flex: 1; min-width: 0; }
.title { font-weight: 600; overflow-wrap: anywhere; }
.sub { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.branch { margin-top: 4px; font-size: 12.5px; white-space: pre-wrap; color: var(--text); background: var(--bg);
  border-radius: 6px; padding: 6px 8px; font-family: var(--mono); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
button { font: inherit; font-size: 13px; padding: 5px 11px; border-radius: 7px; border: 1px solid var(--line);
  background: var(--panel); color: var(--text); cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--danger); border-color: var(--danger); }
button:disabled { opacity: .5; cursor: default; }
.badge { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; margin-right: 6px; vertical-align: 1px;
  background: var(--bg); border: 1px solid var(--line); color: var(--muted); }
.badge.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.badge.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.badge.err { color: var(--danger); background: var(--danger-soft); border-color: transparent; }
.prompt { white-space: pre-wrap; margin: 4px 0 8px; }
#trace .head { display: flex; align-items: center; gap: 8px; }
#trace .head .title { flex: 1; font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--text); }
.ev { padding: 8px 14px; border-bottom: 1px solid var(--line); font-size: 13px; }
.ev:last-child { border-bottom: 0; }
.ev .meta { display: flex; flex-wrap: wrap; gap: 0 8px; color: var(--muted); font-size: 12px; }
.ev .meta > span { min-width: 0; overflow-wrap: anywhere; }
.ev .kind { font-family: var(--mono); font-size: 11.5px; }
.ev .body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.ev.inbound .kind { color: var(--accent); }
.ev.reply .kind { color: var(--ok); }
.ev.error .kind, .ev.approval .kind { color: var(--danger); }
.ev.tool_call .kind, .ev.tool_result .kind { color: var(--warn); }
.ev details summary { cursor: pointer; color: var(--muted); }
.ev pre { margin: 4px 0 0; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
#toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); max-width: min(560px, 92vw);
  background: var(--text); color: var(--bg); padding: 10px 14px; border-radius: 8px; white-space: pre-wrap;
  box-shadow: 0 6px 24px rgba(0,0,0,.2); display: none; z-index: 5; }
#toast.err { background: var(--danger); color: #fff; }
#ask { position: fixed; inset: 0; z-index: 6; display: none; align-items: center; justify-content: center; padding: 16px;
  background: rgba(0,0,0,.35); }
#ask.open { display: flex; }
#ask .box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; width: min(560px, 100%);
  max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
#ask h3 { margin: 0; padding: 14px 16px 6px; font-size: 15px; }
#ask .text { padding: 4px 16px 12px; overflow: auto; white-space: pre-wrap; font-family: var(--mono); font-size: 12.5px; }
#ask .buttons { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
.scroll { max-height: 70vh; overflow: auto; }
</style>
</head>
<body>
<header>
  <h1>bridge</h1>
  <span class="chip" id="conn"><span class="dot"></span><span>connecting…</span></span>
  <span class="chip" id="ims"></span>
  <span class="chip" id="uptime"></span>
  <span class="spacer"></span>
  <span class="chip" id="updated"></span>
</header>
<main>
  <div>
    <section id="approvals" hidden><h2>Waiting for you <span class="count" id="approvals-count"></span></h2><div id="approvals-list"></div></section>
    <section><h2>Conversations <span class="count" id="sessions-count"></span></h2><div id="sessions"></div></section>
    <section><h2>Tool servers <span class="spacer"></span><button id="tools-refresh">Check</button></h2><div id="tools"><div class="empty">Checking…</div></div></section>
  </div>
  <div>
    <section id="trace">
      <h2 class="head"><span class="title" id="trace-title">Recent activity</span><button id="trace-all" hidden>All activity</button></h2>
      <div class="scroll" id="trace-list"></div>
    </section>
  </div>
</main>
<div id="toast"></div>
<div id="ask" role="dialog" aria-modal="true" aria-labelledby="ask-title"><div class="box">
  <h3 id="ask-title"></h3><div class="text" id="ask-text"></div>
  <div class="buttons"><button id="ask-no">Cancel</button><button id="ask-yes"></button></div>
</div></div>
<script>
(function () {
  var selected = null;
  var lastOverview = null;

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function $(id) { return document.getElementById(id); }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function money(n) { return '$' + (n || 0).toFixed(2); }

  var PLATFORM = { slack: 'Slack', feishu: 'Lark', telegram: 'Telegram', discord: 'Discord', local: 'Terminal' };
  function describeKey(key) {
    var p = key.split(':');
    var name = PLATFORM[p[0]] || p[0];
    if (p[1] === 'dm') return { title: name + ' · DM', sub: p.slice(2).join(':') };
    if (p.length >= 3) return { title: name + ' · ' + p[1], sub: 'thread ' + p.slice(2).join(':') };
    return { title: key, sub: '' };
  }

  var toastTimer;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, isErr ? 8000 : 4500);
  }

  function api(path, body) {
    var opts = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // ── overview ──
  function renderStatus(s) {
    var conn = $('conn');
    clear(conn).appendChild(el('span', { class: 'dot' }));
    conn.appendChild(el('span', { text: 'running' }));
    $('ims').textContent = (s.ims.length ? s.ims.map(function (i) { return PLATFORM[i] || i; }).join(' · ') : 'no IM') +
      ' · ' + s.agents.length + ' agent' + (s.agents.length === 1 ? '' : 's');
    $('uptime').textContent = s.startedAt ? 'up ' + ago(s.startedAt).replace(' ago', '') : 'starting';
    $('updated').textContent = 'updated ' + clock(Date.now());
  }

  function renderChoices(list) {
    $('approvals').hidden = !list.length;
    $('approvals-count').textContent = list.length;
    var box = clear($('approvals-list'));
    list.forEach(function (c) {
      var k = describeKey(c.key);
      var buttons = c.choices.map(function (o) {
        return el('button', {
          class: o.style === 'primary' ? 'primary' : o.style === 'danger' ? 'danger' : '',
          text: o.label,
          onclick: function (ev) {
            ev.target.disabled = true;
            api('/api/choices/' + encodeURIComponent(c.id), { value: o.value })
              .then(function () { toast(o.label + ' — sent.'); refresh(); })
              .catch(function (e) { ev.target.disabled = false; toast(e.message, true); });
          },
        });
      });
      box.appendChild(el('div', { class: 'row' }, [
        el('div', { class: 'main' }, [
          el('div', { class: 'sub', text: k.title + ' · asked ' + ago(c.createdAt) + ' · decided by ' + c.allowed.join(', ') }),
          el('div', { class: 'prompt', text: c.text }),
          el('div', { class: 'actions', style: 'justify-content:flex-start' }, buttons),
        ]),
      ]));
    });
  }

  // In-page confirmation (native confirm() is blocked in embedded browsers).
  function ask(title, text, yesLabel, danger) {
    return new Promise(function (resolve) {
      var box = $('ask'), yes = $('ask-yes'), no = $('ask-no');
      $('ask-title').textContent = title;
      $('ask-text').textContent = text || '';
      yes.textContent = yesLabel;
      yes.className = danger ? 'danger' : 'primary';
      function done(v) {
        box.className = '';
        yes.onclick = no.onclick = box.onclick = document.onkeydown = null;
        resolve(v);
      }
      yes.onclick = function () { done(true); };
      no.onclick = function () { done(false); };
      box.onclick = function (e) { if (e.target === box) done(false); };
      document.onkeydown = function (e) { if (e.key === 'Escape') done(false); };
      box.className = 'open';
      no.focus();
    });
  }

  function workspaceAction(key, action) {
    api('/api/sessions/' + action, { key: key, preview: true })
      .then(function (r) {
        var verb = action === 'merge' ? 'Merge' : 'Discard';
        return ask(verb + ' this conversation\'s branch?', r.text, verb, action === 'discard').then(function (ok) {
          if (!ok) return;
          return api('/api/sessions/' + action, { key: key }).then(function (r2) { toast(r2.text); refresh(); });
        });
      })
      .catch(function (e) { toast(e.message, true); });
  }

  function renderSessions(list) {
    $('sessions-count').textContent = list.length;
    var box = clear($('sessions'));
    if (!list.length) { box.appendChild(el('div', { class: 'empty', text: 'No conversations yet.' })); return; }
    list.forEach(function (s) {
      var k = describeKey(s.key);
      var hasBranch = !!s.branch;
      var actions = [el('button', { text: 'Activity', onclick: function () { select(s.key); } })];
      if (s.canMerge) actions.push(el('button', { class: 'primary', text: 'Merge', onclick: function () { workspaceAction(s.key, 'merge'); } }));
      if (hasBranch) actions.push(el('button', { class: 'danger', text: 'Discard', onclick: function () { workspaceAction(s.key, 'discard'); } }));
      box.appendChild(el('div', { class: 'row' + (selected === s.key ? ' selected' : '') }, [
        el('span', { class: 'dot' + (s.busy ? ' busy' : ''), title: s.busy ? 'working' : 'idle', style: 'margin-top:6px;' + (s.busy ? '' : 'background:var(--line)') }),
        el('div', { class: 'main' }, [
          el('div', { class: 'title', text: k.title }),
          el('div', { class: 'sub', text: s.agent + ' · ' + (s.busy ? 'working · ' : '') + 'active ' + ago(s.lastActive) + ' · ' + money(s.spentUsd) + ' · ' + k.sub }),
          hasBranch ? el('div', { class: 'branch', text: s.branch }) : null,
        ]),
        el('div', { class: 'actions' }, actions),
      ]));
    });
  }

  // ── trace ──
  function summarize(kind, detail) {
    var d;
    try { d = JSON.parse(detail); } catch (e) { return { text: detail }; }
    if (d && typeof d === 'object') {
      if (kind === 'inbound') return { text: d.text, note: 'to ' + d.agent };
      if (kind === 'reply') return { text: d.text, note: d.costUsd != null ? money(d.costUsd) : '' };
      if (kind === 'progress') return { text: d.line };
      if (kind === 'tool_call') return { text: d.name, raw: JSON.stringify(d.args, null, 2) };
      if (kind === 'tool_result') return { text: (d.text || '').slice(0, 200) + ((d.text || '').length > 200 ? '…' : ''), raw: d.text };
      if (kind === 'choice') return { text: d.outcome };
      if (kind === 'ignored') return { text: d.text, note: 'no route' };
      if (kind === 'command') return { text: d.command };
      if (kind === 'error') return { text: d.message || d.error || detail };
    }
    return { text: '', raw: JSON.stringify(d, null, 2) };
  }

  function renderTrace(rows) {
    var box = clear($('trace-list'));
    if (!rows.length) { box.appendChild(el('div', { class: 'empty', text: 'Nothing yet.' })); return; }
    rows.forEach(function (r) {
      var s = summarize(r.kind, r.detail);
      var meta = [el('span', { class: 'kind', text: r.kind }), el('span', { text: r.actor }), el('span', { class: 'spacer' }), el('span', { text: clock(r.ts) })];
      var kids = [el('div', { class: 'meta' }, meta)];
      if (!selected) kids.push(el('div', { class: 'sub', text: describeKey(r.session).title }));
      if (s.text) kids.push(el('div', { class: 'body', text: s.text + (s.note ? '  · ' + s.note : '') }));
      if (s.raw && s.raw !== s.text) kids.push(el('details', null, [el('summary', { text: 'details' }), el('pre', { text: s.raw })]));
      box.appendChild(el('div', { class: 'ev ' + r.kind }, kids));
    });
  }

  function loadTrace() {
    var q = selected ? '?limit=300&session=' + encodeURIComponent(selected) : '?limit=80';
    return api('/api/trace' + q).then(renderTrace);
  }

  function select(key) {
    selected = key;
    $('trace-title').textContent = key ? describeKey(key).title + ' — activity' : 'Recent activity';
    $('trace-all').hidden = !key;
    if (lastOverview) renderSessions(lastOverview.sessions);
    loadTrace();
    if (key && window.innerWidth < 900) $('trace').scrollIntoView({ behavior: 'smooth' });
  }
  $('trace-all').addEventListener('click', function () { select(null); });

  // ── tools ──
  function renderTools(list) {
    var box = clear($('tools'));
    if (!list.length) { box.appendChild(el('div', { class: 'empty', text: 'No tool servers in bridge.yaml.' })); return; }
    list.forEach(function (t) {
      var state = t.error ? el('span', { class: 'badge err', text: 'error' })
        : t.oauth === 'signed-out' ? el('span', { class: 'badge warn', text: 'sign-in needed' })
        : el('span', { class: 'badge ok', text: t.tools + ' tools' });
      var actions = [];
      if (t.oauth === 'signed-out' || t.oauth === 'signed-in') {
        actions.push(el('button', {
          class: t.oauth === 'signed-out' ? 'primary' : '',
          text: t.oauth === 'signed-out' ? 'Connect' : 'Reconnect',
          onclick: function () { window.open('/oauth/start/' + encodeURIComponent(t.name), '_blank', 'noopener'); toast('Finish signing in in the new tab, then press Check.'); },
        }));
      }
      if (t.oauth === 'signed-in') {
        actions.push(el('button', {
          class: 'danger', text: 'Sign out',
          onclick: function () {
            ask('Sign out of ' + t.name + '?', 'Agents lose its tools until you connect again.', 'Sign out', true).then(function (ok) {
              if (!ok) return;
              return api('/api/oauth/sign-out', { server: t.name }).then(function () { toast('Signed out of ' + t.name + '.'); loadTools(); });
            }).catch(function (e) { toast(e.message, true); });
          },
        }));
      }
      box.appendChild(el('div', { class: 'row' }, [
        el('div', { class: 'main' }, [
          el('div', { class: 'title' }, [state, t.name]),
          el('div', { class: 'sub', text: (t.kind === 'http' ? 'HTTP · ' : 'stdio · ') + t.target + (t.oauth !== 'not-oauth' ? ' · OAuth' : '') }),
          t.error ? el('div', { class: 'sub', style: 'color:var(--danger)', text: t.error }) : null,
        ]),
        el('div', { class: 'actions' }, actions),
      ]));
    });
  }
  function loadTools() {
    $('tools-refresh').disabled = true;
    return api('/api/tools').then(renderTools).catch(function (e) { toast(e.message, true); })
      .then(function () { $('tools-refresh').disabled = false; });
  }
  $('tools-refresh').addEventListener('click', loadTools);

  // ── loop ──
  function refresh() {
    return api('/api/overview').then(function (o) {
      lastOverview = o;
      renderStatus(o.status);
      renderChoices(o.choices);
      renderSessions(o.sessions);
      return loadTrace();
    }).catch(function () {
      var conn = clear($('conn'));
      conn.appendChild(el('span', { class: 'dot off' }));
      conn.appendChild(el('span', { text: 'bridge not reachable' }));
    });
  }
  refresh();
  loadTools();
  setInterval(function () { if (!document.hidden) refresh(); }, 4000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
</script>
</body>
</html>
`;
