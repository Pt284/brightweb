/**
 * overrides.js — Admin Manual Override Layer
 * Phụ thuộc: db, appData, currentUser (globals từ index.html)
 */

// ── STATE ──
let _overrides = defaultOverrides(); // không bao giờ null
let _rawAutoData = null; // snapshot appData.courses trước merge
const _undoStack = [];
const MAX_UNDO = 20;

function defaultOverrides() {
  return { v: 1, courseDisplayOrder: [], patches: {}, manualCourses: [], flattenAll: false };
}

// ── LOAD ──
async function loadOverrides() {
  try {
    const doc = await db.collection('app_data').doc('overrides').get();
    _overrides = doc.exists ? { ...defaultOverrides(), ...doc.data() } : defaultOverrides();
  } catch (e) {
    console.warn('loadOverrides:', e);
    _overrides = defaultOverrides();
  }
}

// ── SAVE ──
async function saveOverrides(newState, skipUndo = false) {
  if (!skipUndo) pushUndo();
  _overrides = { ...newState };
  try {
    const { updatedAt: _, ...toWrite } = _overrides; // Firestore sẽ ghi đè updatedAt
    await db.collection('app_data').doc('overrides').set({
      ...toWrite,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentUser?.email || ''
    });
  } catch (e) {
    console.error('saveOverrides:', e);
    throw e;
  }
  _recomputeMerged();
}

// ── PATCH HELPERS ──
async function patchNode(nodeId, partial) {
  const patches = { ..._overrides.patches, [nodeId]: { ...(_overrides.patches[nodeId] || {}), ...partial } };
  await saveOverrides({ ..._overrides, patches });
}

async function resetNodePatch(nodeId) {
  const patches = { ..._overrides.patches };
  delete patches[nodeId];
  await saveOverrides({ ..._overrides, patches });
}

// ── UNDO ──
function pushUndo() {
  _undoStack.push(JSON.parse(JSON.stringify(_overrides)));
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
}

async function undoOverride() {
  if (!_undoStack.length) return false;
  await saveOverrides(_undoStack.pop(), true);
  return true;
}

const canUndo = () => _undoStack.length > 0;

// ── FLATTEN ──
function collectLessons(node, prefix) {
  const title = prefix ? `${prefix} › ${node.title}` : node.title;
  if (node.type === 'lesson') return [{ ...node, title }];
  return (node.children || []).flatMap(c => collectLessons(c, title));
}

function enforceMaxDepth(nodes) {
  // Đảm bảo: chapter không có child là chapter (max depth = chapter → lesson)
  return nodes.map(node => {
    if (node.type === 'lesson') return node;
    const children = (node.children || []).flatMap(c =>
      c.type === 'lesson' ? [c] : collectLessons(c, c.title)
    );
    return { ...node, children };
  });
}

// ── MERGE ──
function reorderByIds(items, orderedIds) {
  if (!orderedIds?.length) return items;
  const map = new Map(items.map(i => [i.id, i]));
  return [
    ...orderedIds.filter(id => map.has(id)).map(id => map.get(id)),
    ...items.filter(i => !orderedIds.includes(i.id))
  ];
}

function applyPatch(node, patches, flattenAll) {
  const p = patches[node.id] || {};
  const out = { ...node };
  if (p.title !== undefined) out.title = p.title;
  if (p.youtubeId !== undefined) out.youtubeId = p.youtubeId;
  if (p.extraDocs?.length) out.documents = [...(out.documents || []), ...p.extraDocs];

  if (out.children) {
    let ch = out.children
      .filter(c => !patches[c.id]?.hidden)
      .map(c => applyPatch(c, patches, flattenAll));
    if (p.childOrder?.length) ch = reorderByIds(ch, p.childOrder);
    if (flattenAll || p.flattenChildren) ch = enforceMaxDepth(ch);
    out.children = ch;
  }
  return out;
}

function getMergedCourses(rawCourses, overrides) {
  if (!rawCourses) return [];
  if (!overrides) return rawCourses;
  const { patches = {}, flattenAll = false, courseDisplayOrder = [], manualCourses = [] } = overrides;

  let courses = rawCourses
    .filter(c => !patches[c.id]?.hidden)
    .map(c => {
      const cp = patches[c.id] || {};
      const out = { ...c };
      if (cp.title !== undefined) out.title = cp.title;

      if (out.tree) {
        let tree = out.tree
          .filter(n => !patches[n.id]?.hidden)
          .map(n => applyPatch(n, patches, flattenAll));
        if (cp.childOrder?.length) tree = reorderByIds(tree, cp.childOrder);
        if (flattenAll) tree = enforceMaxDepth(tree);
        out.tree = tree;
      }
      return out;
    });

  courses = [...courses, ...manualCourses];
  return reorderByIds(courses, courseDisplayOrder);
}

function _recomputeMerged() {
  if (_rawAutoData && appData) {
    appData.courses = getMergedCourses(_rawAutoData, _overrides);
  }
}

// ── BACKUP ──
function downloadBackup() {
  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(),
    mergedCourses: appData?.courses ?? [],
    rawAutoData: _rawAutoData ?? [],
    overrides: _overrides ?? {}
  }, null, 2)], { type: 'application/json' });

  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `hocmailea-backup-${new Date().toISOString().slice(0, 10)}.json`
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}