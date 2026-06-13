const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// 1. Replace updateRealtimeProgressUI buildTree call
html = html.replace(
  `$('sidebar-lesson-tree').appendChild(buildTree(course.tree, currentCourseId, 0, currentLessonId));`,
  `$('sidebar-lesson-tree').appendChild(buildTree(course.tree, currentCourseId, 0, currentLessonId, currentCourseId));`
);

// 2. Replace renderCourse buildTree call
html = html.replace(
  `$('sidebar-tree').appendChild(buildTree(course.tree, courseId, 0, null));`,
  `$('sidebar-tree').appendChild(buildTree(course.tree, courseId, 0, null, courseId));`
);

// 3. Replace renderLesson buildTree call
html = html.replace(
  `$('sidebar-lesson-tree').appendChild(buildTree(course.tree, courseId, 0, lessonId));`,
  `$('sidebar-lesson-tree').appendChild(buildTree(course.tree, courseId, 0, lessonId, courseId));`
);

// 4. Replace buildTree
const oldBuildTreeStart = `// ── RENDER: TREE ──`;
const oldBuildTreeEnd = `// ── PHASE 2: Edit Mode ──`;

const startIndex = html.indexOf(oldBuildTreeStart);
const endIndex = html.indexOf(oldBuildTreeEnd);

if (startIndex === -1 || endIndex === -1) {
  console.error('Could not find buildTree bounds');
  process.exit(1);
}

const newBuildTree = `// ── RENDER: TREE ──
    let _clipboard = null; // { action: 'cut'|'copy', node: {...}, parentId: string }
    let _dragSidebarSrc = null; // { id, parentId, index, node }

    function buildTree(nodes, courseId, indent, activeId, parentId) {
      const ul = document.createElement('div');
      ul.className = 'tree-list';
      ul.dataset.parentId = parentId;

      if (indent === 0 && editMode) {
        // Render clipboard toolbar at the root
        const tb = el('div', { className: 'clipboard-toolbar', style: 'padding:8px; display:flex; gap:6px; background:rgba(0,0,0,0.2); margin-bottom:8px; border-radius:6px; font-size:0.85rem; align-items:center;' });
        tb.appendChild(el('span', { textContent: '📋 Clipboard:', style: 'color:var(--text-muted)' }));
        if (_clipboard) {
          const actionText = _clipboard.action === 'cut' ? '✂️' : '📋';
          tb.appendChild(el('span', { textContent: \`\${actionText} \${_clipboard.node.title}\`, style: 'flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' }));
          tb.appendChild(el('button', { className: 'btn-icon', textContent: '✕', onclick: () => { _clipboard = null; updateRealtimeProgressUI(); } }));
        } else {
          tb.appendChild(el('span', { textContent: 'Trống', style: 'flex:1; color:var(--text-muted)' }));
        }
        ul.appendChild(tb);
      }

      nodes.forEach((node, i) => {
        const wrap = document.createElement('div'); wrap.className = 'tree-node';
        if (node._hidden && !editMode) return;
        if (node._hidden) wrap.classList.add('is-hidden');

        const label = document.createElement('div'); label.className = 'tree-label';
        label.style.paddingLeft = (14 + indent * 14) + 'px';

        const nodeId = node.id || \`folder_\${indent}_\${i}\`;
        
        if (editMode) {
          wrap.setAttribute('draggable', 'true');
          wrap.dataset.nodeId = nodeId;
          wrap.dataset.parentId = parentId;
          
          wrap.addEventListener('dragstart', e => {
            e.stopPropagation(); // Prevent parent drag
            _dragSidebarSrc = { id: nodeId, parentId, index: i, node };
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => wrap.classList.add('dragging'), 0);
          });
          wrap.addEventListener('dragend', (e) => {
            e.stopPropagation();
            wrap.classList.remove('dragging');
            document.querySelectorAll('.drag-over-tree').forEach(n => n.classList.remove('drag-over-tree'));
          });
          wrap.addEventListener('dragover', e => { 
            e.preventDefault(); 
            e.stopPropagation();
            wrap.classList.add('drag-over-tree'); 
          });
          wrap.addEventListener('dragleave', (e) => {
            e.stopPropagation();
            wrap.classList.remove('drag-over-tree');
          });
          wrap.addEventListener('drop', async e => {
            e.preventDefault();
            e.stopPropagation();
            wrap.classList.remove('drag-over-tree');
            if (!_dragSidebarSrc || _dragSidebarSrc.id === nodeId) return;
            
            // Move inside the same parent
            if (_dragSidebarSrc.parentId === parentId) {
              const currentOrder = nodes.map((n, idx) => n.id || \`folder_\${indent}_\${idx}\`);
              const [moved] = currentOrder.splice(_dragSidebarSrc.index, 1);
              currentOrder.splice(i, 0, moved);
              _dragSidebarSrc = null;
              await patchNode(parentId, { childOrder: currentOrder });
            } else {
              // Note: drag & drop between different parents is complex to do purely via HTML5 drag-drop 
              // because we are dropping onto a sibling node to insert before/after it, not into the parent.
              // We'll support reparenting via cut & paste instead to avoid UX issues.
              alert('Kéo thả giữa các chương khác nhau: Hãy dùng chức năng Cắt (✂️) và Dán (📌).');
            }
          });
        }

        const editActions = el('div', { className: 'tree-edit-actions', style: 'display:none; gap:4px; margin-left:8px;' });
        if (editMode) {
          editActions.style.display = 'flex';
          const editBtn = el('button', { className: 'btn-icon', title: 'Sửa', textContent: '✏️', onclick: (e) => { e.stopPropagation(); openChapterModal(courseId, nodeId, parentId, node); }});
          const cutBtn = el('button', { className: 'btn-icon', title: 'Cắt', textContent: '✂️', onclick: (e) => { e.stopPropagation(); _clipboard = { action: 'cut', node, parentId }; updateRealtimeProgressUI(); }});
          const copyBtn = el('button', { className: 'btn-icon', title: 'Sao chép', textContent: '📋', onclick: (e) => { e.stopPropagation(); _clipboard = { action: 'copy', node }; updateRealtimeProgressUI(); }});
          editActions.append(editBtn, cutBtn, copyBtn);
        }

        if (node.type === 'lesson') {
          const pct = getLessonProgressPct(node.id);
          const isDone = pct === 100;

          const barTrack = el('div', { className: 'bar-track' });
          const barFill = el('div', { className: 'bar-fill ' + (isDone ? 'done' : pct > 0 ? '' : 'low'), style: \`width:\${pct}%\` });
          barTrack.appendChild(barFill);
          const barBadge = el('span', { className: 'bar-badge' }, barTrack, el('span', { textContent: pct + '%' }));

          const icon = el('span', { className: 'icon', textContent: '📄' });
          const title = el('span', { style: 'flex:1', textContent: node.title });
          if (node._hidden) title.textContent += ' (Đang ẩn)';

          label.appendChild(icon); label.appendChild(title); label.appendChild(barBadge); label.appendChild(editActions);
          if (node.id === activeId) label.classList.add('active-lesson');
          label.addEventListener('click', (e) => {
            if (e.target.closest('.btn-icon')) return;
            navigate('lesson', courseId, node.id);
          });
        } else {
          const ch = document.createElement('div'); ch.className = 'tree-children';
          
          const isOpen = _openTreeNodes.has(nodeId);
          if (isOpen) ch.classList.add('open');

          const icon = el('span', { className: 'icon toggle-icon', textContent: isOpen ? '▼' : '▶' });
          const title = el('span', { style: 'flex:1', textContent: node.title });
          if (node._hidden) title.textContent += ' (Đang ẩn)';

          if (editMode && node.children && node.children.length > 0) {
            const flattenBtn = el('button', { className: 'btn-icon', textContent: '⚡', title: 'Làm phẳng', onclick: async (e) => {
              e.stopPropagation();
              await patchNode(nodeId, { flattenChildren: true });
            }});
            editActions.prepend(flattenBtn);
          }

          const pct = getChapterProgressPct(node);
          const color = pct === 100 ? 'var(--progress-done)' : pct >= 50 ? 'var(--progress-fill)' : 'var(--progress-low)';
          const dash = (pct * 87.96) / 100;

          const arcWrap = el('div', { className: 'arc-wrap', 'aria-label': pct + '%' });
          arcWrap.innerHTML = \`
            <svg width="24" height="24" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="14" fill="none" stroke="var(--progress-track)" stroke-width="4"/>
              <circle cx="18" cy="18" r="14" fill="none" stroke="\${color}" stroke-width="4"
                stroke-dasharray="\${dash} 87.96" stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 18 18)"/>
            </svg>
            <span class="arc-label" style="font-size:8px; color:\${color}; font-weight:bold;">\${pct}%</span>
          \`;

          label.appendChild(icon); label.appendChild(title); label.appendChild(arcWrap); label.appendChild(editActions);

          label.addEventListener('click', (e) => {
            if (e.target.closest('.btn-icon')) return;
            const o = ch.classList.toggle('open');
            label.querySelector('.toggle-icon').textContent = o ? '▼' : '▶';
            if (o) _openTreeNodes.add(nodeId);
            else _openTreeNodes.delete(nodeId);
          });

          if (node.children) ch.appendChild(buildTree(node.children, courseId, indent + 1, activeId, nodeId));
          
          if (editMode && _clipboard && isOpen) {
            const pasteBtn = el('button', { className: 'btn btn-outline btn-sm', textContent: '📌 Dán vào đây', style: 'margin: 4px 0 4px ' + (14 + (indent+1)*14) + 'px', onclick: () => handlePaste(courseId, nodeId) });
            ch.appendChild(pasteBtn);
          }

          if (editMode && isOpen) {
            const addBtn = el('button', { className: 'btn btn-outline btn-sm', textContent: '＋ Bài mới', style: 'margin: 4px 0 4px ' + (14 + (indent+1)*14) + 'px', onclick: () => openChapterModal(courseId, null, nodeId, { type: 'lesson' }) });
            ch.appendChild(addBtn);
          }

          wrap.appendChild(label); wrap.appendChild(ch); ul.appendChild(wrap); return;
        }
        wrap.appendChild(label); ul.appendChild(wrap);
      });
      
      if (editMode && indent === 0) {
        if (_clipboard) {
          const pasteBtn = el('button', { className: 'btn btn-outline btn-sm', textContent: '📌 Dán vào khóa học', style: 'margin: 8px 0; width: 100%;', onclick: () => handlePaste(courseId, courseId) });
          ul.appendChild(pasteBtn);
        }
        const addBtn = el('button', { className: 'btn btn-outline btn-sm', textContent: '＋ Thêm chương', style: 'margin: 8px 0; width: 100%;', onclick: () => openChapterModal(courseId, null, courseId, { type: 'chapter' }) });
        ul.appendChild(addBtn);
      }

      return ul;
    }

    async function handlePaste(courseId, destParentId) {
      if (!_clipboard) return;
      const { action, node, parentId: srcParentId } = _clipboard;
      
      if (action === 'cut') {
        if (srcParentId === destParentId) {
          _clipboard = null; updateRealtimeProgressUI(); return;
        }
        // Reparent auto-node OR modify manual node parentId
        if (node._isManual) {
          const manualNodes = [...(_overrides.manualNodes || [])];
          const idx = manualNodes.findIndex(n => n.id === node.id);
          if (idx >= 0) {
            manualNodes[idx].parentId = destParentId;
            await saveOverrides({ ..._overrides, manualNodes });
          }
        } else {
          const reparent = { ..._overrides.reparent, [node.id]: destParentId };
          await saveOverrides({ ..._overrides, reparent });
        }
      } else if (action === 'copy') {
        const manualNodes = [...(_overrides.manualNodes || [])];
        const newNode = JSON.parse(JSON.stringify(node));
        newNode.id = \`manual-\${Date.now()}\`;
        newNode._isManual = true;
        newNode.parentId = destParentId;
        // Don't copy tree deep unless we implement deep clone logic, for now just copy the node properties
        if (newNode.children) newNode.children = [];
        if (newNode.tree) newNode.tree = [];
        manualNodes.push(newNode);
        await saveOverrides({ ..._overrides, manualNodes });
      }
      _clipboard = null;
    }

    function openChapterModal(courseId, nodeId, parentId, nodeProps = {}) {
      const isNew = !nodeId;
      const isLesson = nodeProps?.type === 'lesson';
      const node = isNew ? null : findLesson(findCourse(courseId), nodeId) || findChapterById(findCourse(courseId), nodeId); // We need a findNode logic.
      
      // Let's rely on nodeProps passed from UI
      const targetNode = isNew ? nodeProps : nodeProps;
      const isManual = !!targetNode._isManual;
      const patch = _overrides.patches?.[nodeId] || {};

      const modal = $('edit-modal');
      modal.innerHTML = '';
      
      const titleStr = isNew ? (isLesson ? '➕ Thêm bài học' : '➕ Thêm chương') : (isLesson ? '✏️ Sửa bài học' : '✏️ Sửa chương');
      modal.appendChild(el('h4', { textContent: titleStr, style: 'margin:0;font-size:1.1rem;margin-bottom:12px;' }));

      // Name
      const nameGroup = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
      nameGroup.appendChild(el('div', { className: 'section-label', textContent: isNew ? 'Tên hiển thị mới' : 'Tên hiển thị' }));
      const inp = Object.assign(document.createElement('input'), {
        type: 'text',
        placeholder: 'Nhập tên...',
        value: isNew ? '' : targetNode.title
      });
      inp.style.cssText = 'width:100%;padding:8px 12px;box-sizing:border-box;';
      nameGroup.appendChild(inp);
      
      if (!isNew && !isManual && patch.title) {
        nameGroup.appendChild(el('button', {
          className: 'btn btn-outline btn-sm',
          textContent: '↩ Reset về tên gốc',
          style: 'align-self:flex-start;margin-top:4px;',
          onclick: async () => {
            const patches = { ..._overrides.patches };
            if (patches[nodeId]) {
              const { title: _, ...rest } = patches[nodeId];
              if (Object.keys(rest).length) patches[nodeId] = rest;
              else delete patches[nodeId];
            }
            await saveOverrides({ ..._overrides, patches });
            closeEditModal();
          }
        }));
      }
      modal.appendChild(nameGroup);

      // Hide toggle
      if (!isNew) {
        const hideBox = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(0,0,0,0.2);padding:10px 12px;border-radius:var(--radius-sm);margin-top:12px;' });
        const hideLabel = Object.assign(document.createElement('label'), { style: 'display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;font-size:.9rem;' });
        const chk = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!patch.hidden });
        hideLabel.appendChild(chk);
        hideLabel.appendChild(el('span', { textContent: 'Ẩn mục này' }));
        hideBox.appendChild(hideLabel);
        hideBox.appendChild(el('button', {
          className: 'btn btn-outline btn-sm', textContent: 'Áp dụng',
          onclick: async () => { await patchNode(nodeId, { hidden: chk.checked }); closeEditModal(); }
        }));
        modal.appendChild(hideBox);
      }

      // Actions
      const actions = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:16px;' });

      if (!isNew) {
        if (!isLesson && targetNode.children && targetNode.children.length > 0) {
          // Chapter with children -> promote logic
          const delGroup = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
          delGroup.appendChild(el('button', {
            className: 'btn btn-sm',
            style: 'background:var(--color-red);color:#fff;',
            textContent: '🗑️ Xóa tất cả',
            onclick: async () => {
              if (!confirm(\`Xóa hoàn toàn chương và tất cả bài bên trong?\`)) return;
              if (isManual) {
                // Remove from manualNodes
                const manualNodes = (_overrides.manualNodes || []).filter(n => n.id !== nodeId);
                await saveOverrides({ ..._overrides, manualNodes });
              } else {
                await patchNode(nodeId, { hidden: true });
                // Also hide children just to be safe
              }
              closeEditModal();
            }
          }));
          delGroup.appendChild(el('button', {
            className: 'btn btn-outline btn-sm',
            textContent: '↑ Giữ bài, thăng cấp lên trên',
            onclick: async () => {
              if (!confirm(\`Xóa chương này và đẩy tất cả bài bên trong ra cấp ngoài?\`)) return;
              // Reparent all children to parentId
              const reparent = { ..._overrides.reparent };
              targetNode.children.forEach(child => {
                reparent[child.id] = parentId;
              });
              let manualNodes = [...(_overrides.manualNodes || [])];
              if (isManual) {
                manualNodes = manualNodes.filter(n => n.id !== nodeId);
              }
              await saveOverrides({ ..._overrides, reparent, manualNodes });
              if (!isManual) {
                await patchNode(nodeId, { hidden: true });
              }
              closeEditModal();
            }
          }));
          actions.appendChild(delGroup);
        } else {
          actions.appendChild(el('button', {
            className: 'btn btn-sm',
            style: 'background:var(--color-red);color:#fff;',
            textContent: '🗑️ Xóa',
            onclick: async () => {
              if (!confirm(\`Xóa mục này?\`)) return;
              if (isManual) {
                const manualNodes = (_overrides.manualNodes || []).filter(n => n.id !== nodeId);
                await saveOverrides({ ..._overrides, manualNodes });
              } else {
                await patchNode(nodeId, { hidden: true });
              }
              closeEditModal();
            }
          }));
        }
      }

      const rightBtns = el('div', { style: 'display:flex;gap:8px;margin-left:auto;' });
      rightBtns.appendChild(el('button', { className: 'btn btn-outline btn-sm', textContent: 'Đóng', onclick: closeEditModal }));
      rightBtns.appendChild(el('button', {
        className: 'btn btn-primary btn-sm',
        textContent: isNew ? 'Tạo' : 'Lưu lại',
        onclick: async () => {
          const t = inp.value.trim();
          if (!t) { inp.focus(); return; }
          if (isNew) {
            const newNode = { id: \`manual-\${Date.now()}\`, title: t, type: isLesson ? 'lesson' : 'chapter', parentId, _isManual: true };
            if (!isLesson) newNode.children = [];
            await saveOverrides({ ..._overrides, manualNodes: [...(_overrides.manualNodes || []), newNode] });
          } else if (isManual) {
            const manual = (_overrides.manualNodes || []).map(c =>
              c.id === nodeId ? { ...c, title: t } : c
            );
            await saveOverrides({ ..._overrides, manualNodes: manual });
          } else {
            await patchNode(nodeId, { title: t });
          }
          closeEditModal();
        }
      }));
      actions.appendChild(rightBtns);
      modal.appendChild(actions);

      $('edit-overlay').style.display = 'block';
      modal.style.display = 'flex';
    }

    // A helper to find chapter by id deep in course.tree
    function findChapterById(node, id) {
      if (node.id === id) return node;
      if (node.tree) {
        for (let c of node.tree) {
          const f = findChapterById(c, id);
          if (f) return f;
        }
      } else if (node.children) {
        for (let c of node.children) {
          const f = findChapterById(c, id);
          if (f) return f;
        }
      }
      return null;
    }

    // ── PHASE 2: Edit Mode ──
`;

html = html.substring(0, startIndex) + newBuildTree + html.substring(endIndex + oldBuildTreeEnd.length);

fs.writeFileSync('index.html', html, 'utf8');
console.log('Patched index.html');
