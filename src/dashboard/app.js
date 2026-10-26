'use strict';
const $ = id => document.getElementById(id);
let state, lastKey = '', polling = false;
let token = location.hash.slice(1) || sessionStorage.getItem('harness-dashboard-token') || '';
if (location.hash) {
  sessionStorage.setItem('harness-dashboard-token', token);
  history.replaceState(null, '', location.pathname);
}
const make = (tag, className = '', text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const badge = value => make('span', 'badge ' + String(value).replace(/[^a-z-]/g, ''), value);
const time = date => date ? new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const dateTime = date => date ? new Date(date).toLocaleString() : '';
const labels = { 'atlas-primary': 'ATLAS is the primary route', 'protected-dependency': 'Protected telemetry on ATLAS', 'backup-ready': 'BEACON backup is ready' };
function options(id, items, fallback) {
  const target = $(id), selected = target.value;
  target.replaceChildren(...items.map(([value, text]) => {
    const option = make('option', '', text); option.value = value; return option;
  }));
  target.value = items.some(([value]) => value === selected) ? selected : fallback ?? items[0]?.[0] ?? '';
}
async function api(path, data) {
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed (' + response.status + ')');
  return result;
}
function notice(message) {
  $('notice').hidden = !message;
  $('notice').textContent = message || '';
}
async function refresh(force = false) {
  if (polling) return;
  polling = true;
  try {
    const next = await api('state');
    state = next;
    $('connection-dot').className = 'dot online';
    $('connection').textContent = next.closing ? 'Stopping' : next.busy ? 'Team working' : 'Connected';
    notice(next.error ? 'The harness needs attention: ' + next.error : '');
    const key = [next.lastSequence, next.busy, next.error, next.closing, ...next.agents.map(agent => agent.phase)].join('|');
    if (force || key !== lastKey) { render(); lastKey = key; }
  } catch (error) {
    $('connection-dot').className = 'dot offline';
    $('connection').textContent = 'Disconnected';
    notice(error.message + ' Start or resume serve with --dashboard, then open its dashboard link.');
  } finally { polling = false; }
}
function render() {
  $('title').textContent = state.scenario === 'intel' ? 'Intelligence workspace' : 'Inventory workspace';
  $('subtitle').textContent = (state.scenario === 'intel' ? 'Intelligence in motion. Every source, conversation, and assessment.' : 'Follow the team from evidence to a reviewed report.') +
    '  ·  ' + state.worker;
  $('run-label').textContent = 'Run ' + state.runId;
  $('metrics').replaceChildren(...[
    [state.scenario === 'intel' ? 'R' + state.revision : '01', state.settled ? 'Assessment complete' : 'Assessment pending'],
    [state.counts.decisions, 'Agent decisions'], [state.counts.messages, 'Private messages'],
    [state.counts.helpers, 'Helpers requested'], [state.counts.updates + ' / ' + state.counts.maxUpdates, 'Intelligence updates'],
  ].map(([number, label]) => {
    const card = make('div', 'metric'); card.append(make('div', 'number', number), make('div', 'label', label)); return card;
  }));
  $('agents').replaceChildren(...state.agents.map(agent => {
    const card = make('article', 'agent-card' + (['working', 'thinking', 'waiting for helper'].includes(agent.phase) ? ' active' : ''));
    const top = make('div', 'agent-top');
    top.append(make('span', 'avatar', agent.agent[0].toUpperCase()), make('span', 'agent-name', agent.agent), badge(agent.phase));
    card.append(top, make('div', 'agent-status', agent.status),
      make('div', 'agent-meta', agent.subscriptions.length + ' subjects · ' + agent.knownEvidence + ' sources/results · PID ' + (agent.pid ?? '—')));
    return card;
  }));
  options('revision', [['latest', 'Current · R' + state.revision], ...state.assessments.map(item => [String(item.revision), 'R' + item.revision + ' · ' + item.state])], 'latest');
  const subjects = state.topics.map(topic => [topic.id, topic.title]);
  options('topic', subjects, subjects.some(([id]) => id === 'intel-assessment') ? 'intel-assessment' : subjects[0]?.[0]);
  options('inject-topic', subjects, 'intel-brief');
  noteTargets();
  $('inject-button').disabled = state.scenario !== 'intel' || state.counts.updates >= state.counts.maxUpdates || state.closing;
  $('example').disabled = state.scenario !== 'intel';
  $('usage-note').textContent = state.worker.startsWith('pi:') ? 'Live model run. Adding a source or sending a note may use your model account.' :
    'Offline demonstration. Choices are scripted' + (state.worker === 'pi-faux' ? ' through the Pi SDK.' : '.') + ' No live model usage.';
  renderNetwork(); renderAssessment(); renderSubject(); renderSources(); renderHelpers(); renderActivity();
}
function noteTargets() {
  if (!state) return;
  options('note-target', $('note-mode').value === 'dm' ? state.agents.map(agent => [agent.agent, agent.agent]) : state.topics.map(topic => [topic.id, topic.title]));
}
function svgNode(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderNetwork() {
  const height = 185 + Math.ceil(state.topics.length / 4) * 72;
  const svg = svgNode('svg', { viewBox: '0 0 760 ' + height, role: 'img', 'aria-label': 'Agent subscriptions and private message connections' });
  const defs = svgNode('defs', {});
  const marker = svgNode('marker', { id: 'arrow', markerWidth: 7, markerHeight: 7, refX: 6, refY: 3, orient: 'auto' });
  marker.append(svgNode('path', { d: 'M0,0 L6,3 L0,6', fill: '#7362ae' })); defs.append(marker); svg.append(defs);
  const positions = Object.fromEntries(state.agents.map((agent, index) => [agent.agent, 120 + index * 260]));
  const topics = state.topics.map((topic, index) => ({ ...topic, x: 95 + (index % 4) * 190, y: 180 + Math.floor(index / 4) * 72 }));
  for (const topic of topics) for (const name of topic.subscribers) {
    svg.append(svgNode('path', { class: 'edge', d: 'M' + positions[name] + ',65 C' + positions[name] + ',105 ' + topic.x + ',' + (topic.y - 50) + ' ' + topic.x + ',' + topic.y }));
  }
  const edges = new Map();
  for (const message of state.messages) if (positions[message.from] && positions[message.to]) {
    const key = message.from + ':' + message.to; edges.set(key, (edges.get(key) || 0) + 1);
  }
  let offset = 0;
  for (const [key, count] of edges) {
    const [from, to] = key.split(':'), x1 = positions[from], x2 = positions[to], y = 95 + offset++ * 16;
    svg.append(svgNode('path', { class: 'dm-edge', 'marker-end': 'url(#arrow)', d: 'M' + x1 + ',62 Q' + ((x1 + x2) / 2) + ',' + y + ' ' + x2 + ',62' }));
    svg.append(svgNode('text', { x: (x1 + x2) / 2, y: y - 5, 'text-anchor': 'middle', class: 'node-sub' }, count + ' private'));
  }
  for (const agent of state.agents) {
    const x = positions[agent.agent];
    svg.append(svgNode('rect', { x: x - 73, y: 22, width: 146, height: 43, rx: 7, fill: '#e5f0ed', stroke: '#abcfc2' }));
    svg.append(svgNode('text', { x, y: 41, 'text-anchor': 'middle', class: 'node-label' }, agent.agent));
    svg.append(svgNode('text', { x, y: 56, 'text-anchor': 'middle', class: 'node-sub' }, agent.phase));
  }
  for (const topic of topics) {
    const group = svgNode('g', {});
    group.append(svgNode('title', {}, topic.title + ': ' + topic.subscribers.join(', ')),
      svgNode('rect', { x: topic.x - 83, y: topic.y, width: 166, height: 47, rx: 6, fill: '#fafcfc', stroke: '#d1dddf' }),
      svgNode('text', { x: topic.x, y: topic.y + 19, 'text-anchor': 'middle', class: 'node-label' }, topic.title.length > 23 ? topic.title.slice(0, 21) + '…' : topic.title),
      svgNode('text', { x: topic.x, y: topic.y + 35, 'text-anchor': 'middle', class: 'node-sub' }, topic.subscribers.length + ' followers · ' + topic.publications.length + ' updates'));
    svg.append(group);
  }
  $('network').replaceChildren(svg);
}
function renderAssessment() {
  if (!state) return;
  const number = $('revision').value === 'latest' ? state.revision : Number($('revision').value);
  const selected = state.assessments.find(item => item.revision === number);
  const previous = state.assessments.find(item => item.revision === number - 1);
  const root = $('assessment'); root.replaceChildren();
  if (!selected) return;
  const summary = make('div', 'assessment-summary');
  summary.append(badge(selected.state), make('span', 'muted', '  Revision ' + number + ' · ' + dateTime(selected.receivedAt)));
  const report = selected.report?.data;
  if (report) {
    summary.append(make('div', 'stage-row'));
    summary.lastChild.append(badge(report.recommendation || 'report'));
    summary.append(make('p', '', report.text));
  } else summary.append(make('p', '', 'The team is collecting evidence and preparing this revision. Previous assessments remain available in the revision selector.'));
  root.append(summary);
  const stages = make('div', 'stage-row');
  for (const [kind, name] of [['analysis', 'Analysis'], ['review', 'Review'], ['report', 'Assessment']]) {
    const task = selected.tasks.find(item => item.id.endsWith(kind));
    stages.append(make('span', 'stage', name + ': ' + (selected[kind] ? 'completed' : task?.status || 'waiting')));
  }
  root.append(stages);
  const claims = selected.analysis?.data.claims;
  if (claims) {
    const table = make('table', 'claims'), head = make('thead'), row = make('tr');
    for (const label of ['Claim', 'Previous', 'This revision']) row.append(make('th', '', label));
    head.append(row); table.append(head);
    const body = make('tbody');
    for (const claim of claims) {
      const old = previous?.analysis?.data.claims.find(item => item.id === claim.id);
      const row = make('tr'), label = make('td', '', labels[claim.id] || claim.id);
      const detail = make('details'); detail.append(make('summary', 'muted', claim.evidenceRefs.length + ' cited sources'), make('p', '', claim.rationale)); label.append(detail);
      const before = make('td'); before.append(old ? badge(old.status) : make('span', 'muted', '—'));
      const now = make('td'); now.append(badge(claim.status));
      if (old && old.status !== claim.status) now.append(make('div', 'changed', 'Changed'));
      row.append(label, before, now); body.append(row);
    }
    table.append(body); root.append(table);
  }
  if (report?.unresolvedQuestions) root.append(make('p', 'caption', 'Open questions: ' + (report.unresolvedQuestions.map(id => labels[id] || id).join('; ') || 'none') +
    ' · Protected dependencies: ' + (report.protectedDependencies.join(', ') || 'none')));
}
function renderSubject() {
  if (!state) return;
  const topic = state.topics.find(item => item.id === $('topic').value), root = $('subject'); root.replaceChildren();
  if (!topic) return;
  root.append(make('p', 'caption', topic.description));
  const followers = make('div'); followers.append(make('span', 'muted', 'Following: '));
  for (const name of topic.subscribers) followers.append(make('span', 'chip', name));
  if (!topic.subscribers.length) followers.append(make('span', 'muted', 'none'));
  root.append(followers);
  for (const post of [...topic.publications].reverse()) {
    const article = make('article', 'post'), meta = make('div', 'post-meta');
    meta.append(make('strong', '', post.author), make('span', '', time(post.createdAt)), make('span', '', post.evidenceRefs.length + ' evidence references'));
    article.append(meta, make('div', 'post-text', post.text)); root.append(article);
  }
  if (!topic.publications.length) root.append(make('p', 'empty', 'No publications yet.'));
}
function renderSources() {
  $('sources').replaceChildren(...state.sources.map(source => {
    const details = make('details', 'source');
    details.append(make('summary', '', source.data.title || source.data.name || 'Exercise brief'),
      make('p', 'caption', source.kind === 'intel-update' ? 'Added in revision ' + source.revision + ' · observed ' + source.data.observedAt : 'Original exercise packet'),
      make('pre', '', JSON.stringify(source.data, null, 2)), make('p', 'caption', 'Evidence ID: ' + source.id));
    return details;
  }));
}
function renderHelpers() {
  const root = $('helpers'); root.replaceChildren();
  if (!state.helpers.length) { root.append(make('p', 'empty', 'No specialist requested yet. Agents choose when a helper would be useful.')); return; }
  for (const helper of state.helpers) {
    const item = make('article', 'helper');
    item.append(make('h3', '', helper.name), badge(helper.status), make('p', 'caption', 'Parent: ' + helper.parent + ' · ' + helper.evidenceRefs.length + ' selected documents'));
    const detail = make('details'); detail.append(make('summary', '', 'Assignment & result'), make('p', '', helper.task),
      make('p', '', helper.result?.findings || helper.error || 'Waiting for the specialist…'),
      make('p', 'caption', helper.result?.limitations.join(' ') || ''));
    item.append(detail); root.append(item);
  }
}
function renderActivity() {
  if (!state) return;
  const filter = $('activity-filter').value;
  $('activity').replaceChildren(...state.timeline.filter(event => filter === 'all' || event.type === filter).slice(0, 50).map(event => {
    const item = make('article', 'event'), heading = make('div', 'event-heading');
    heading.append(make('span', '', event.type.toUpperCase()), make('time', '', time(event.at)));
    const detail = make('details');
    detail.append(make('summary', '', event.actor + (event.subject ? ' · ' + event.subject : '') + ' — ' + event.text.slice(0, 95) + (event.text.length > 95 ? '…' : '')),
      make('p', '', event.text));
    item.append(heading, detail); return item;
  }));
}
async function submit(form, resultId, action, data, success) {
  const button = form.querySelector('button[type=submit]'), result = $(resultId);
  button.disabled = true; result.className = 'form-result'; result.textContent = 'Sending…';
  try { const value = await api(action, data); result.textContent = success(value); await refresh(true); }
  catch (error) { result.className = 'form-result error'; result.textContent = error.message; }
  finally { button.disabled = state?.closing || (action === 'inject' && state?.counts.updates >= state?.counts.maxUpdates); }
}
$('refresh').addEventListener('click', () => refresh(true));
$('revision').addEventListener('change', renderAssessment);
$('topic').addEventListener('change', renderSubject);
$('activity-filter').addEventListener('change', renderActivity);
$('note-mode').addEventListener('change', noteTargets);
$('example').addEventListener('click', () => { if (state) $('source-json').value = JSON.stringify(state.example, null, 2); });
$('source-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 32768) { $('inject-result').textContent = 'Choose a JSON file smaller than 32 KiB.'; return; }
  $('source-json').value = await file.text();
});
$('intel-form').addEventListener('submit', async event => {
  event.preventDefault();
  let source;
  try { source = JSON.parse($('source-json').value); }
  catch { $('inject-result').className = 'form-result error'; $('inject-result').textContent = 'The source must be valid JSON. Load the example to start.'; return; }
  await submit(event.target, 'inject-result', 'inject', { source, topic: $('inject-topic').value },
    result => result.duplicate ? 'This source is already recorded in revision ' + result.revision + '.' : 'Source accepted. Revision ' + result.revision + ' is ready for reassessment.');
});
$('note-form').addEventListener('submit', async event => {
  event.preventDefault();
  const mode = $('note-mode').value;
  await submit(event.target, 'note-result', mode, { text: $('note-text').value,
    ...(mode === 'dm' ? { to: $('note-target').value } : { topic: $('note-target').value }) }, () => 'Note delivered to the harness.');
});
refresh();
setInterval(() => refresh(), 2000);
