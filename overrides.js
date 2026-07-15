/**
 * overrides.js — Admin Manual Override Layer v4
 */

// ── STATE ──
let _overrides = defaultOverrides();
let _rawAutoData = null;
const _undoStack = [];
const MAX_UNDO = 20;

function defaultOverrides() {
  return { v: 1, courseDisplayOrder: [], patches: {}, manualCourses: [], manualNodes: [], reparent: {}, flattenAll: false };
}

async function loadOverrides() {
  try {
    const doc = await db.collection('app_data').doc('overrides').get();
    _overrides = doc.exists ? { ...defaultOverrides(), ...doc.data() } : defaultOverrides();
  } catch (e) { console.warn('loadOverrides:', e); _overrides = defaultOverrides(); }
}

async function saveOverrides(newState, skipUndo = false) {
  if (!skipUndo) pushUndo();
  _overrides = { ...newState };
  try {
    const { updatedAt: _, ...toWrite } = _overrides;
    await db.collection('app_data').doc('overrides').set({
      ...toWrite,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentUser?.email || ''
    });
  } catch (e) { console.error('saveOverrides:', e); throw e; }
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

// ── UNDO / REDO ──
const _redoStack = [];

function pushUndo() {
  _undoStack.push(JSON.parse(JSON.stringify(_overrides)));
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  _redoStack.length = 0; // clear redo on new action
  refreshUndoRedoState();
}

async function doUndo() {
  if (!_undoStack.length) return false;
  _redoStack.push(JSON.parse(JSON.stringify(_overrides)));
  await saveOverrides(_undoStack.pop(), true);
  refreshUndoRedoState();
  return true;
}

async function doRedo() {
  if (!_redoStack.length) return false;
  _undoStack.push(JSON.parse(JSON.stringify(_overrides)));
  await saveOverrides(_redoStack.pop(), true);
  refreshUndoRedoState();
  return true;
}

function refreshUndoRedoState() {
  const u = document.getElementById('btn-undo');
  const r = document.getElementById('btn-redo');
  if (u) u.disabled = !_undoStack.length;
  if (r) r.disabled = !_redoStack.length;
}

// backward compat
async function undoOverride() { return doUndo(); }
const canUndo = () => _undoStack.length > 0;

// ── FLATTEN ──
function collectLessons(node, prefix) {
  const title = prefix ? `${prefix} › ${node.title}` : node.title;
  if (node.type === 'lesson') return [{ ...node, title }];
  return (node.children || []).flatMap(c => collectLessons(c, title));
}
function enforceMaxDepth(nodes) {
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

function applyPatch(node, patches, flattenAll, includeHidden = false) {
  const p = patches[node.id] || {};
  const out = { ...node };
  if (p.title !== undefined) out.title = p.title;
  if (p.youtubeId !== undefined) out.youtubeId = p.youtubeId;
  if (p.hidden && includeHidden) out._hidden = true;
  if (p.extraDocs?.length) out.documents = [...(out.documents || []), ...p.extraDocs.map((d, i) => ({ ...d, _isExtra: true, _extraIndex: i }))];
  if (out.children) {
    let ch = out.children
      .filter(c => includeHidden || !patches[c.id]?.hidden)
      .map(c => applyPatch(c, patches, flattenAll, includeHidden));
    if (p.childOrder?.length) ch = reorderByIds(ch, p.childOrder);
    if (flattenAll || p.flattenChildren) ch = enforceMaxDepth(ch);
    out.children = ch;
  }
  return out;
}

function getMergedCourses(rawCourses, overrides, includeHidden = false) {
  if (!rawCourses) return [];
  if (!overrides) return rawCourses;
  const { patches = {}, flattenAll = false, courseDisplayOrder = [], manualCourses = [], manualNodes = [], reparent = {} } = overrides;

  // 1. Combine all courses
  let allCourses = [
    ...JSON.parse(JSON.stringify(rawCourses)),
    ...JSON.parse(JSON.stringify(manualCourses))
  ];

  // 2. Detach reparents
  const detachedNodes = new Map();
  function traverseAndDetach(node) {
    let childrenArray = node.tree || node.children;
    if (childrenArray) {
      let kept = [];
      childrenArray.forEach(child => {
        if (reparent[child.id]) {
          detachedNodes.set(child.id, child);
        } else {
          kept.push(child);
          traverseAndDetach(child);
        }
      });
      if (node.tree) node.tree = kept;
      else node.children = kept;
    }
  }
  allCourses.forEach(traverseAndDetach);

  // 3. Inject reparents and manualNodes
  const nodesToInject = {};
  for (const [nodeId, newParentId] of Object.entries(reparent)) {
    if (detachedNodes.has(nodeId)) {
      if (!nodesToInject[newParentId]) nodesToInject[newParentId] = [];
      nodesToInject[newParentId].push(detachedNodes.get(nodeId));
    }
  }
  manualNodes.forEach(mn => {
    if (mn.parentId) {
      if (!nodesToInject[mn.parentId]) nodesToInject[mn.parentId] = [];
      nodesToInject[mn.parentId].push(JSON.parse(JSON.stringify(mn)));
    }
  });

  function traverseAndInject(node) {
    if (nodesToInject[node.id]) {
      if (node.tree) {
        node.tree.push(...nodesToInject[node.id]);
      } else {
        node.children = node.children || [];
        node.children.push(...nodesToInject[node.id]);
      }
    }
    let childrenArray = node.tree || node.children;
    if (childrenArray) {
      childrenArray.forEach(traverseAndInject);
    }
  }
  allCourses.forEach(traverseAndInject);

  // 4. Apply Patches
  let courses = allCourses.map(c => {
    const cp = patches[c.id] || {};
    const out = { ...c };
    if (cp.title !== undefined) out.title = cp.title;
    if (cp.hidden) out._hidden = true;
    if (out.tree) {
      let tree = out.tree
        .filter(n => includeHidden || !patches[n.id]?.hidden)
        .map(n => applyPatch(n, patches, flattenAll, includeHidden));
      if (cp.childOrder?.length) tree = reorderByIds(tree, cp.childOrder);
      if (flattenAll) tree = enforceMaxDepth(tree);
      out.tree = tree;
    }
    return out;
  });

  return reorderByIds(courses, courseDisplayOrder);
}

// Add a helper to get youtubeId from a lesson in appData.courses
function _getLessonYoutubeId(courseId, lessonId) {
  if (!appData || !appData.courses) return null;
  const course = appData.courses.find(c => c.id === courseId);
  if (!course) return null;
  function findInTree(tree) {
    if (!tree) return null;
    for (const node of tree) {
      if (node.id === lessonId && node.type === 'lesson') return node.youtubeId || null;
      if (node.children || node.tree) {
        const found = findInTree(node.children || node.tree);
        if (found) return found;
      }
    }
    return null;
  }
  return findInTree(course.tree);
}

function _recomputeMerged() {
  if (!_rawAutoData || !appData) return;
  const btnFlattenAll = document.getElementById('btn-flatten-all');
  const btnUnflatten = document.getElementById('btn-unflatten');
  if (btnFlattenAll && btnUnflatten) {
    btnFlattenAll.style.display = _overrides.flattenAll ? 'none' : '';
    btnUnflatten.style.display = _overrides.flattenAll ? '' : 'none';
  }
  
  const isEditMode = (typeof editMode !== 'undefined' && editMode && typeof _isAdmin !== 'undefined' && _isAdmin) ? true : false;
  
  let oldYoutubeId = null;
  const activePage = document.querySelector('.page.active')?.id;
  if (activePage === 'page-lesson' && typeof currentLessonId !== 'undefined' && typeof currentCourseId !== 'undefined') {
     oldYoutubeId = _getLessonYoutubeId(currentCourseId, currentLessonId);
  }

  appData.courses = getMergedCourses(_rawAutoData, _overrides, isEditMode);
  
  if (activePage === 'page-home' && typeof renderHome === 'function') {
    renderHome();
  } else if (activePage === 'page-course' && typeof currentCourseId !== 'undefined' && typeof renderCourse === 'function') {
    renderCourse(currentCourseId);
  } else if (activePage === 'page-lesson' && typeof currentCourseId !== 'undefined' && typeof currentLessonId !== 'undefined') {
    const newYoutubeId = _getLessonYoutubeId(currentCourseId, currentLessonId);
    if (newYoutubeId !== oldYoutubeId && typeof renderLesson === 'function') {
      renderLesson(currentCourseId, currentLessonId);
    } else if (typeof _updateLessonSidebar === 'function') {
      _updateLessonSidebar();
    }
  }
}

// ── BACKUP ──
function downloadBackup() {
  if (typeof _isAdmin !== 'undefined' && !_isAdmin) return;
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
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}