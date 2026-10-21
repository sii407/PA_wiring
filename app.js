// ケーブル定義
const CABLE_TYPES = {
  xlr: { name: 'XLRケーブル(キャノンtoキャノン)', color: '#000000', width: 1.5 },
  trs: { name: 'TRS-XLRケーブル (フォーンtoキャノン)', color: '#000000', width: 5 },
  spk: { name: 'スピーカーケーブル (スピコンtoスピコン)', color: '#4a90d9', width: 2.5 },
  ph:  { name: 'スピーカーケーブル (スピコンtoフォン)', color: '#4a90d9', width: 2.5, dash: '7 5' }
};

const STORAGE_KEY = 'pa-wiring-v1';
const MAX_UNDO_STACK = 30;

// アプリケーション状態
let state = {
  title: 'PA配線図',
  nodes: [],
  edges: []
};

// 履歴スタック（Undo用）
let undoStack = [];

let selectedId = null;
let isConnectMode = false;
let connectFromId = null;
let dragContext = null;
let idCounter = 1;

// ユーティリティ関数
const $ = (selector) => document.querySelector(selector);
const generateId = () => 'i' + Date.now().toString(36) + (idCounter++);

const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, (match) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[match]));

// 履歴スタックの保存 (操作確定時に実行)
function pushUndoState() {
  if (undoStack.length >= MAX_UNDO_STACK) undoStack.shift();
  undoStack.push(JSON.stringify(state));
  updateUndoButtonUI();
}

// 元に戻す（Undo）
function undo() {
  if (undoStack.length === 0) return;
  const previousState = undoStack.pop();
  state = JSON.parse(previousState);
  selectedId = null;
  connectFromId = null;
  renderCanvas();
  updatePanel();
  saveDataLocalOnly();
  updateUndoButtonUI();
}

function updateUndoButtonUI() {
  const undoBtn = $('#bUndo');
  if (undoBtn) undoBtn.disabled = (undoStack.length === 0);
}

// 初期空データの生成
function createEmptyData() {
  return {
    title: 'PA配線図',
    nodes: [],
    edges: []
  };
}

// データ保存
function saveData() {
  saveDataLocalOnly();
}

function saveDataLocalOnly() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('保存に失敗しました', e);
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.nodes)) return parsed;
    }
  } catch (e) {}
  return createEmptyData();
}

const getNode = (id) => state.nodes.find(n => n.id === id);

// 標準ポート位置の計算
function calculateDefaultPorts() {
  const outputs = {}, inputs = {}, routes = {};

  state.edges.forEach(edge => {
    (outputs[edge.from] ??= []).push(edge);
    (inputs[edge.to] ??= []).push(edge);
    routes[edge.id] = {};
  });

  // 出力ポート
  for (const id in outputs) {
    const node = getNode(id);
    if (!node) continue;
    const list = outputs[id].sort((a, b) => (getNode(a.to)?.y || 0) - (getNode(b.to)?.y || 0));

    list.forEach((edge, index) => {
      if (node.outCh && node.outCh.length > index) {
        const rowHeight = 22;
        const outBoxWidth = 65;
        const startX = node.x + node.w + outBoxWidth;
        const startY = node.y + 120 + index * rowHeight + rowHeight / 2;
        routes[edge.id].s = [startX, startY];
      } else {
        routes[edge.id].s = [node.x + node.w, node.y + node.h * (index + 1) / (list.length + 1)];
      }
    });
  }

  // 入力ポート
  for (const id in inputs) {
    const node = getNode(id);
    if (!node) continue;
    const list = inputs[id].sort((a, b) => (getNode(a.from)?.y || 0) - (getNode(b.from)?.y || 0));
    list.forEach((edge, index) => {
      routes[edge.id].t = [node.x, node.y + node.h * (index + 1) / (list.length + 1)];
    });
  }

  return routes;
}

// チャンネルブロック描画
function renderChannels(node) {
  if (!node.ch || !node.ch.length) return '';
  let html = '';
  node.ch.forEach((c, i) => {
    const y = node.y + 48 + i * 20;
    html += `
      <rect x="${node.x}" y="${y}" width="30" height="20" fill="#ffffff" stroke="#000000"/>
      <text x="${node.x + 15}" y="${y + 14}" text-anchor="middle" font-size="12" fill="#000000">${escapeHtml(c.n)}</text>
      <rect x="${node.x + 30}" y="${y}" width="${node.w - 30}" height="20" fill="#ffffff" stroke="#000000"/>
      <text x="${node.x + 36}" y="${y + 14}" font-size="12" fill="#dd1111">${escapeHtml(c.l)}</text>
    `;
    if (node.arr && c.l) {
      html += `<path d="M${node.x - 50} ${y + 10}H${node.x - 1}" stroke="#000000" stroke-width="1.5" marker-end="url(#ar)"/>`;
    }
  });
  return html;
}

// 突起型出力ボックス描画
function renderOutputChannels(node) {
  if (!node.outCh || !node.outCh.length) return '';
  let html = '';
  const boxWidth = 65;
  const boxHeight = 22;
  const startX = node.x + node.w;

  node.outCh.forEach((label, i) => {
    const y = node.y + 120 + i * boxHeight;
    html += `
      <g class="out-port-box">
        <rect x="${startX}" y="${y}" width="${boxWidth}" height="${boxHeight}" fill="#ffffff" stroke="#000000" stroke-width="2"/>
        <text x="${startX + 6}" y="${y + 15}" font-size="12" font-weight="bold" fill="#000000">${escapeHtml(label)}</text>
      </g>
    `;
  });
  return html;
}

// 配線のSVGパス生成（基本はまっすぐな直線）
function buildEdgePath(sx, sy, tx, ty, waypoints) {
  if (!waypoints || waypoints.length === 0) {
    return `M${sx} ${sy} L${tx} ${ty}`;
  }

  let d = `M${sx} ${sy}`;
  waypoints.forEach(wp => {
    d += ` L${wp.x} ${wp.y}`;
  });
  d += ` L${tx} ${ty}`;
  return d;
}

// SVGキャンバス描画
function renderCanvas() {
  state.edges = state.edges.filter(e => getNode(e.from) && getNode(e.to));
  state.nodes.forEach(n => {
    const inCount = n.ch ? n.ch.length : 0;
    if (inCount > 0) n.h = 52 + inCount * 20;
  });

  const width = Math.max(1200, ...state.nodes.map(n => n.x + n.w + 100));
  const height = Math.max(700, ...state.nodes.map(n => n.y + n.h + 130));
  const defaultPorts = calculateDefaultPorts();

  let svg = `
    <defs>
      <marker id="ar" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="11" refY="5" orient="auto">
        <path d="M0 0L12 5L0 10z" fill="#000000"/>
      </marker>
      <marker id="ab" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="11" refY="5" orient="auto">
        <path d="M0 0L12 5L0 10z" fill="#4a90d9"/>
      </marker>
    </defs>
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <text x="20" y="28" font-size="18" font-weight="700" fill="#000000">${escapeHtml(state.title)}</text>
  `;

  // 接続線描画
  state.edges.forEach(e => {
    const defaultPort = defaultPorts[e.id] || {};
    const cable = CABLE_TYPES[e.type] || CABLE_TYPES.xlr;

    const sx = e.startPos ? e.startPos.x : (defaultPort.s ? defaultPort.s[0] : 0);
    const sy = e.startPos ? e.startPos.y : (defaultPort.s ? defaultPort.s[1] : 0);
    const tx = e.endPos ? e.endPos.x : (defaultPort.t ? defaultPort.t[0] : 0);
    const ty = e.endPos ? e.endPos.y : (defaultPort.t ? defaultPort.t[1] : 0);

    if (!e.waypoints) e.waypoints = [];

    const pathD = buildEdgePath(sx, sy, tx, ty, e.waypoints);
    const markerId = cable.color === '#000000' ? 'ar' : 'ab';
    const isSelected = selectedId === e.id;
    const strokeColor = isSelected ? '#e8590c' : cable.color;

    svg += `<g data-e="${e.id}" style="cursor:pointer">
      <path d="${pathD}" fill="none" stroke="transparent" stroke-width="16"/>
      <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="${cable.width}" ${cable.dash ? `stroke-dasharray="${cable.dash}"` : ''} ${e.type === 'trs' ? '' : `marker-end="url(#${markerId})"`}/>
      ${e.type === 'trs' ? `
        <path d="${pathD}" fill="none" stroke="#ffffff" stroke-width="2"/>
        <path d="M${tx - 12}${ty - 5}L${tx} ${ty}L${tx - 12} ${ty + 5}" fill="none" stroke="#000000" stroke-width="2"/>
      ` : ''}`;

    if (isSelected) {
      svg += `<circle data-handle-start="${e.id}" cx="${sx}" cy="${sy}" r="7" fill="#2b2" stroke="#fff" stroke-width="2" style="cursor:grab"/>`;
      e.waypoints.forEach((wp, idx) => {
        svg += `<circle data-handle-wp="${e.id}" data-idx="${idx}" cx="${wp.x}" cy="${wp.y}" r="7" fill="#2b7de9" stroke="#fff" stroke-width="2" style="cursor:grab"/>`;
      });
      svg += `<circle data-handle-end="${e.id}" cx="${tx}" cy="${ty}" r="7" fill="#d33" stroke="#fff" stroke-width="2" style="cursor:grab"/>`;
    }

    svg += `</g>`;
  });

  // ノード描画
  state.nodes.forEach(n => {
    const isSelected = selectedId === n.id || connectFromId === n.id;
    const border = isSelected ? '#e8590c' : '#000000';
    const cursor = isConnectMode ? 'crosshair' : 'move';

    svg += `<g data-n="${n.id}" style="cursor:${cursor}">`;

    if (n.k === 'div') {
      const color = isSelected ? '#e8590c' : '#7ac943';
      svg += `
        <rect x="${n.x}" y="${n.y}" width="10" height="${n.h}" rx="5" fill="${color}"/>
        <text x="${n.x + 5}" y="${n.y + n.h + 24}" text-anchor="middle" font-size="18" fill="#5a9e2b">${escapeHtml(n.l)}</text>
        <rect x="${n.x - 12}" y="${n.y}" width="34" height="${n.h}" fill="transparent"/>
      `;
    } else if (n.k === 'txt') {
      svg += `
        <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="transparent" ${isSelected ? 'stroke="#e8590c" stroke-dasharray="4"' : ''}/>
        <text x="${n.x + 4}" y="${n.y + n.h * 0.7}" font-size="18" fill="#000000">${escapeHtml(n.l)}</text>
      `;
    } else {
      const textY = n.h > 60 ? n.y + 24 : n.y + n.h * 0.42;
      svg += `
        <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="#ffffff" stroke="${border}" stroke-width="2"/>
        <text x="${n.x + 8}" y="${textY}" font-size="12" fill="#000000">${escapeHtml(n.l)}</text>
        <text x="${n.x + 8}" y="${textY + 15}" font-size="13" fill="#000000">${escapeHtml(n.s)}</text>
        ${renderChannels(n)}
        ${renderOutputChannels(n)}
      `;
    }
    svg += `</g>`;
  });

  // 凡例描画
  const legendY = height - 92;
  svg += `<g font-size="12" fill="#000000">`;
  Object.entries(CABLE_TYPES).forEach(([key, cable], idx) => {
    const y = legendY + idx * 20 + 10;
    svg += `
      <path d="M20 ${y}H70" stroke="${cable.color}" stroke-width="${cable.width}" ${cable.dash ? `stroke-dasharray="${cable.dash}"` : ''}/>
      ${key === 'trs' ? `<path d="M20 ${y}H70" stroke="#ffffff" stroke-width="2"/>` : ''}
      <text x="80" y="${y + 4}">${cable.name}</text>
    `;
  });
  svg += `</g>`;

  const svgElem = $('#svg');
  svgElem.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svgElem.innerHTML = svg;
}

// サイドバープロパティパネル
function updatePanel() {
  const panel = $('#pn');
  if (!selectedId) {
    panel.classList.add('hid');
    return;
  }

  const node = getNode(selectedId);
  const edge = state.edges.find(e => e.id === selectedId);
  panel.classList.remove('hid');

  if (node) {
    const kindName = { dev: '機材', div: '区切り線', txt: 'テキスト' }[node.k];
    panel.innerHTML = `
      <h3>${kindName} の設定</h3>
      <label>
        ${node.k === 'dev' ? 'メーカー / 名称 (1行目)' : 'ラベル'}
        <input data-f="l" value="${escapeHtml(node.l)}">
      </label>
      ${node.k === 'dev' ? `
        <label>型番 (2行目)
          <input data-f="s" value="${escapeHtml(node.s)}">
        </label>
        <div class="row">
          <label>幅<input type="number" data-f="w" value="${node.w}"></label>
          ${node.ch && node.ch.length ? '' : `<label>高さ<input type="number" data-f="h" value="${node.h}"></label>`}
        </div>
        <h3>入力チャンネル</h3>
        <label style="flex-direction:row;gap:6px;align-items:center;margin-bottom:8px">
          <input type="checkbox" id="arr" ${node.arr ? 'checked' : ''} style="width:auto"> 入力矢印を表示
        </label>
        <div id="chs"></div>
        <div class="row" style="margin-top:6px">
          <button id="chAdd" type="button">＋1ch追加</button>
        </div>
        <div class="row" style="margin-top:6px">
          <input type="number" id="chN" value="8" min="1" max="64">
          <button id="chBulk" type="button">連番で追加</button>
        </div>

        <h3>出力端子 (外側突起)</h3>
        <div id="outChs"></div>
        <div class="row" style="margin-top:6px">
          <button id="outChAdd" type="button">＋出力端子追加</button>
        </div>
      ` : node.k === 'div' ? `
        <label>高さ<input type="number" data-f="h" value="${node.h}"></label>
      ` : ''}
      <button id="del" type="button" class="btn-danger" style="margin-top:12px;width:100%">削除</button>
    `;

    panel.querySelectorAll('[data-f]').forEach(input => {
      input.oninput = () => {
        const field = input.dataset.f;
        node[field] = input.type === 'number' ? Math.max(10, +input.value || 10) : input.value;
        renderCanvas();
        saveData();
      };
    });

    if (node.k === 'dev') {
      renderChannelRows(node);
      renderOutputChannelRows(node);

      const addChannels = (count) => {
        pushUndoState();
        node.ch ??= [];
        for (let i = 0; i < count; i++) {
          const lastNum = node.ch.length ? (parseInt(node.ch[node.ch.length - 1].n) || node.ch.length) : 0;
          node.ch.push({ n: String(lastNum + 1), l: '' });
        }
        renderCanvas();
        updatePanel();
        saveData();
      };

      $('#chAdd').onclick = () => addChannels(1);
      $('#chBulk').onclick = () => addChannels(Math.min(64, Math.max(1, +$('#chN').value || 1)));
      $('#arr').onchange = (e) => {
        pushUndoState();
        node.arr = e.target.checked;
        renderCanvas();
        saveData();
      };

      $('#outChAdd').onclick = () => {
        pushUndoState();
        node.outCh ??= [];
        node.outCh.push(`AUX${node.outCh.length + 1}`);
        renderCanvas();
        updatePanel();
        saveData();
      };
    }
  } else if (edge) {
    panel.innerHTML = `
      <h3>接続線の設定</h3>
      <label>ケーブル種別
        <select data-f="type">
          ${Object.entries(CABLE_TYPES).map(([k, t]) => `
            <option value="${k}" ${k === edge.type ? 'selected' : ''}>${t.name}</option>
          `).join('')}
        </select>
      </label>
      <button id="bAddWp" type="button" style="margin-top:6px;width:100%">＋中継点を追加</button>
      <button id="bResetEdge" type="button" style="margin-top:6px;width:100%">配線位置を自動に戻す</button>
      <button id="del" type="button" class="btn-danger" style="margin-top:12px;width:100%">削除</button>
    `;

    panel.querySelector('[data-f="type"]').onchange = (e) => {
      pushUndoState();
      edge.type = e.target.value;
      renderCanvas();
      saveData();
    };

    $('#bAddWp').onclick = () => {
      pushUndoState();
      edge.waypoints ??= [];
      const defaultPort = calculateDefaultPorts()[edge.id] || {};
      const sx = edge.startPos ? edge.startPos.x : (defaultPort.s ? defaultPort.s[0] : 100);
      const sy = edge.startPos ? edge.startPos.y : (defaultPort.s ? defaultPort.s[1] : 100);
      const tx = edge.endPos ? edge.endPos.x : (defaultPort.t ? defaultPort.t[0] : 200);
      const ty = edge.endPos ? edge.endPos.y : (defaultPort.t ? defaultPort.t[1] : 200);
      edge.waypoints.push({
        x: Math.round((sx + tx) / 2),
        y: Math.round((sy + ty) / 2)
      });
      renderCanvas();
      updatePanel();
      saveData();
    };

    $('#bResetEdge').onclick = () => {
      pushUndoState();
      delete edge.startPos;
      delete edge.endPos;
      edge.waypoints = [];
      renderCanvas();
      saveData();
    };
  }

  $('#del').onclick = () => {
    pushUndoState();
    if (node) {
      state.nodes = state.nodes.filter(x => x !== node);
    } else if (edge) {
      state.edges = state.edges.filter(x => x !== edge);
    }
    selectedId = null;
    renderCanvas();
    updatePanel();
    saveData();
  };
}

function renderChannelRows(node) {
  const container = $('#chs');
  if (!container) return;

  container.innerHTML = (node.ch || []).map((c, i) => `
    <div class="row" style="margin-bottom:4px">
      <input data-i="${i}" data-c="n" value="${escapeHtml(c.n)}" style="flex:0 0 46px">
      <input data-i="${i}" data-c="l" value="${escapeHtml(c.l)}" placeholder="ラベル">
      <button data-x="${i}" type="button" style="flex:0 0 30px;padding:5px 0">×</button>
    </div>
  `).join('');

  container.querySelectorAll('input').forEach(input => {
    input.oninput = () => {
      node.ch[+input.dataset.i][input.dataset.c] = input.value;
      renderCanvas();
      saveData();
    };
  });

  container.querySelectorAll('[data-x]').forEach(btn => {
    btn.onclick = () => {
      pushUndoState();
      node.ch.splice(+btn.dataset.x, 1);
      renderCanvas();
      updatePanel();
      saveData();
    };
  });
}

function renderOutputChannelRows(node) {
  const container = $('#outChs');
  if (!container) return;

  container.innerHTML = (node.outCh || []).map((label, i) => `
    <div class="row" style="margin-bottom:4px">
      <input data-oi="${i}" value="${escapeHtml(label)}" placeholder="端子名">
      <button data-ox="${i}" type="button" style="flex:0 0 30px;padding:5px 0">×</button>
    </div>
  `).join('');

  container.querySelectorAll('input').forEach(input => {
    input.oninput = () => {
      node.outCh[+input.dataset.oi] = input.value;
      renderCanvas();
      saveData();
    };
  });

  container.querySelectorAll('[data-ox]').forEach(btn => {
    btn.onclick = () => {
      pushUndoState();
      node.outCh.splice(+btn.dataset.ox, 1);
      renderCanvas();
      updatePanel();
      saveData();
    };
  });
}

function addNode(kind) {
  pushUndoState();
  const id = generateId();
  const node = kind === 'dev' 
    ? { id, k: kind, l: 'メーカー', s: '型番', x: 200, y: 100, w: 140, h: 38, outCh: [] }
    : kind === 'div'
    ? { id, k: kind, l: 'Box', x: 100, y: 60, w: 10, h: 400 }
    : { id, k: kind, l: 'テキスト', x: 100, y: 100, w: 90, h: 24 };

  state.nodes.push(node);
  selectedId = id;
  renderCanvas();
  updatePanel();
  saveData();
}

function autoLayout() {
  pushUndoState();
  const devices = state.nodes.filter(n => n.k === 'dev');
  const levels = {};
  devices.forEach(n => levels[n.id] = 0);

  for (let i = 0; i < devices.length; i++) {
    state.edges.forEach(e => {
      if (e.from in levels && e.to in levels) {
        if (levels[e.from] < devices.length - 1 && levels[e.to] < levels[e.from] + 1) {
          levels[e.to] = levels[e.from] + 1;
        }
      }
    });
  }

  const maxLevel = Math.max(0, ...Object.values(levels));
  let startX = 150;

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const group = devices.filter(n => levels[n.id] === lvl);
    if (!group.length) continue;

    const getKeyY = (node) => {
      const parents = state.edges
        .filter(e => e.to === node.id && getNode(e.from))
        .map(e => getNode(e.from).y + getNode(e.from).h / 2);
      return parents.length && lvl ? parents.reduce((a, b) => a + b) / parents.length : node.y;
    };

    group.sort((a, b) => getKeyY(a) - getKeyY(b));

    let currentY = 50;
    group.forEach(node => {
      node.x = startX;
      node.y = currentY;
      currentY += node.h + 24;
    });

    startX += Math.max(...group.map(n => n.w)) + 110;
  }

  renderCanvas();
  saveData();
}

// イベント処理の初期化
function initEvents() {
  const svg = $('#svg');

  const getSVGPoint = (ev) => {
    const p = svg.createSVGPoint();
    p.x = ev.clientX;
    p.y = ev.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };

  svg.onpointerdown = (ev) => {
    const elemStart = ev.target.closest('[data-handle-start]');
    const elemEnd = ev.target.closest('[data-handle-end]');
    const elemWp = ev.target.closest('[data-handle-wp]');
    const elemEdge = ev.target.closest('[data-e]');
    const elemNode = ev.target.closest('[data-n]');

    // 始点ハンドルのドラッグ (緑)
    if (elemStart) {
      pushUndoState();
      const edge = state.edges.find(e => e.id === elemStart.dataset.handleStart);
      dragContext = { type: 'start', edge };
      svg.setPointerCapture(ev.pointerId);
      return;
    }

    // 終点ハンドルのドラッグ (赤)
    if (elemEnd) {
      pushUndoState();
      const edge = state.edges.find(e => e.id === elemEnd.dataset.handleEnd);
      dragContext = { type: 'end', edge };
      svg.setPointerCapture(ev.pointerId);
      return;
    }

    // 中継点ハンドルのドラッグ (青)
    if (elemWp) {
      pushUndoState();
      const edge = state.edges.find(e => e.id === elemWp.dataset.handleWp);
      const idx = +elemWp.dataset.idx;
      dragContext = { type: 'wp', edge, idx };
      svg.setPointerCapture(ev.pointerId);
      return;
    }

    // ノード操作
    if (elemNode) {
      const id = elemNode.dataset.n;
      const node = getNode(id);

      if (isConnectMode && node.k === 'dev') {
        if (!connectFromId) {
          connectFromId = id;
        } else {
          if (connectFromId !== id) {
            pushUndoState();
            state.edges.push({
              id: generateId(),
              from: connectFromId,
              to: id,
              type: $('#cType').value,
              waypoints: []
            });
          }
          connectFromId = null;
          saveData();
        }
        renderCanvas();
        return;
      }

      if (isConnectMode) return;

      pushUndoState();
      selectedId = id;
      const point = getSVGPoint(ev);
      dragContext = { type: 'node', node, dx: point.x - node.x, dy: point.y - node.y };
      svg.setPointerCapture(ev.pointerId);
      renderCanvas();
      updatePanel();
    } else if (elemEdge) {
      selectedId = elemEdge.dataset.e;
      renderCanvas();
      updatePanel();
    } else {
      selectedId = null;
      connectFromId = null;
      renderCanvas();
      updatePanel();
    }
  };

  svg.onpointermove = (ev) => {
    if (!dragContext) return;
    const point = getSVGPoint(ev);

    if (dragContext.type === 'node') {
      dragContext.node.x = Math.max(0, Math.round((point.x - dragContext.dx) / 10) * 10);
      dragContext.node.y = Math.max(0, Math.round((point.y - dragContext.dy) / 10) * 10);
      renderCanvas();
    } else if (dragContext.type === 'start') {
      dragContext.edge.startPos = {
        x: Math.round(point.x / 10) * 10,
        y: Math.round(point.y / 10) * 10
      };
      renderCanvas();
    } else if (dragContext.type === 'end') {
      dragContext.edge.endPos = {
        x: Math.round(point.x / 10) * 10,
        y: Math.round(point.y / 10) * 10
      };
      renderCanvas();
    } else if (dragContext.type === 'wp') {
      dragContext.edge.waypoints[dragContext.idx] = {
        x: Math.round(point.x / 10) * 10,
        y: Math.round(point.y / 10) * 10
      };
      renderCanvas();
    }
  };

  svg.onpointerup = () => {
    if (dragContext) {
      dragContext = null;
      saveData();
    }
  };

  // 画面のキーボードショートカット (Ctrl+Z)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        undo();
      }
    }
  });

  // コントロールボタン
  $('#cType').innerHTML = Object.entries(CABLE_TYPES)
    .map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('');

  $('#ttl').value = state.title;
  $('#ttl').oninput = (e) => {
    state.title = e.target.value;
    renderCanvas();
    saveData();
  };

  $('#bUndo').onclick = undo;
  $('#bDev').onclick = () => addNode('dev');
  $('#bDiv').onclick = () => addNode('div');
  $('#bTxt').onclick = () => addNode('txt');

  $('#bConn').onclick = (e) => {
    isConnectMode = !isConnectMode;
    connectFromId = null;
    e.target.classList.toggle('on', isConnectMode);
    renderCanvas();
  };

  $('#bAuto').onclick = autoLayout;

  $('#bPrint').onclick = () => {
    selectedId = null;
    connectFromId = null;
    renderCanvas();
    updatePanel();
    try {
      window.print();
    } catch (e) {
      alert('印刷ダイアログの起動に失敗しました。Ctrl+Pをご利用ください。');
    }
  };

  $('#bNew').onclick = () => {
    if (confirm('新しい配線図を作成しますか？')) {
      pushUndoState();
      state = createEmptyData();
      selectedId = null;
      $('#ttl').value = state.title;
      renderCanvas();
      updatePanel();
      saveData();
    }
  };

  $('#bExp').onclick = () => {
    const jsonStr = JSON.stringify(state, null, 2);
    $('#js').value = jsonStr;
    $('#js').select();
    try {
      navigator.clipboard.writeText(jsonStr);
      alert('JSONをクリップボードにコピーしました。');
    } catch (e) {}
  };

  $('#bImp').onclick = () => {
    try {
      const parsed = JSON.parse($('#js').value);
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error();
      pushUndoState();
      state = parsed;
      selectedId = null;
      $('#ttl').value = state.title || '';
      renderCanvas();
      updatePanel();
      saveData();
      alert('読み込みが完了しました。');
    } catch (e) {
      alert('正しいJSON形式ではありません。');
    }
  };

  updateUndoButtonUI();
}

function init() {
  state = loadData();
  initEvents();
  renderCanvas();
}

window.addEventListener('DOMContentLoaded', init);