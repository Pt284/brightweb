    // ── CONFIG ──
    const firebaseConfig = {
      apiKey: "AIzaSyCRLENh_UEBdXzukzpXVHHTltSapqyNWVc",
      authDomain: "brightwebaccbase.firebaseapp.com",
      projectId: "brightwebaccbase",
      storageBucket: "brightwebaccbase.firebasestorage.app",
      messagingSenderId: "482143691238",
      appId: "1:482143691238:web:67dd3871bc93bf08c03627",
      measurementId: "G-LXMQJM43PN"
    };
    const SYNC_PROXY_URL = "https://brightweb-sync.mcdg5444.workers.dev";

    // ── PARTICLES CONFIG ──
    const PARTICLES_CONFIG = {
      "particles": {
        "number": { "value": 50, "density": { "enable": true, "value_area": 300 } },
        "color": { "value": "#37b1f8" },
        "shape": { "type": "circle", "stroke": { "width": 4, "color": "#1d4470" } },
        "opacity": { "value": 1, "random": true, "anim": { "enable": true, "speed": 1, "opacity_min": 0.7, "sync": false } },
        "size": { "value": 5, "random": true, "anim": { "enable": true, "speed": 5, "size_min": 4, "sync": true } },
        "line_linked": { "enable": true, "distance": 130, "color": "#ffffff", "opacity": 0.3, "width": 1 },
        "move": { "enable": true, "speed": 4, "direction": "none", "random": true, "straight": false, "out_mode": "out", "bounce": false }
      },
      "interactivity": {
        "detect_on": "canvas",
        "events": { "onhover": { "enable": true, "mode": "bubble" }, "onclick": { "enable": true, "mode": "push" }, "resize": true },
        "modes": {
          "bubble": { "distance": 100, "size": 10, "duration": 0.97, "opacity": 0.99, "speed": 3 },
          "push": { "particles_nb": 4 }, "remove": { "particles_nb": 2 }
        }
      },
      "retina_detect": true
    };

    // ── FIREBASE ──
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const db = firebase.firestore();

    // ── STATE ──
    let appData = null, currentUser = null, progress = {};
    let currentCourseId = null, currentLessonId = null;
    let _isAdmin = false;
    let _openTreeNodes = new Set();
    let plyrInstance = null;
    // Phase 2
    // Fix 5: ngăn set editMode từ DevTools console
    let _editModeInternal = false;
    Object.defineProperty(window, 'editMode', {
      get()  { return _editModeInternal; },
      set(v) {
        // Chỉ cho phép toggle qua toggleEditMode() khi là admin
        if (_isAdmin) _editModeInternal = !!v;
      },
      configurable: false,
    });
    let _dragSrcIndex = null;
    // Plyr speed (khai báo sớm tránh TDZ trong destroyPlyr)
    let _holdSpeedActive = false;
    let _prevSpeed = 1;
    let _spaceTimer = null;

    // ── HELPERS ──
    const $ = id => document.getElementById(id);
    const showLoad = () => $('loading').classList.add('show');
    const hideLoad = () => $('loading').classList.remove('show');

    function safeUrl(url) {
      try {
        const u = new URL(url);
        return (u.protocol === 'https:' || u.protocol === 'http:') ? url : '#';
      } catch { return '#'; }
    }

    function el(tag, props = {}, ...children) {
      const e = document.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === 'className') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k === 'textContent') e.textContent = v;
        else if (k === 'onclick') e.addEventListener('click', v);
        else e.setAttribute(k, v);
      }
      for (const c of children) {
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      }
      return e;
    }

    // ── ROUTING ──
    function showPage(name) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const p = $('page-' + name);
      if (p) p.classList.add('active');
      if (name === 'landing' && !window._pjsLoaded) {
        window._pjsLoaded = true;
        particlesJS('particles-js', PARTICLES_CONFIG);
        requestAnimationFrame(() => {
          const pCanvas = document.querySelector('#particles-js canvas');
          if (pCanvas) pCanvas.style.background = 'transparent';
        });
      }
    }

    function navigate(hash, ...args) {
      if (hash === 'lesson' || hash === 'course') {
        if (window.pJSDom && window.pJSDom.length > 0) {
          window.pJSDom[0].pJS.fn.vendors.destroypJS();
          window.pJSDom = [];
        }
        const pjs = document.getElementById('particles-js');
        if (pjs) pjs.style.display = 'none';
      } else if (hash === 'home' || hash === 'landing') {
        const pjs = document.getElementById('particles-js');
        if (pjs) pjs.style.display = 'block';
        if (!window.pJSDom || window.pJSDom.length === 0) {
          if (window.particlesJS && typeof PARTICLES_CONFIG !== 'undefined') {
            particlesJS('particles-js', PARTICLES_CONFIG);
          }
        }
      }

      if (hash === 'home') {
        if (typeof destroyPlyr === 'function') destroyPlyr();
        window.location.hash = '#home'; renderHome(); showPage('home');
      } else if (hash === 'course') {
        const cId = args[0];
        const lastLid = currentUser ? localStorage.getItem(`last_lesson_${cId}_${currentUser.uid}`) : null;
        if (lastLid) {
          const course = findCourse(cId);
          if (course) {
            course.tree.forEach((chapter, i) => {
              if (chapter.type !== 'lesson' && getAllLessons(chapter).find(l => l.id === lastLid)) {
                _openTreeNodes.add(chapter.id || `folder_0_${i}`);
              }
            });
          }
          navigate('lesson', cId, lastLid);
          return;
        }
        if (typeof destroyPlyr === 'function') destroyPlyr();
        window.location.hash = `#course/${cId}`; renderCourse(cId);
      } else if (hash === 'lesson') {
        window.location.hash = `#lesson/${args[0]}/${args[1]}`; renderLesson(args[0], args[1]);
      }
    }

    function handleHash() {
      if (!currentUser || !appData) return;
      const h = window.location.hash;
      if (!h || h === '#home') { navigate('home'); return; }
      const p = h.replace('#', '').split('/');
      if (p[0] === 'course' && p[1]) { renderCourse(p[1]); return; }
      if (p[0] === 'lesson' && p[1] && p[2]) { renderLesson(p[1], p[2]); return; }
      navigate('home');
    }

    // ── AUTH ──
    function signInGoogle() {
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider).catch(e => alert('Lỗi đăng nhập: ' + e.message));
    }
    function signOut() { auth.signOut(); }

    auth.onAuthStateChanged(async user => {
      if (user) {
        showLoad();
        const allowed = await checkAccess(user);
        if (!allowed) {
          await logUnauthorized(user);
          await auth.signOut();
          hideLoad();
          alert(`⛔ Tài khoản ${user.email} không có quyền truy cập.\nLiên hệ quản trị viên để được cấp quyền.`);
          return;
        }
        currentUser = user;
        $('header').style.display = 'flex';
        $('user-info').textContent = user.displayName || user.email;
        if (_isAdmin) {
          $('btn-admin').style.display = '';
          $('btn-edit').style.display = '';
        }
        await loadData();
        await loadProgress();
        hideLoad();
        handleHash();
      } else {
        _isAdmin = false;
        editMode = false;
        document.body.classList.remove('edit-mode');
        currentUser = null; appData = null; progress = {};
        $('header').style.display = 'none';
        showPage('landing');
      }
    });

    async function checkAccess(user) {
      try {
        const [wlDoc, adminDoc] = await Promise.all([
          db.collection('whitelist').doc(user.email).get(),
          db.collection('admins').doc(user.email).get()
        ]);
        _isAdmin = adminDoc.exists;
        return wlDoc.exists || _isAdmin;
      } catch (e) { console.warn(e); return false; }
    }

    async function logUnauthorized(user) {
      try {
        await db.collection('security_logs').add({
          email: user.email, name: user.displayName || '',
          time: firebase.firestore.FieldValue.serverTimestamp(),
          ua: navigator.userAgent
        });
      } catch (e) { console.warn(e); }
    }

    // ── DATA ──
    async function loadData() {
      try {
        const doc = await db.collection('app_data').doc('courses').get();
        appData = doc.exists ? JSON.parse(doc.data().json) : getMockData();
        if ($('admin-last-updated'))
          $('admin-last-updated').textContent = 'Cập nhật: ' + (appData.lastUpdated || '—');
        await loadOverrides();
        _rawAutoData = JSON.parse(JSON.stringify(appData.courses));
        appData.courses = getMergedCourses(_rawAutoData, _overrides);

        const btnFlattenAll = document.getElementById('btn-flatten-all');
        const btnUnflatten = document.getElementById('btn-unflatten');
        if (btnFlattenAll && btnUnflatten) {
          btnFlattenAll.style.display = _overrides.flattenAll ? 'none' : '';
          btnUnflatten.style.display = _overrides.flattenAll ? '' : 'none';
        }
      } catch (e) { console.warn(e); appData = getMockData(); }
    }

    // ── PROGRESS SYNC ──
    async function loadProgress() {
      if (!currentUser) return;
      progress = {};
      try {
        const snap = await db.collection('progress')
          .where('userId', '==', currentUser.uid).get();
        snap.forEach(doc => {
          const d = doc.data();
          if (d.watched) progress[d.lessonId] = true;
          if (d.watchedTime > 0 || d.duration > 0) {
            const localKey = `prog_${currentUser.uid}_${d.lessonId}`;
            let local = null;
            try { local = JSON.parse(localStorage.getItem(localKey)); } catch (e) { }
            const fsTimestamp = d.updatedAt?.toMillis?.() || 0;
            const localTimestamp = local?.updatedAt || 0;
            if (!local || fsTimestamp > localTimestamp) {
              localStorage.setItem(localKey, JSON.stringify({
                watchedTime: d.watchedTime || 0,
                duration: d.duration || 0,
                watched: d.watched || false,
                updatedAt: fsTimestamp
              }));
            }
          }
        });
      } catch (e) { console.warn('loadProgress error:', e); }
    }

    const _syncTimers = {};

    function scheduleFirestoreSync(lessonId, courseId, delay = 30000) {
      if (_syncTimers[lessonId]) clearTimeout(_syncTimers[lessonId]);
      _syncTimers[lessonId] = setTimeout(() => flushProgressToFirestore(lessonId, courseId), delay);
    }

    async function flushProgressToFirestore(lessonId, courseId) {
      if (!currentUser || !lessonId) return;
      const local = getLocalProgress(lessonId);
      if (!local || local.watchedTime == null) return;
      if (_syncTimers[lessonId]) { clearTimeout(_syncTimers[lessonId]); delete _syncTimers[lessonId]; }
      try {
        await db.collection('progress').doc(`${currentUser.uid}_${lessonId}`).set({
          userId: currentUser.uid, lessonId,
          courseId: courseId || currentCourseId || '',
          watched: !!progress[lessonId],
          watchedTime: local.watchedTime || 0,
          duration: local.duration || 0,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) { console.warn('Firestore flush error:', e); }
    }

    function getLocalProgress(lessonId) {
      if (!currentUser) return null;
      try { return JSON.parse(localStorage.getItem(`prog_${currentUser.uid}_${lessonId}`)); } catch (e) { return null; }
    }

    function saveLocalProgress(lessonId, watchedTime, duration, ytId) {
      if (!currentUser) return;
      try {
        const old = getLocalProgress(lessonId) || {};
        const oldMax = old.watchedTime || 0;
        if (watchedTime - oldMax > 600) return;
        const maxTime = Math.max(oldMax, watchedTime);
        const p = { ...old, watchedTime: maxTime, duration, ytId, updatedAt: Date.now() };
        localStorage.setItem(`prog_${currentUser.uid}_${lessonId}`, JSON.stringify(p));
        scheduleFirestoreSync(lessonId, currentCourseId, 30000);
      } catch (e) { }
    }

    async function saveProgress(lessonId, courseId, watched) {
      if (!currentUser) return;
      try {
        const old = getLocalProgress(lessonId) || {};
        const updated = { ...old, watched, updatedAt: Date.now() };
        localStorage.setItem(`prog_${currentUser.uid}_${lessonId}`, JSON.stringify(updated));
        const local = getLocalProgress(lessonId) || {};
        await db.collection('progress').doc(`${currentUser.uid}_${lessonId}`).set({
          userId: currentUser.uid, lessonId, courseId, watched,
          watchedTime: local.watchedTime || 0,
          duration: local.duration || 0,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) { console.warn('saveProgress error:', e); }
    }

    // ── TREE HELPERS ──
    const findCourse = id => appData.courses.find(c => c.id === id);
    function getAllLessons(node) {
      if (node._hidden) return [];
      if (node.type === 'lesson') return [node];
      return (node.children || []).flatMap(getAllLessons);
    }
    function getAllLessonsIncHidden(node) {
      if (node.type === 'lesson') return [node];
      return (node.children || []).flatMap(getAllLessonsIncHidden);
    }
    function findLesson(course, lid) {
      return course.tree.flatMap(getAllLessonsIncHidden).find(l => l.id === lid);
    }
    function countProgress(course) {
      const all = course.tree.flatMap(getAllLessons);
      return { done: all.filter(l => progress[l.id]).length, total: all.length };
    }

    function getLessonProgressPct(lessonId) {
      if (progress[lessonId]) return 100;
      const p = getLocalProgress(lessonId);
      if (p && p.duration > 0 && p.watchedTime > 0) {
        return Math.min(99, Math.floor((p.watchedTime / p.duration) * 100));
      }
      return 0;
    }

    function getChapterProgressPct(node) {
      const all = getAllLessons(node);
      if (all.length === 0) return 0;
      let sum = 0;
      all.forEach(l => sum += getLessonProgressPct(l.id));
      return Math.floor(sum / all.length);
    }

    function getCourseProgressPct(course) {
      const all = course.tree.flatMap(getAllLessons);
      if (all.length === 0) return 0;
      let sum = 0;
      all.forEach(l => sum += getLessonProgressPct(l.id));
      return Math.floor(sum / all.length);
    }

    function updateRealtimeProgressUI() {
      const course = findCourse(currentCourseId);
      if (course) {
        const pct = getCourseProgressPct(course);
        if ($('sidebar-lesson-tree')) {
          $('sidebar-lesson-tree').innerHTML = '';
          $('sidebar-lesson-tree').appendChild(buildTree(course.tree, currentCourseId, 0, currentLessonId, currentCourseId));
        }
        if ($('sidebar-lesson-title')) $('sidebar-lesson-title').textContent = `${course.title} - ${pct}%`;
        if ($('sidebar-title')) $('sidebar-title').textContent = `${course.title} - ${pct}%`;
      }
    }

    // ── RENDER: HOME (Phase 2) ──
    function renderHome() {
      showPage('home');
      const grid = $('course-grid');
      grid.innerHTML = '';
      
      const btnResetCourses = $('btn-reset-courses');
      if (btnResetCourses) btnResetCourses.style.display = editMode ? '' : 'none';

      // Ẩn hidden khi không edit, hiện mờ khi edit
      const visible = editMode ? appData.courses : appData.courses.filter(c => !c._hidden);

      visible.forEach((course, index) => {
        const { done, total } = countProgress(course);
        const pct = getCourseProgressPct(course);
        const fill = el('div', { className: 'progress-fill', style: `width:${pct}%` });
        const bar = el('div', { className: 'progress-bar' }, fill);
        const label = el('div', { className: 'progress-label', textContent: `${done}/${total} bài · ${pct}%` });
        const title = el('h3', { textContent: course.title });

        const card = el('div', { className: 'course-card glass' + (course._hidden ? ' is-hidden-course' : '') });
        card.appendChild(title);
        card.appendChild(bar);
        card.appendChild(label);
        if (course._hidden) card.appendChild(el('span', { className: 'hidden-badge', textContent: '🚫 Đang ẩn' }));

        if (editMode) {
          card.style.position = 'relative';
          card.setAttribute('draggable', 'true');

          const editBtn = document.createElement('button');
          editBtn.className = 'btn-icon';
          editBtn.textContent = '✏️';
          editBtn.style.cssText = 'position:absolute;top:6px;right:6px;font-size:14px;z-index:1;';
          editBtn.addEventListener('click', e => { e.stopPropagation(); openCourseModal(course.id); });
          card.appendChild(editBtn);

          card.addEventListener('click', () => openCourseModal(course.id));

          card.addEventListener('dragstart', e => {
            _dragSrcIndex = index;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => card.classList.add('dragging'), 0);
          });
          card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(n => n.classList.remove('drag-over'));
          });
          card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
          card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
          card.addEventListener('drop', async e => {
            e.preventDefault();
            card.classList.remove('drag-over');
            if (_dragSrcIndex === null || _dragSrcIndex === index) { _dragSrcIndex = null; return; }
            const arr = [...visible];
            arr.splice(index, 0, arr.splice(_dragSrcIndex, 1)[0]);
            _dragSrcIndex = null;
            await saveOverrides({ ..._overrides, courseDisplayOrder: arr.map(c => c.id) });
          });
        } else {
          card.addEventListener('click', () => navigate('course', course.id));
        }

        grid.appendChild(card);
      });

      if (editMode) {
        grid.appendChild(el('div', {
          className: 'course-card glass',
          style: 'display:flex;align-items:center;justify-content:center;font-size:2.5rem;opacity:.5;cursor:pointer;border:2px dashed var(--color-border);',
          textContent: '＋',
          onclick: () => openCourseModal(null)
        }));
      }
    }

    // ── RENDER: TREE ──
    let _clipboard = null;
    let _dragSidebarSrc = null;
    let _selectedNodes = new Map();

    document.addEventListener('keydown', (e) => {
      if (!editMode) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        _selectedNodes.clear();
        _clipboard = null;
        document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
        updateRealtimeProgressUI();
      } else if (e.key === 'Delete') {
        if (_selectedNodes.size > 0) {
          for (const id of _selectedNodes.keys()) patchNode(id, { hidden: true });
          _selectedNodes.clear();
          updateRealtimeProgressUI();
        }
      } else if (e.ctrlKey && e.key === 'x') {
        if (_selectedNodes.size > 0) {
          document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
          _clipboard = { action: 'cut', nodes: Array.from(_selectedNodes.values()) };
          for (const id of _selectedNodes.keys()) {
            const w = document.querySelector(`.tree-node[data-node-id="${id}"]`);
            if (w) w.classList.add('is-cut');
          }
          _selectedNodes.clear();
          updateRealtimeProgressUI();
        }
      } else if (e.ctrlKey && e.key === 'c') {
        if (_selectedNodes.size > 0) {
          _clipboard = { action: 'copy', nodes: Array.from(_selectedNodes.values()) };
          _selectedNodes.clear();
          updateRealtimeProgressUI();
        }
      } else if (e.ctrlKey && e.key === 'v') {
        if (_clipboard && _clipboard.nodes && _clipboard.nodes.length > 0) {
          alert('Vui lòng chọn vị trí "📑 Dán" tương ứng trong giao diện.');
        }
      } else if (e.ctrlKey && e.key === 'z') {
        doUndo();
      } else if (e.ctrlKey && e.key === 'y') {
        doRedo();
      }
    });

    function buildTree(nodes, courseId, indent, activeId, parentId) {
      const ul = document.createElement('div');
      ul.className = 'tree-list';
      ul.dataset.parentId = parentId;

      if (indent === 0 && editMode) {
        const tb = document.createElement('div');
        tb.className = 'clipboard-toolbar';
        tb.style.cssText = 'padding:8px; display:flex; gap:6px; background:rgba(0,0,0,0.2); margin-bottom:8px; border-radius:6px; font-size:0.85rem; align-items:center;';
        
        const label = document.createElement('span');
        label.textContent = '📋 Clipboard:';
        label.style.color = 'var(--text-muted)';
        tb.appendChild(label);

        if (_selectedNodes.size > 0) {
          const cutBtn = document.createElement('button');
          cutBtn.className = 'btn btn-outline btn-sm';
          cutBtn.textContent = '✂️ Cắt ' + _selectedNodes.size + ' mục';
          cutBtn.onclick = () => {
            document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
            _clipboard = { action: 'cut', nodes: Array.from(_selectedNodes.values()) };
            for (const id of _selectedNodes.keys()) {
              const w = document.querySelector(`.tree-node[data-node-id="${id}"]`);
              if (w) w.classList.add('is-cut');
            }
            _selectedNodes.clear();
            updateRealtimeProgressUI();
          };
          
          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn btn-outline btn-sm';
          copyBtn.textContent = '📋 Copy ' + _selectedNodes.size + ' mục';
          copyBtn.onclick = () => {
            document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
            _clipboard = { action: 'copy', nodes: Array.from(_selectedNodes.values()) };
            _selectedNodes.clear();
            updateRealtimeProgressUI();
          };

          tb.appendChild(cutBtn);
          tb.appendChild(copyBtn);
        } else if (_clipboard && _clipboard.nodes && _clipboard.nodes.length > 0) {
          const actionText = _clipboard.action === 'cut' ? '✂️' : '📋';
          const names = _clipboard.nodes.map(n => n.node.title).join(', ');
          
          const span = document.createElement('span');
          span.textContent = actionText + ' ' + names;
          span.style.cssText = 'flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
          tb.appendChild(span);

          const closeBtn = document.createElement('button');
          closeBtn.className = 'btn-icon';
          closeBtn.textContent = '✕';
          closeBtn.onclick = () => {
            _clipboard = null;
            document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
            updateRealtimeProgressUI();
          };
          tb.appendChild(closeBtn);
        } else {
          const span = document.createElement('span');
          span.textContent = 'Trống';
          span.style.cssText = 'flex:1; color:var(--text-muted)';
          tb.appendChild(span);
        }

        const dot = document.createElement('span');
        dot.textContent = '·';
        dot.style.cssText = 'color:var(--text-muted); margin:0 4px;';
        tb.appendChild(dot);

        const hints = document.createElement('span');
        hints.textContent = 'Phím tắt: Ctrl+Z Hoàn tác · Esc Hủy · Del Ẩn';
        hints.style.cssText = 'font-size: 0.75rem; color:var(--color-text-dim)';
        tb.appendChild(hints);

        ul.appendChild(tb);
      }

      const btnStyle = 'width: 12px; height: 12px; padding: 2px; font-size: 12px; display: flex; align-items: center; justify-content: center; line-height: 1; box-sizing: content-box;';

      nodes.forEach((node, i) => {
        const wrap = document.createElement('div'); wrap.className = 'tree-node';
        if (node._hidden && !editMode) return;
        if (node._hidden) wrap.classList.add('is-hidden');
        if (_clipboard && _clipboard.action === 'cut' && _clipboard.nodes.find(n => n.node.id === node.id)) {
          wrap.classList.add('is-cut');
        }

        const label = document.createElement('div'); label.className = 'tree-label';
        label.style.paddingLeft = (14 + indent * 14) + 'px';

        const nodeId = node.id || `folder_${indent}_${i}`;
        
        if (editMode) {
          wrap.setAttribute('draggable', 'true');
          wrap.dataset.nodeId = nodeId;
          wrap.dataset.parentId = parentId;
          
          wrap.addEventListener('dragstart', e => {
            e.stopPropagation();
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
            
            if (_dragSidebarSrc.parentId === parentId) {
              const currentOrder = nodes.map((n, idx) => n.id || `folder_${indent}_${idx}`);
              const [moved] = currentOrder.splice(_dragSidebarSrc.index, 1);
              currentOrder.splice(i, 0, moved);
              _dragSidebarSrc = null;
              await patchNode(parentId, { childOrder: currentOrder });
            } else {
              alert('Kéo thả giữa các chương khác nhau: Hãy dùng chức năng Cắt (✂️) và Dán (📑).');
            }
          });
        }

        if (node.type === 'lesson') {
          if (editMode) {
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.justifyContent = 'space-between';
            label.style.gap = '12px';
            label.style.position = 'relative';
            if (node._hidden) label.style.opacity = '0.6';

            const wrapLeft = document.createElement('div');
            wrapLeft.style.cssText = 'display: flex; align-items: flex-start; gap: 6px; flex: 1 1 0%; min-width: 0;';
            
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.style.marginTop = '4px';
            cb.checked = _selectedNodes.has(nodeId);
            cb.onclick = (e) => e.stopPropagation();
            cb.onchange = (e) => {
              if (cb.checked) _selectedNodes.set(nodeId, { node, parentId });
              else _selectedNodes.delete(nodeId);
              updateRealtimeProgressUI();
            };
            wrapLeft.appendChild(cb);

            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.style.cssText = 'flex-shrink: 0; padding-top: 2px;';
            icon.textContent = '📄';
            
            let titleText = node.title;
            if (node._hidden) titleText += ' (Đang ẩn)';
            const titleSpan = document.createElement('span');
            titleSpan.style.cssText = 'font-size: 0.95rem; line-height: 1.4; word-break: break-word;';
            titleSpan.textContent = titleText;
            
            wrapLeft.appendChild(icon);
            wrapLeft.appendChild(titleSpan);
            label.appendChild(wrapLeft);

            const editActions = document.createElement('div');
            editActions.className = 'tree-edit-actions';
            editActions.style.cssText = 'display: grid; grid-template-columns: repeat(2, auto); gap: 3px; flex-shrink: 0; align-self: center;';

            const editBtn = document.createElement('button');
            editBtn.className = 'btn-icon';
            editBtn.title = 'Sửa';
            editBtn.textContent = '✏️';
            editBtn.style.cssText = btnStyle;
            editBtn.onclick = (e) => { e.stopPropagation(); openChapterModal(courseId, nodeId, parentId, node); };

            const cutBtn = document.createElement('button');
            cutBtn.className = 'btn-icon';
            cutBtn.title = 'Cắt';
            cutBtn.textContent = '✂️';
            cutBtn.style.cssText = btnStyle;
            cutBtn.onclick = (e) => { 
              e.stopPropagation(); 
              document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
              _clipboard = { action: 'cut', nodes: [{ node, parentId }] }; 
              _selectedNodes.clear();
              updateRealtimeProgressUI(); 
            };

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-icon';
            copyBtn.title = 'Sao chép';
            copyBtn.textContent = '📋';
            copyBtn.style.cssText = btnStyle;
            copyBtn.onclick = (e) => { 
              e.stopPropagation(); 
              _clipboard = { action: 'copy', nodes: [{ node, parentId }] }; 
              _selectedNodes.clear();
              updateRealtimeProgressUI(); 
            };

            const hideBtn = document.createElement('button');
            hideBtn.className = 'btn-icon';
            hideBtn.title = node._hidden ? 'Bỏ ẩn' : 'Ẩn bài';
            hideBtn.textContent = node._hidden ? '❌' : '👁️';
            hideBtn.style.cssText = btnStyle;
            hideBtn.onclick = async (e) => {
              e.stopPropagation();
              await patchNode(nodeId, { hidden: !node._hidden });
            };

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn-icon';
            deleteBtn.title = 'Xóa';
            deleteBtn.textContent = '🗑️';
            deleteBtn.style.cssText = btnStyle;
            deleteBtn.onclick = async (e) => {
              e.stopPropagation();
              if (!confirm('Xóa mục này?')) return;
              if (node._isManual) {
                const manualNodes = (_overrides.manualNodes || []).filter(n => n.id !== nodeId);
                await saveOverrides({ ..._overrides, manualNodes });
              } else {
                await patchNode(nodeId, { hidden: true });
              }
            };

            const resetTitleBtn = document.createElement('button');
            resetTitleBtn.className = 'btn-icon';
            resetTitleBtn.title = 'Reset tên gốc';
            resetTitleBtn.textContent = '↺';
            resetTitleBtn.style.cssText = btnStyle;
            const hasCustomTitle = !node._isManual && !!_overrides.patches?.[nodeId]?.title;
            if (!hasCustomTitle) {
              resetTitleBtn.style.opacity = '0.3';
              resetTitleBtn.style.cursor = 'not-allowed';
            }
            resetTitleBtn.onclick = async (e) => {
              e.stopPropagation();
              if (!hasCustomTitle) return;
              await resetNodeTitle(nodeId);
            };

            editActions.append(editBtn, cutBtn, copyBtn, hideBtn, deleteBtn, resetTitleBtn);
            label.appendChild(editActions);
          } else {
            const pct = getLessonProgressPct(node.id);
            const isDone = pct === 100;

            const barTrack = document.createElement('div'); barTrack.className = 'bar-track';
            const barFill = document.createElement('div'); barFill.className = 'bar-fill ' + (isDone ? 'done' : pct > 0 ? '' : 'low'); barFill.style.width = pct + '%';
            barTrack.appendChild(barFill);
            const barBadgeSpan = document.createElement('span'); barBadgeSpan.textContent = pct + '%';
            const barBadge = document.createElement('span'); barBadge.className = 'bar-badge';
            barBadge.appendChild(barTrack); barBadge.appendChild(barBadgeSpan);

            const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = '📄';
            const titleSpan = document.createElement('span'); titleSpan.style.flex = '1'; titleSpan.textContent = node.title;
            if (node._hidden) titleSpan.textContent += ' (Đang ẩn)';

            label.appendChild(icon); label.appendChild(titleSpan); label.appendChild(barBadge);
          }

          if (node.id === activeId) label.classList.add('active-lesson');
          label.addEventListener('click', (e) => {
            if (e.target.closest('.btn-icon') || e.target.tagName === 'INPUT') return;
            navigate('lesson', courseId, node.id);
          });
        } else {
          const ch = document.createElement('div'); ch.className = 'tree-children';
          
          const isOpen = _openTreeNodes.has(nodeId);
          if (isOpen) ch.classList.add('open');

          if (editMode) {
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.justifyContent = 'space-between';
            label.style.gap = '12px';
            label.style.position = 'relative';
            if (node._hidden) label.style.opacity = '0.6';

            const wrapLeft = document.createElement('div');
            wrapLeft.style.cssText = 'display: flex; align-items: center; gap: 6px; flex: 1 1 0%; min-width: 0;';
            
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = _selectedNodes.has(nodeId);
            cb.onclick = (e) => e.stopPropagation();
            cb.onchange = (e) => {
              if (cb.checked) {
                _selectedNodes.set(nodeId, { node, parentId });
                function checkAll(n, pId) {
                  if (n.id) _selectedNodes.set(n.id, { node: n, parentId: pId });
                  if (n.children) n.children.forEach(c => checkAll(c, n.id));
                }
                if (node.children) node.children.forEach(c => checkAll(c, nodeId));
              } else {
                _selectedNodes.delete(nodeId);
                function uncheckAll(n) {
                  if (n.id) _selectedNodes.delete(n.id);
                  if (n.children) n.children.forEach(uncheckAll);
                }
                if (node.children) node.children.forEach(uncheckAll);
              }
              updateRealtimeProgressUI();
            };
            wrapLeft.appendChild(cb);

            const icon = document.createElement('span');
            icon.className = 'icon toggle-icon';
            icon.textContent = isOpen ? '▼' : '▶';
            
            let titleText = node.title;
            if (node._hidden) titleText += ' (Đang ẩn)';
            const titleSpan = document.createElement('span');
            titleSpan.textContent = titleText;

            wrapLeft.appendChild(icon);
            wrapLeft.appendChild(titleSpan);
            label.appendChild(wrapLeft);

            const editActions = document.createElement('div');
            editActions.className = 'tree-edit-actions';
            editActions.style.cssText = 'display: grid; grid-template-columns: repeat(4, auto); gap: 3px; flex-shrink: 0; align-self: center;';

            const flattenBtn = document.createElement('button');
            flattenBtn.className = 'btn-icon';
            flattenBtn.title = 'Làm phẳng';
            flattenBtn.textContent = '⚡';
            flattenBtn.style.cssText = btnStyle;
            flattenBtn.disabled = !node.children?.length;
            if (!node.children?.length) flattenBtn.style.opacity = '0.3';
            flattenBtn.onclick = async (e) => {
              e.stopPropagation();
              if (flattenBtn.disabled) return;
              await patchNode(nodeId, { flattenChildren: true });
            };

            const editBtn = document.createElement('button');
            editBtn.className = 'btn-icon';
            editBtn.title = 'Sửa';
            editBtn.textContent = '✏️';
            editBtn.style.cssText = btnStyle;
            editBtn.onclick = (e) => { e.stopPropagation(); openChapterModal(courseId, nodeId, parentId, node); };

            const cutBtn = document.createElement('button');
            cutBtn.className = 'btn-icon';
            cutBtn.title = 'Cắt';
            cutBtn.textContent = '✂️';
            cutBtn.style.cssText = btnStyle;
            cutBtn.onclick = (e) => { 
              e.stopPropagation(); 
              document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
              _clipboard = { action: 'cut', nodes: [{ node, parentId }] }; 
              _selectedNodes.clear();
              updateRealtimeProgressUI(); 
            };

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn-icon';
            copyBtn.title = 'Sao chép';
            copyBtn.textContent = '📋';
            copyBtn.style.cssText = btnStyle;
            copyBtn.onclick = (e) => { 
              e.stopPropagation(); 
              _clipboard = { action: 'copy', nodes: [{ node, parentId }] }; 
              _selectedNodes.clear();
              updateRealtimeProgressUI(); 
            };

            const pasteBtn = document.createElement('button');
            pasteBtn.className = 'btn-icon';
            pasteBtn.title = 'Dán';
            pasteBtn.textContent = '📑';
            pasteBtn.style.cssText = btnStyle;
            pasteBtn.onclick = (e) => {
              e.stopPropagation();
              if (_clipboard && _clipboard.nodes && _clipboard.nodes.length > 0) handlePaste(courseId, nodeId);
            };
            const clipboardHasLesson = _clipboard && _clipboard.nodes && _clipboard.nodes.some(n => n.node.type !== 'chapter');
            if (!clipboardHasLesson) {
              pasteBtn.style.opacity = '0.3';
              pasteBtn.style.cursor = 'not-allowed';
            }

            const hideBtn = document.createElement('button');
            hideBtn.className = 'btn-icon';
            hideBtn.title = node._hidden ? 'Bỏ ẩn' : 'Ẩn/Hiện';
            hideBtn.textContent = node._hidden ? '❌' : '👁️';
            hideBtn.style.cssText = btnStyle;
            hideBtn.onclick = async (e) => {
              e.stopPropagation();
              await patchNode(nodeId, { hidden: !node._hidden });
            };

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn-icon';
            deleteBtn.title = 'Xóa';
            deleteBtn.textContent = '🗑️';
            deleteBtn.style.cssText = btnStyle;
            deleteBtn.onclick = async (e) => {
              e.stopPropagation();
              const hasChildren = !!(node.children?.length);
              if (hasChildren) {
                openChapterModal(courseId, nodeId, parentId, node);
              } else {
                if (!confirm('Xóa mục này?')) return;
                if (node._isManual) {
                  const manualNodes = (_overrides.manualNodes || []).filter(n => n.id !== nodeId);
                  await saveOverrides({ ..._overrides, manualNodes });
                } else {
                  await patchNode(nodeId, { hidden: true });
                }
              }
            };

            const resetTitleBtn = document.createElement('button');
            resetTitleBtn.className = 'btn-icon';
            resetTitleBtn.title = 'Reset tên gốc';
            resetTitleBtn.textContent = '↺';
            resetTitleBtn.style.cssText = btnStyle;
            const hasCustomTitle = !node._isManual && !!_overrides.patches?.[nodeId]?.title;
            if (!hasCustomTitle) {
              resetTitleBtn.style.opacity = '0.3';
              resetTitleBtn.style.cursor = 'not-allowed';
            }
            resetTitleBtn.onclick = async (e) => {
              e.stopPropagation();
              if (!hasCustomTitle) return;
              await resetNodeTitle(nodeId);
            };

            editActions.append(flattenBtn, editBtn, cutBtn, copyBtn, pasteBtn, hideBtn, deleteBtn, resetTitleBtn);
            label.appendChild(editActions);
          } else {
            const icon = document.createElement('span'); icon.className = 'icon toggle-icon'; icon.textContent = isOpen ? '▼' : '▶';
            const titleSpan = document.createElement('span'); titleSpan.style.flex = '1'; titleSpan.textContent = node.title;
            if (node._hidden) titleSpan.textContent += ' (Đang ẩn)';

            const pct = getChapterProgressPct(node);
            const color = pct === 100 ? 'var(--progress-done)' : pct >= 50 ? 'var(--progress-fill)' : 'var(--progress-low)';
            const dash = (pct * 87.96) / 100;

            const arcWrap = document.createElement('div'); arcWrap.className = 'arc-wrap'; arcWrap.setAttribute('aria-label', pct + '%');
            arcWrap.innerHTML = `
              <svg width="24" height="24" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="14" fill="none" stroke="var(--progress-track)" stroke-width="4"/>
                <circle cx="18" cy="18" r="14" fill="none" stroke="${color}" stroke-width="4"
                  stroke-dasharray="${dash} 87.96" stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 18 18)"/>
              </svg>
              <span class="arc-label" style="font-size:8px; color:${color}; font-weight:bold;">${pct}%</span>
            `;

            label.appendChild(icon); label.appendChild(titleSpan); label.appendChild(arcWrap);
          }

          label.addEventListener('click', (e) => {
            if (e.target.closest('.btn-icon') || e.target.tagName === 'INPUT') return;
            const o = ch.classList.toggle('open');
            label.querySelector('.toggle-icon').textContent = o ? '▼' : '▶';
            if (o) _openTreeNodes.add(nodeId);
            else _openTreeNodes.delete(nodeId);
          });

          if (node.children) ch.appendChild(buildTree(node.children, courseId, indent + 1, activeId, nodeId));
          
          if (editMode && isOpen) {
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display: flex; gap: 8px; margin: 8px 0 4px ' + (14 + (indent+1)*14) + 'px;';
            
            const addBtn = document.createElement('button');
            addBtn.className = 'btn btn-outline btn-sm';
            addBtn.textContent = '＋ Thêm bài';
            addBtn.style.cssText = 'flex: 1 1 0%; margin: 0;';
            addBtn.onclick = () => openChapterModal(courseId, null, nodeId, { type: 'lesson' });
            
            const resetBtn = document.createElement('button');
            resetBtn.className = 'btn btn-outline btn-sm';
            resetBtn.textContent = '↺ Reset thứ tự';
            resetBtn.style.cssText = 'flex: 1 1 0%; margin: 0;';
            resetBtn.onclick = async () => {
              await patchNode(nodeId, { childOrder: [] });
            };
            
            btnRow.appendChild(addBtn);
            btnRow.appendChild(resetBtn);
            ch.appendChild(btnRow);
          }

          wrap.appendChild(label); wrap.appendChild(ch); ul.appendChild(wrap); return;
        }
        wrap.appendChild(label); ul.appendChild(wrap);
      });
      
      if (editMode && indent === 0) {
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 8px; margin: 8px 0;';
        
        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-outline btn-sm';
        addBtn.textContent = '＋ Thêm chương';
        addBtn.style.cssText = 'flex: 1 1 0%; margin: 0;';
        addBtn.onclick = () => openChapterModal(courseId, null, courseId, { type: 'chapter' });
        
        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn btn-outline btn-sm';
        resetBtn.textContent = '↺ Reset thứ tự';
        resetBtn.style.cssText = 'flex: 1 1 0%; margin: 0;';
        resetBtn.onclick = async () => {
          await patchNode(courseId, { childOrder: [] });
        };
        
        const resetCourseBtn = document.createElement('button');
        resetCourseBtn.className = 'btn btn-outline btn-sm';
        resetCourseBtn.textContent = '🔄 Reset khóa học';
        resetCourseBtn.style.cssText = 'flex: 1 1 0%; margin: 0; color: var(--color-red); border-color: var(--color-red);';
        resetCourseBtn.onclick = () => resetCurrentCourse(courseId);
        
        btnRow.appendChild(addBtn);
        const clipboardHasItems = _clipboard && _clipboard.nodes && _clipboard.nodes.length > 0;
        if (clipboardHasItems) {
          const pasteRootBtn = document.createElement('button');
          pasteRootBtn.className = 'btn btn-outline btn-sm';
          pasteRootBtn.textContent = '📌 Dán vào đây';
          pasteRootBtn.style.cssText = 'flex: 1 1 0%; margin: 0;';
          pasteRootBtn.onclick = () => handlePaste(courseId, courseId);
          btnRow.appendChild(pasteRootBtn);
        }
        btnRow.appendChild(resetBtn);
        btnRow.appendChild(resetCourseBtn);
        
        ul.appendChild(btnRow);
      }

      return ul;
    }

    async function handlePaste(courseId, destParentId) {
      if (!_clipboard || !_clipboard.nodes || _clipboard.nodes.length === 0) return;
      
      const destIsCourse = destParentId === courseId;
      const { action, nodes } = _clipboard;
      
      _clipboard = null;
      document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
      
      let manualNodes = [...(_overrides.manualNodes || [])];
      let reparent = { ..._overrides.reparent };
      let changed = false;

      for (const item of nodes) {
        const { node, parentId: srcParentId } = item;
        const nodeIsChapter = node.type === 'chapter';
        
        if (nodeIsChapter && !destIsCourse) continue;
        
        let targetParentId = destParentId;
        if (!nodeIsChapter && destIsCourse) {
            const courseIds = appData.courses.map(c => c.id);
            if (courseIds.includes(srcParentId)) {
                targetParentId = destParentId;
            } else {
                continue;
            }
        }

        if (action === 'cut') {
          if (srcParentId === targetParentId) continue;
          if (node._isManual) {
            const idx = manualNodes.findIndex(n => n.id === node.id);
            if (idx >= 0) {
              manualNodes[idx].parentId = targetParentId;
              changed = true;
            }
          } else {
            reparent[node.id] = targetParentId;
            changed = true;
          }
        } else if (action === 'copy') {
          const newNode = JSON.parse(JSON.stringify(node));
          if (typeof assignNewIds === 'function') assignNewIds(newNode);
          else newNode.id = `manual-${Date.now()}-${Math.floor(Math.random()*1000)}`;
          newNode._isManual = true;
          newNode.parentId = targetParentId;
          manualNodes.push(newNode);
          changed = true;
        }
      }

      if (changed) {
        await saveOverrides({ ..._overrides, manualNodes, reparent });
      } else {
        updateRealtimeProgressUI();
      }
    }
    async function resetNodeTitle(nodeId) {
      const patches = { ..._overrides.patches };
      if (patches[nodeId]) {
        const { title: _, ...rest } = patches[nodeId];
        if (Object.keys(rest).length) patches[nodeId] = rest;
        else delete patches[nodeId];
      }
      await saveOverrides({ ..._overrides, patches });
    }

    function openChapterModal(courseId, nodeId, parentId, nodeProps = {}) {
      const isNew = !nodeId;
      const isLesson = nodeProps?.type === 'lesson';
      const targetNode = nodeProps;
      const isManual = !!targetNode._isManual;
      const patch = _overrides.patches?.[nodeId] || {};

      const modal = $('edit-modal');
      modal.innerHTML = '';
      
      modal.className = 'glass';
      modal.style.cssText = 'display:flex;flex-direction:column;gap:18px;padding:24px;min-width:340px;max-width:440px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.25);position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1001;max-height:80vh;overflow-y:auto;';

      const titleStr = isNew ? (isLesson ? '➕ Thêm bài học' : '➕ Thêm chương') : (isLesson ? '✏️ Sửa bài học' : '✏️ Sửa chương');
      modal.appendChild(el('h4', { textContent: titleStr, style: 'margin:0;font-size:1.15rem;font-weight:600;' }));

      const nameGroup = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
      nameGroup.appendChild(el('div', { className: 'section-label', textContent: isNew ? 'Tên hiển thị mới' : 'Tên hiển thị' }));
      const inp = Object.assign(document.createElement('input'), {
        type: 'text',
        placeholder: 'Nhập tên...',
        value: isNew ? '' : targetNode.title
      });
      inp.style.cssText = 'width:100%;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.1);color:inherit;padding:8px 12px;box-sizing:border-box;';
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

      if (!isNew) {
        const hideBox = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(0,0,0,0.15);padding:10px 12px;border-radius:8px;' });
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

      if (!isNew) {
        if (!isLesson && targetNode.children && targetNode.children.length > 0) {
          const bottomRow = el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-top:16px;' });
          
          const leftCol = el('div', { style: 'display:flex;flex-direction:column;gap:6px;max-width:50%;' });
          leftCol.appendChild(el('button', {
            className: 'btn btn-sm',
            style: 'background:var(--color-red);color:white;',
            textContent: '🗑️ Xóa tất cả',
            onclick: async () => {
              if (!confirm(`Xóa hoàn toàn chương và tất cả bài bên trong?`)) return;
              if (isManual) {
                const manualNodes = (_overrides.manualNodes || []).filter(n => n.id !== nodeId);
                await saveOverrides({ ..._overrides, manualNodes });
              } else {
                await patchNode(nodeId, { hidden: true });
              }
              closeEditModal();
            }
          }));
          leftCol.appendChild(el('button', {
            className: 'btn btn-outline btn-sm',
            style: 'font-size:0.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
            textContent: '↑ Thăng cấp bài',
            onclick: async () => {
              if (!confirm(`Xóa chương này và đẩy tất cả bài bên trong ra cấp ngoài?`)) return;
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
          bottomRow.appendChild(leftCol);

          const rightCol = el('div', { style: 'display:flex;gap:8px;align-self:flex-end;' });
          rightCol.appendChild(el('button', { className: 'btn btn-outline btn-sm', textContent: 'Đóng', onclick: closeEditModal }));
          rightCol.appendChild(el('button', {
            className: 'btn btn-primary btn-sm',
            textContent: 'Lưu lại',
            onclick: async () => {
              const t = inp.value.trim();
              if (!t) { inp.focus(); return; }
              if (isManual) {
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
          bottomRow.appendChild(rightCol);
          modal.appendChild(bottomRow);
        } else {
          const bottomRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:16px;' });
          bottomRow.appendChild(el('button', {
            className: 'btn btn-sm',
            style: 'background:var(--color-red);color:white;',
            textContent: '🗑️ Xóa',
            onclick: async () => {
              if (!confirm(`Xóa mục này?`)) return;
              if (isManual) {
                const manualNodes = (_overrides.manualNodes || []).filter(n => n.id !== nodeId);
                await saveOverrides({ ..._overrides, manualNodes });
              } else {
                await patchNode(nodeId, { hidden: true });
              }
              closeEditModal();
            }
          }));

          const rightCol = el('div', { style: 'display:flex;gap:8px;margin-left:auto;' });
          rightCol.appendChild(el('button', { className: 'btn btn-outline btn-sm', textContent: 'Đóng', onclick: closeEditModal }));
          rightCol.appendChild(el('button', {
            className: 'btn btn-primary btn-sm',
            textContent: 'Lưu lại',
            onclick: async () => {
              const t = inp.value.trim();
              if (!t) { inp.focus(); return; }
              if (isManual) {
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
          bottomRow.appendChild(rightCol);
          modal.appendChild(bottomRow);
        }
      } else {
        const bottomRow = el('div', { style: 'display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px;' });
        bottomRow.appendChild(el('button', { className: 'btn btn-outline btn-sm', textContent: 'Đóng', onclick: closeEditModal }));
        bottomRow.appendChild(el('button', {
          className: 'btn btn-primary btn-sm',
          textContent: 'Tạo',
          onclick: async () => {
            const t = inp.value.trim();
            if (!t) { inp.focus(); return; }
            const newNode = { id: `manual-${Date.now()}`, title: t, type: isLesson ? 'lesson' : 'chapter', parentId, _isManual: true };
            if (!isLesson) {
              newNode.children = [];
              _openTreeNodes.add(newNode.id);
            }
            await saveOverrides({ ..._overrides, manualNodes: [...(_overrides.manualNodes || []), newNode] });
            closeEditModal();
          }
        }));
        modal.appendChild(bottomRow);
      }

      if (!isNew && !isManual) {
        modal.appendChild(el('button', {
          className: 'btn btn-outline btn-sm',
          textContent: '🔄 Đồng bộ lại từ Drive',
          style: 'margin-top: 8px; font-size: 0.8rem; color: var(--color-text-muted);',
          onclick: async () => {
            if (!confirm('Xóa toàn bộ chỉnh sửa thủ công của mục này và về dữ liệu gốc?')) return;
            await resetNodePatch(nodeId);
            closeEditModal();
          }
        }));
      }

      $('edit-overlay').style.display = 'block';
      modal.style.display = 'flex';
    }

// ── PHASE 2: Edit Mode ──

    function toggleEditMode() {
      if (!_isAdmin) return; // Fix 5: chặn non-admin kể cả gọi trực tiếp
      editMode = !editMode;
      if (!editMode) {
        _selectedNodes.clear();
        _clipboard = null;
        document.querySelectorAll('.is-cut').forEach(el => el.classList.remove('is-cut'));
      }
      document.body.classList.toggle('edit-mode', editMode);
      $('btn-edit').textContent = editMode ? '✅' : '✏️';
      $('btn-edit').title = editMode ? 'Thoát chỉnh sửa' : 'Chỉnh sửa';
      $('btn-undo').style.display = editMode ? '' : 'none';
      $('btn-redo').style.display = editMode ? '' : 'none';
      
      const btnResetCourses = $('btn-reset-courses');
      if (btnResetCourses) btnResetCourses.style.display = editMode && document.querySelector('.page.active')?.id === 'page-home' ? '' : 'none';
      
      refreshUndoRedoState();
      
      if (typeof _recomputeMerged === 'function') _recomputeMerged();
      
      const active = document.querySelector('.page.active')?.id;
      if (active === 'page-home') renderHome();
      else if (active === 'page-course' && currentCourseId) renderCourse(currentCourseId);
      else if (active === 'page-lesson' && currentCourseId) {
        _updateLessonSidebar();
      }
    }

    function _updateLessonSidebar() {
      if (!currentCourseId) return;
      const course = appData.courses?.find(c => c.id === currentCourseId);
      if (!course) return;
      const pct = getCourseProgressPct(course);
      const sidebarEl = $('sidebar-lesson-tree');
      if (sidebarEl) {
        sidebarEl.innerHTML = '';
        sidebarEl.appendChild(
          buildTree(course.tree, currentCourseId, 0, currentLessonId, currentCourseId)
        );
      }
      const titleEl = $('sidebar-lesson-title');
      if (titleEl) titleEl.textContent = `${course.title} - ${pct}%`;
      // Bug 5: Update lesson title in main content
      const lesson = findLesson(course, currentLessonId);
      if (lesson) {
        const titleH2 = $('lesson-title');
        if (titleH2) titleH2.textContent = lesson.title;
      }

      // Bug 3b: Call unconditionally to hide panel if lesson is hidden
      _renderLessonEditPanel(lesson);

      // Bug 4: Rebuild doc-list
      const dl = $('doc-list');
      if (dl && lesson) {
        dl.innerHTML = '';
        if (lesson.documents?.length) {
          lesson.documents.forEach((doc) => {
            const link = el('a', { href: safeUrl(doc.url), target: '_blank', rel: 'noopener noreferrer',
              className: 'btn btn-outline btn-sm', textContent: 'Mở' });
            const icon = el('span', { textContent: '📎 ' + doc.title });
            const card = el('div', { className: 'doc-card' }, icon, link);
            if (editMode && doc._isExtra) {
              const delBtn = el('button', {
                className: 'btn-icon', textContent: '✕', title: 'Xóa tài liệu này',
                style: 'margin-left:4px; color:var(--color-red, #e74c3c);',
                onclick: () => deleteExtraDoc(doc._extraIndex)
              });
              card.appendChild(delBtn);
            }
            dl.appendChild(card);
          });
        } else {
          dl.innerHTML = '<p style="font-size:.85rem;color:var(--text-muted)">Không có tài liệu</p>';
        }
      }
    }

    function openCourseModal(courseId) {
      const isNew = !courseId;
      const course = isNew ? null : findCourse(courseId);
      if (!isNew && !course) return;

      const isManual = !!course?._isManual;
      const patch = _overrides.patches?.[courseId] || {};

      const modal = $('edit-modal');
      modal.innerHTML = '';
      modal.style.cssText = `display:flex;flex-direction:column;gap:16px;
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        z-index:1001;padding:24px;min-width:320px;max-width:440px;
        max-height:80vh;overflow-y:auto;`;

      modal.appendChild(el('h4', {
        textContent: isNew ? '➕ Thêm khóa học' : '✏️ Chỉnh sửa khóa học',
        style: 'margin:0;font-size:1.1rem;'
      }));

      // ── Tên ──
      const nameGroup = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
      nameGroup.appendChild(el('div', { className: 'section-label', textContent: isNew ? 'Tên khóa học' : 'Tên hiển thị' }));
      const inp = Object.assign(document.createElement('input'), {
        type: 'text',
        placeholder: isNew ? 'Nhập tên...' : '',
        value: isNew ? '' : course.title
      });
      inp.style.cssText = 'width:100%;padding:8px 12px;box-sizing:border-box;';
      nameGroup.appendChild(inp);
      // Nút reset tên (chỉ auto course đã patch)
      if (!isNew && !isManual && patch.title) {
        nameGroup.appendChild(el('button', {
          className: 'btn btn-outline btn-sm',
          textContent: '↩ Reset về tên gốc',
          style: 'align-self:flex-start;margin-top:4px;',
          onclick: async () => {
            const patches = { ..._overrides.patches };
            if (patches[courseId]) {
              const { title: _, ...rest } = patches[courseId];
              if (Object.keys(rest).length) patches[courseId] = rest;
              else delete patches[courseId];
            }
            await saveOverrides({ ..._overrides, patches });
            closeEditModal();
          }
        }));
      }
      modal.appendChild(nameGroup);

      // ── Ẩn/hiện (chỉ khi edit) ──
      if (!isNew) {
        const hideBox = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(0,0,0,0.2);padding:10px 12px;border-radius:var(--radius-sm);' });
        const hideLabel = Object.assign(document.createElement('label'), { style: 'display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;font-size:.9rem;' });
        const chk = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!patch.hidden });
        hideLabel.appendChild(chk);
        hideLabel.appendChild(el('span', { textContent: 'Ẩn khóa học này' }));
        hideBox.appendChild(hideLabel);
        hideBox.appendChild(el('button', {
          className: 'btn btn-outline btn-sm', textContent: 'Áp dụng',
          onclick: async () => { await patchNode(courseId, { hidden: chk.checked }); closeEditModal(); }
        }));
        modal.appendChild(hideBox);
      }

      // ── Actions ──
      const actions = el('div', { style: 'display:flex;align-items:center;gap:8px;' });

      if (!isNew && isManual) {
        actions.appendChild(el('button', {
          className: 'btn btn-sm',
          style: 'background:var(--color-red);color:#fff;',
          textContent: '🗑️ Xóa',
          onclick: async () => {
            if (!confirm(`Xóa khóa "${course.title}"?`)) return;
            await saveOverrides({
              ..._overrides,
              manualCourses: (_overrides.manualCourses || []).filter(c => c.id !== courseId)
            });
            closeEditModal();
          }
        }));
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
            const newCourse = { id: `manual-${Date.now()}`, title: t, order: 99, _isManual: true, tree: [] };
            await saveOverrides({ ..._overrides, manualCourses: [...(_overrides.manualCourses || []), newCourse] });
          } else if (isManual) {
            // Sửa title trực tiếp trong manualCourses
            const manual = (_overrides.manualCourses || []).map(c =>
              c.id === courseId ? { ...c, title: t } : c
            );
            await saveOverrides({ ..._overrides, manualCourses: manual });
          } else {
            await patchNode(courseId, { title: t });
          }
          closeEditModal();
        }
      }));
      actions.appendChild(rightBtns);
      modal.appendChild(actions);

      $('edit-overlay').style.display = 'block';
      modal.style.display = 'flex';
    }

    function closeEditModal() {
      $('edit-modal').style.display = 'none';
      $('edit-overlay').style.display = 'none';
    }

    // ── RENDER: COURSE ──
    function renderCourse(courseId) {
      currentCourseId = courseId; showPage('course');
      const course = findCourse(courseId); if (!course) { navigate('home'); return; }
      
      const btnResetCourses = $('btn-reset-courses');
      if (btnResetCourses) btnResetCourses.style.display = 'none';

      $('sidebar-title').textContent = `${course.title} - ${getCourseProgressPct(course)}%`;
      $('sidebar-tree').innerHTML = '';
      $('sidebar-tree').appendChild(buildTree(course.tree, courseId, 0, null, courseId));
    }

    // ── RENDER: LESSON ──
    function renderLesson(courseId, lessonId) {
      currentCourseId = courseId; currentLessonId = lessonId; showPage('lesson');
      const course = findCourse(courseId); if (!course) { navigate('home'); return; }
      
      const btnResetCourses = $('btn-reset-courses');
      if (btnResetCourses) btnResetCourses.style.display = 'none';

      $('sidebar-lesson-title').textContent = `${course.title} - ${getCourseProgressPct(course)}%`;
      $('sidebar-lesson-tree').innerHTML = '';
      $('sidebar-lesson-tree').appendChild(buildTree(course.tree, courseId, 0, lessonId, courseId));
      const lesson = findLesson(course, lessonId); if (!lesson) return;
      $('lesson-title').textContent = lesson.title;

      if (currentUser) {
        localStorage.setItem(`last_lesson_${courseId}_${currentUser.uid}`, lessonId);
      }

      if (typeof destroyPlyr === 'function') destroyPlyr();
      const vw = $('video-wrap');
      const nv = $('no-video');
      vw.innerHTML = '';
      vw.appendChild(nv);

      if (lesson.youtubeId) {
        nv.style.display = 'none';

        const container = document.createElement('div');
        container.className = 'video-container';

        const plyrPlayer = document.createElement('div');
        plyrPlayer.id = 'plyr-player';
        plyrPlayer.setAttribute('data-plyr-provider', 'youtube');
        plyrPlayer.setAttribute('data-plyr-embed-id', lesson.youtubeId);

        const poster = document.createElement('div');
        poster.id = 'custom-poster';

        const customTitle = document.createElement('div');
        customTitle.id = 'custom-video-title';
        customTitle.textContent = lesson.title;

        fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${lesson.youtubeId}`)
          .then(r => r.json())
          .then(data => { if (data.title) customTitle.textContent = data.title; })
          .catch(() => { });

        const img = document.createElement('img');
        img.src = `https://i.ytimg.com/vi/${lesson.youtubeId}/maxresdefault.jpg`;
        img.onerror = () => { img.src = img.src.replace('maxresdefault', 'hqdefault'); };

        const playBtn = document.createElement('button');
        playBtn.id = 'poster-play-btn';

        poster.appendChild(img);
        poster.appendChild(customTitle);
        poster.appendChild(playBtn);

        container.appendChild(plyrPlayer);
        container.appendChild(poster);
        vw.appendChild(container);

        plyrInstance = new Plyr('#plyr-player', {
          controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'settings', 'fullscreen'],
          settings: ['captions', 'quality', 'speed'],
          captions: { active: false, update: true },
          speed: { selected: 1, options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
          keyboard: { focused: false, global: false },
          youtube: { rel: 0, iv_load_policy: 3, modestbranding: 1, cc_load_policy: 0 },
          i18n: {
            play: 'Phát', pause: 'Tạm dừng', restart: 'Phát lại từ đầu',
            mute: 'Tắt tiếng', unmute: 'Bật tiếng', settings: 'Cài đặt',
            speed: 'Tốc độ', normal: 'Bình thường',
            fullscreen: 'Toàn màn hình', exitFullscreen: 'Thoát toàn màn hình',
            duration: 'Thời lượng', captions: 'Phụ đề', disableCaptions: 'Tắt phụ đề', enableCaptions: 'Bật phụ đề'
          }
        });

        let hasAutoSeeked = false;
        plyrInstance.on('ready', () => {
          if (plyrInstance.embed && plyrInstance.embed.unloadModule) {
            plyrInstance.embed.unloadModule('captions');
            plyrInstance._ytCaptionsOn = false;
          }
          const saved = getLocalProgress(currentLessonId);
          if (saved && saved.watchedTime > 0 && !hasAutoSeeked) {
            if (!saved.ytId || saved.ytId === lesson.youtubeId) {
              hasAutoSeeked = true;
              try { plyrInstance.currentTime = saved.watchedTime; } catch (e) { }
            }
          }
        });

        let lastSavedTime = 0;
        plyrInstance.on('timeupdate', () => {
          if (!plyrInstance) return;
          const t = plyrInstance.currentTime;
          const d = plyrInstance.duration;
          if (Math.abs(t - lastSavedTime) >= 5) {
            lastSavedTime = t;
            saveLocalProgress(currentLessonId, t, d, lesson.youtubeId);
            updateRealtimeProgressUI();
          }
        });

        plyrInstance.on('pause', () => {
          if (currentLessonId) flushProgressToFirestore(currentLessonId, currentCourseId);
        });

        plyrInstance.on('ended', () => {
          flushProgressToFirestore(currentLessonId, currentCourseId);
          const old = getLocalProgress(currentLessonId) || {};
          const oldMax = old.watchedTime || 0;
          const d = plyrInstance.duration || 1;
          if (d - oldMax <= 600) {
            if (!progress[currentLessonId]) toggleWatch(true);
          }
        });

        poster.addEventListener('click', () => {
          try { plyrInstance.play(); } catch (e) { }
        });

        plyrInstance.on('playing', () => {
          const p = document.getElementById('custom-poster');
          if (p) {
            p.style.opacity = '0';
            p.style.pointerEvents = 'none';
            setTimeout(() => p.remove(), 300);
          }
        });

      } else {
        nv.style.display = 'flex';
      }

      updateWatchBtn();
      const dl = $('doc-list'); dl.innerHTML = '';
      if (lesson.documents?.length) {
        lesson.documents.forEach((doc, idx) => {
          const link = el('a', {
            href: safeUrl(doc.url), target: '_blank',
            rel: 'noopener noreferrer',
            className: 'btn btn-outline btn-sm', textContent: 'Mở'
          });
          const icon = el('span', { textContent: '📎 ' + doc.title });
          const card = el('div', { className: 'doc-card' }, icon, link);
          if (editMode && doc._isExtra) {
            const delBtn = el('button', {
              className: 'btn-icon', textContent: '✕', title: 'Xóa tài liệu này',
              style: 'margin-left:4px; color:var(--color-red, #e74c3c);',
              onclick: () => deleteExtraDoc(doc._extraIndex)
            });
            card.appendChild(delBtn);
          }
          dl.appendChild(card);
        });
      } else { dl.innerHTML = '<p style="font-size:.85rem;color:var(--text-muted)">Không có tài liệu</p>'; }

      // Phase 4: Lesson edit panel
      _renderLessonEditPanel(lesson);
    }


    // ── Phase 4: Lesson Edit Helpers ──

    function extractYoutubeId(raw) {
      const patterns = [
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /\/embed\/([A-Za-z0-9_-]{11})/,
        /^([A-Za-z0-9_-]{11})$/
      ];
      for (const p of patterns) {
        const m = raw.match(p);
        if (m) return m[1];
      }
      return null;
    }

    async function saveLessonYoutube() {
      const inp = $('lesson-yt-input');
      const id = extractYoutubeId(inp.value.trim());
      if (!id) { alert('URL YouTube không hợp lệ'); return; }
      await patchNode(currentLessonId, { youtubeId: id });
      inp.value = '';
      renderLesson(currentCourseId, currentLessonId);
    }

    async function resetLessonYoutube() {
      const patches = { ..._overrides.patches };
      if (patches[currentLessonId]) {
        const { youtubeId: _, ...rest } = patches[currentLessonId];
        if (Object.keys(rest).length) patches[currentLessonId] = rest;
        else delete patches[currentLessonId];
      }
      await saveOverrides({ ..._overrides, patches });
      renderLesson(currentCourseId, currentLessonId);
    }

    async function addExtraDoc() {
      const titleEl = $('doc-title-input');
      const urlEl = $('doc-url-input');
      const title = titleEl.value.trim();
      const url = urlEl.value.trim();
      if (!title || !url) { alert('Vui lòng điền đủ tên và URL'); return; }
      if (!url.includes('drive.google.com')) { alert('Chỉ chấp nhận Google Drive URL'); return; }
      const normalizedUrl = url.replace(/\/edit.*$/, '/view').replace(/\/preview.*$/, '/view');
      const existing = _overrides.patches?.[currentLessonId]?.extraDocs || [];
      await patchNode(currentLessonId, { extraDocs: [...existing, { title, url: normalizedUrl }] });
      titleEl.value = ''; urlEl.value = '';
    }

    async function deleteExtraDoc(index) {
      const extraDocs = (_overrides.patches?.[currentLessonId]?.extraDocs || [])
        .filter((_, i) => i !== index);
      await patchNode(currentLessonId, { extraDocs });
    }

    function _renderLessonEditPanel(lesson) {
      const panel = $('lesson-edit-panel');
      if (!panel) return;
      if (!editMode || !lesson) { panel.style.display = 'none'; return; }
      panel.style.display = 'flex';
      panel.innerHTML = '';

      // Section: YouTube
      const hasYtPatch = !!_overrides.patches?.[currentLessonId]?.youtubeId;

      const ytSection = document.createElement('div');
      ytSection.className = 'glass';
      ytSection.style.cssText = 'padding:16px; display:flex; flex-direction:column; gap:10px;';

      const ytLabel = el('div', { className: 'section-label', textContent: '🔗 Video YouTube' });

      const ytRow = document.createElement('div');
      ytRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

      const ytInput = el('input', { id: 'lesson-yt-input', type: 'text', placeholder: 'YouTube URL hoặc Video ID...' });
      if (lesson?.youtubeId) ytInput.value = lesson.youtubeId;
      ytInput.style.cssText = 'flex:1; padding:6px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(0,0,0,0.1); color:inherit;';

      const ytSaveBtn = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Đổi', onclick: saveLessonYoutube });
      ytRow.append(ytInput, ytSaveBtn);

      if (hasYtPatch) {
        const ytResetBtn = el('button', { className: 'btn btn-outline btn-sm', textContent: '↩ Reset', onclick: resetLessonYoutube });
        ytRow.appendChild(ytResetBtn);
      }

      ytSection.append(ytLabel, ytRow);

      if (hasYtPatch) {
        const badge = el('span', {
          textContent: '⚠ Đang dùng link YouTube thủ công',
          style: 'font-size:0.8rem; color:var(--color-warning, #f5a623); padding:4px 8px; background:rgba(245,166,35,0.12); border-radius:4px; display:inline-block;'
        });
        ytSection.appendChild(badge);
      }

      panel.appendChild(ytSection);

      // Section: Add doc
      const docSection = document.createElement('div');
      docSection.className = 'glass';
      docSection.style.cssText = 'padding:16px; display:flex; flex-direction:column; gap:10px;';

      docSection.appendChild(el('div', { className: 'section-label', textContent: '📎 Thêm tài liệu (Google Drive)' }));

      const docTitleInp = el('input', { id: 'doc-title-input', type: 'text', placeholder: 'Tên hiển thị...' });
      docTitleInp.style.cssText = 'padding:6px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(0,0,0,0.1); color:inherit;';

      const docUrlInp = el('input', { id: 'doc-url-input', type: 'text', placeholder: 'Google Drive URL...' });
      docUrlInp.style.cssText = 'padding:6px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:rgba(0,0,0,0.1); color:inherit;';

      const docAddBtn = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Thêm', style: 'align-self:flex-start;', onclick: addExtraDoc });

      docSection.append(docTitleInp, docUrlInp, docAddBtn);
      panel.appendChild(docSection);

      if (!lesson._isManual) {
        const syncResetBtn = el('button', {
          className: 'btn btn-outline btn-sm',
          textContent: '🔄 Đồng bộ lại từ Drive',
          style: 'margin-top: 8px; font-size: 0.8rem; color: var(--color-text-muted); align-self: flex-start;',
          onclick: async () => {
            if (!confirm('Xóa toàn bộ chỉnh sửa thủ công của mục này và về dữ liệu gốc?')) return;
            await resetNodePatch(currentLessonId);
            _renderLessonEditPanel(findLesson(findCourse(currentCourseId), currentLessonId));
          }
        });
        panel.appendChild(syncResetBtn);
      }
    }

    function updateWatchBtn() {
      const btn = $('btn-watch'); if (!btn) return;
      const w = !!progress[currentLessonId];
      btn.textContent = w ? '✓ Đã xem' : 'Đánh dấu đã xem';
      btn.className = 'btn-watch' + (w ? ' watched' : '');
    }

    async function toggleWatch(forceValue) {
      if (!currentLessonId || !currentCourseId) return;
      const v = forceValue !== undefined ? forceValue : !progress[currentLessonId];
      progress[currentLessonId] = v;
      try {
        const old = getLocalProgress(currentLessonId) || {};
        const d = (plyrInstance && plyrInstance.duration) ? plyrInstance.duration : 1;
        const t = v ? d : 0;
        const p = { ...old, watchedTime: t, duration: d, updatedAt: Date.now() };
        localStorage.setItem(`prog_${currentUser.uid}_${currentLessonId}`, JSON.stringify(p));
      } catch (e) { }
      updateWatchBtn();
      await saveProgress(currentLessonId, currentCourseId, v);
      updateRealtimeProgressUI();
    }

    // ── Phase 6: Flatten All ──
    async function previewFlattenAll() {
      const count = appData.courses.flatMap(c => (c.tree || []).flatMap(getAllLessons)).length;
      if (!confirm(`⚡ Làm phẳng toàn bộ ${count} bài học?\nTên bài sẽ được prefix tên chương cha.`)) return;
      await saveOverrides({ ..._overrides, flattenAll: true });
    }
    
    async function disableFlattenAll() {
      await saveOverrides({ ..._overrides, flattenAll: false });
    }

    // ── ADMIN ──
    function toggleAdmin() {
      $('admin-panel').classList.toggle('open');
      if ($('admin-panel').classList.contains('open')) loadAdminData();
    }

    async function loadAdminData() {
      const wl = $('whitelist-list'); wl.innerHTML = 'Đang tải...';
      try {
        const snap = await db.collection('whitelist').get();
        if (snap.empty) { wl.innerHTML = '<i>Chưa có ai</i>'; }
        else {
          wl.innerHTML = '';
          snap.forEach(doc => {
            const emailText = el('span', { textContent: doc.id });
            const removeBtn = el('button', {
              className: 'whitelist-remove', textContent: '✕',
              onclick: () => removeWhitelist(doc.id)
            });
            wl.appendChild(el('div', { className: 'whitelist-item' }, emailText, removeBtn));
          });
        }
      } catch (e) { wl.innerHTML = 'Lỗi: ' + e.message; }

      const sl = $('security-logs'); sl.innerHTML = 'Đang tải...';
      try {
        const snap = await db.collection('security_logs').orderBy('time', 'desc').limit(10).get();
        if (snap.empty) { sl.innerHTML = '<span style="color:var(--green)">Không có truy cập trái phép</span>'; }
        else {
          sl.innerHTML = '';
          snap.forEach(doc => {
            const d = doc.data(), t = d.time?.toDate?.()?.toLocaleString('vi-VN') || '—';
            const div = document.createElement('div'); div.className = 'log-item';
            div.textContent = `⚠ ${d.email} — ${t}`;
            sl.appendChild(div);
          });
        }
      } catch (e) { sl.innerHTML = 'Lỗi: ' + e.message; }
    }

    async function addWhitelist() {
      const input = $('whitelist-input'), email = input.value.trim().toLowerCase();
      if (!email || !email.includes('@')) { alert('Email không hợp lệ'); return; }
      await db.collection('whitelist').doc(email).set({ addedAt: firebase.firestore.FieldValue.serverTimestamp() });
      input.value = ''; loadAdminData();
    }
    async function removeWhitelist(email) {
      if (!confirm(`Xoá quyền của ${email}?`)) return;
      await db.collection('whitelist').doc(email).delete(); loadAdminData();
    }

    document.addEventListener('click', e => {
      if (!$('admin-panel').contains(e.target) && e.target !== $('btn-admin'))
        $('admin-panel').classList.remove('open');
    });

    async function triggerSync(e) {
      const btn = e.target; btn.disabled = true; btn.textContent = 'Đang sync...';
      try {
        if (!currentUser) { alert('Bạn chưa đăng nhập.'); return; }
        const idToken = await currentUser.getIdToken(true);
        const r = await fetch(SYNC_PROXY_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + idToken }
        });
        if (r.status === 204) alert('✓ Đã trigger sync! GitHub Actions sẽ chạy trong vài giây.');
        else if (r.status === 403) alert('⛔ Bạn không có quyền trigger sync.');
        else if (r.status === 429) alert('⏳ Vừa sync xong, chờ 5 phút trước khi sync lại.');
        else alert('Lỗi: ' + r.status + '. Kiểm tra Cloudflare Worker.');
      } catch (e) { alert('Lỗi kết nối: ' + e.message); }
      finally { btn.disabled = false; btn.textContent = '🔄 Sync ngay'; }
    }

    // ── PLYR ──
    function destroyPlyr() {
      if (currentLessonId) flushProgressToFirestore(currentLessonId, currentCourseId);
      if (plyrInstance) {
        try { plyrInstance.stop(); plyrInstance.destroy(); } catch (e) { }
        plyrInstance = null;
      }
      const vw = $('video-wrap');
      if (vw) {
        const ifr = vw.querySelector('iframe');
        if (ifr) ifr.src = '';
        vw.innerHTML = '';
        const nv = document.createElement('div');
        nv.id = 'no-video'; nv.className = 'no-video';
        nv.style.display = 'none';
        nv.innerHTML = '<span class="icon">Chọn một bài học để bắt đầu</span>';
        vw.appendChild(nv);
      }
      _holdSpeedActive = false;
    }

    function showToast(msg) {
      const container = document.querySelector('.video-container');
      if (!container) return;
      let toast = document.getElementById('player-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'player-toast';
        container.appendChild(toast);
      }
      toast.textContent = msg;
      toast.classList.remove('show');
      void toast.offsetWidth;
      toast.classList.add('show');
      if (toast.timeoutId) clearTimeout(toast.timeoutId);
      toast.timeoutId = setTimeout(() => { toast.classList.remove('show'); }, 800);
    }

    document.addEventListener('keydown', e => {
      if (!plyrInstance) return;
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'input' || activeTag === 'textarea') return;

      let handled = false;
      const key = e.key.toLowerCase();

      switch (key) {
        case ' ':
        case 'k':
          handled = true;
          if (key === ' ' && !e.repeat && plyrInstance.playing) {
            _spaceTimer = setTimeout(() => {
              _holdSpeedActive = true;
              _prevSpeed = plyrInstance.speed;
              plyrInstance.speed = 2;
              showToast('🐇 2x Speed');
            }, 300);
          }
          break;
        case 'arrowleft':
        case 'j':
          handled = true;
          const jumpBack = e.shiftKey ? 10 : 5;
          plyrInstance.currentTime = Math.max(0, plyrInstance.currentTime - jumpBack);
          showToast(`⏪ -${jumpBack}s`);
          break;
        case 'arrowright':
        case 'l':
          handled = true;
          const jumpFwd = e.shiftKey ? 10 : 5;
          plyrInstance.currentTime = Math.min(plyrInstance.duration, plyrInstance.currentTime + jumpFwd);
          showToast(`⏩ +${jumpFwd}s`);
          break;
        case 'arrowup':
          handled = true;
          plyrInstance.increaseVolume(0.05);
          showToast(`🔊 ${Math.round(plyrInstance.volume * 100)}%`);
          break;
        case 'arrowdown':
          handled = true;
          plyrInstance.decreaseVolume(0.05);
          showToast(`🔉 ${Math.round(plyrInstance.volume * 100)}%`);
          break;
        case 'm':
          handled = true;
          plyrInstance.muted = !plyrInstance.muted;
          showToast(plyrInstance.muted ? '🔇 Đã tắt tiếng' : '🔊 Đã bật tiếng');
          break;
        case 'f':
          handled = true;
          if (plyrInstance.fullscreen.active) plyrInstance.fullscreen.exit();
          else plyrInstance.fullscreen.enter();
          break;
        case 'c':
          handled = true;
          if (plyrInstance.embed && typeof plyrInstance.embed.loadModule === 'function') {
            if (!plyrInstance._ytCaptionsOn) {
              plyrInstance.embed.loadModule('captions');
              plyrInstance.embed.setOption('captions', 'track', { 'languageCode': 'vi' });
              plyrInstance._ytCaptionsOn = true;
              showToast('Bật phụ đề');
            } else {
              plyrInstance.embed.unloadModule('captions');
              plyrInstance._ytCaptionsOn = false;
              showToast('Tắt phụ đề');
            }
          } else {
            const currentCaptions = plyrInstance.captions.active;
            plyrInstance.toggleCaptions(!currentCaptions);
            showToast(!currentCaptions ? 'Bật phụ đề' : 'Tắt phụ đề');
          }
          break;
        case 'home':
          handled = true;
          plyrInstance.currentTime = 0;
          showToast('Đầu video');
          break;
        case 'end':
          handled = true;
          plyrInstance.currentTime = plyrInstance.duration;
          showToast('Cuối video');
          break;
        case ',':
          if (!plyrInstance.playing) {
            handled = true;
            plyrInstance.currentTime = Math.max(0, plyrInstance.currentTime - 0.033);
            showToast('⏮ -1 frame');
          }
          break;
        case '.':
          if (!plyrInstance.playing) {
            handled = true;
            plyrInstance.currentTime = Math.min(plyrInstance.duration, plyrInstance.currentTime + 0.033);
            showToast('⏭ +1 frame');
          }
          break;
        case '<':
          handled = true;
          plyrInstance.speed = Math.max(0.25, plyrInstance.speed - 0.25);
          showToast(`🐢 ${plyrInstance.speed}x`);
          break;
        case '>':
          handled = true;
          plyrInstance.speed = Math.min(2, plyrInstance.speed + 0.25);
          showToast(`🐇 ${plyrInstance.speed}x`);
          break;
        default:
          if (e.key >= '0' && e.key <= '9') {
            handled = true;
            const pct = parseInt(e.key) / 10;
            plyrInstance.currentTime = plyrInstance.duration * pct;
            showToast(`Nhảy đến ${pct * 100}%`);
          }
          break;
      }

      if (handled) e.preventDefault();
    });

    document.addEventListener('keyup', e => {
      if (!plyrInstance) return;
      if (e.key === ' ' || e.key.toLowerCase() === 'k') {
        if (_spaceTimer) clearTimeout(_spaceTimer);
        if (_holdSpeedActive) {
          _holdSpeedActive = false;
          plyrInstance.speed = _prevSpeed;
          showToast(`Bình thường (${_prevSpeed}x)`);
        } else {
          plyrInstance.togglePlay();
          showToast(plyrInstance.playing ? '▶ Phát' : '⏸ Tạm dừng');
        }
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && currentLessonId) {
        flushProgressToFirestore(currentLessonId, currentCourseId);
      }
    });

    window.addEventListener('pagehide', () => {
      if (currentLessonId) flushProgressToFirestore(currentLessonId, currentCourseId);
    });

    window.addEventListener('hashchange', handleHash);

    // ── Phase 2: Additions ──
    function assignNewIds(node) {
      node.id = `manual-${Date.now()}-${Math.floor(Math.random()*100000)}`;
      if (node.children) {
        node.children.forEach(assignNewIds);
      }
      if (node.tree) {
        node.tree.forEach(assignNewIds);
      }
    }

    async function resetAllCourses() {
      if (!confirm("⚠️ Nguy hiểm: Khôi phục tất cả khóa học về trạng thái gốc!\n\n- Thứ tự khóa học sẽ bị reset.\n- Các khóa bị ẩn sẽ hiện lại.\n- Khóa đổi tên sẽ về tên gốc.\n- Các khóa bạn TỰ THÊM sẽ bị ẩn và đẩy xuống cuối.\n\nBạn có chắc chắn?")) return;
      
      const patches = { ..._overrides.patches };
      const rawCourseIds = _rawAutoData.map(c => c.id);
      
      for (const id of rawCourseIds) {
        if (patches[id]) {
          delete patches[id].hidden;
          delete patches[id].title;
          if (Object.keys(patches[id]).length === 0) {
            delete patches[id];
          }
        }
      }
      
      const manualCourses = [...(_overrides.manualCourses || [])];
      manualCourses.forEach(c => {
        c._hidden = true;
      });
      
      await saveOverrides({
        ..._overrides,
        courseDisplayOrder: [],
        patches,
        manualCourses
      });
    }

    async function resetCurrentCourse(courseId) {
      if (!confirm("⚠️ Nguy hiểm: Khôi phục khóa học này về gốc!\n\n- Tên chương, cấu trúc sẽ về nguyên bản.\n- Các mục bị sửa/thêm thủ công sẽ được gom lại dưới cùng khóa học (với tên 'modified_...').\n\nBạn có tiếp tục?")) return;
      
      const course = appData.courses.find(c => c.id === courseId);
      if (!course) return;

      const patches = { ..._overrides.patches };
      let manualNodes = [...(_overrides.manualNodes || [])];
      let reparent = { ..._overrides.reparent };
      
      const courseNodeIds = new Set();
      function collectIds(node) {
        courseNodeIds.add(node.id);
        if (node.children) node.children.forEach(collectIds);
        if (node.tree) node.tree.forEach(collectIds);
      }
      
      const rawCourse = _rawAutoData.find(c => c.id === courseId);
      if (rawCourse) {
        rawCourse.tree.forEach(collectIds);
      }
      
      const backups = [];
      
      if (rawCourse) {
        rawCourse.tree.forEach(chapter => {
          const p = patches[chapter.id];
          if (p && (p.title !== undefined || p.childOrder || p.flattenChildren)) {
            const mergedChapter = course.tree.find(c => c.id === chapter.id);
            if (mergedChapter && !mergedChapter._hidden) {
              const backup = JSON.parse(JSON.stringify(mergedChapter));
              assignNewIds(backup);
              backup.title = "modified_" + (backup.title || chapter.title);
              backup._isManual = true;
              backup.parentId = courseId;
              backups.push(backup);
            }
          }
        });
      }
      
      const isManualTopInCourse = n => n.parentId === courseId && n._isManual;
      const isManualNestedInRawChapter = n => courseNodeIds.has(n.parentId) && n._isManual;
      
      manualNodes = manualNodes.filter(n => {
        if (isManualTopInCourse(n)) {
          const backup = JSON.parse(JSON.stringify(n));
          assignNewIds(backup);
          backup.title = "modified_" + backup.title;
          backup.parentId = courseId;
          backups.push(backup);
          return false;
        }
        if (isManualNestedInRawChapter(n)) return false;
        return true;
      });
      
      courseNodeIds.forEach(id => {
        delete patches[id];
        delete reparent[id];
      });
      
      manualNodes.push(...backups);
      
      await saveOverrides({ ..._overrides, patches, manualNodes, reparent });
    }

    function loadBackupFromFile(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.overrides) {
            if (!confirm("Tải lên bản backup sẽ ghi đè toàn bộ dữ liệu hiện tại. Bạn có chắc chắn?")) return;
            await saveOverrides(data.overrides);
            alert("✅ Tải backup thành công!");
          } else {
            alert("❌ File không hợp lệ");
          }
        } catch (err) {
          alert("❌ Lỗi đọc file JSON: " + err.message);
        }
        e.target.value = '';
      };
      reader.readAsText(file);
    }

    // ── MOCK DATA ──
    function getMockData() {
      return {
        lastUpdated: new Date().toISOString(), courses: [
          {
            id: "01-mock", title: "Khóa mẫu", order: 1, tree: [
              {
                id: "01-01", title: "Chương 1", order: 1, type: "chapter", children: [
                  { id: "01-01-01", title: "Bài 1", order: 1, type: "lesson", youtubeId: "", documents: [] }
                ]
              }
            ]
          }
        ]
      };
    }

    // ─────────────────────────────────────────────
    // EVENT BINDINGS — thay thế onclick= trong HTML
    // Thêm vào CUỐI app.js sau tất cả function declarations
    // ─────────────────────────────────────────────
    (function bindEvents() {
      function on(id, evt, fn) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(evt, fn);
      }

      // Header
      on('btn-home-logo',  'click', () => navigate('home'));
      on('btn-signout',    'click', signOut);
      on('btn-admin',      'click', toggleAdmin);
      on('btn-undo',       'click', doUndo);
      on('btn-redo',       'click', doRedo);
      on('btn-reset-courses', 'click', resetAllCourses);
      on('btn-edit',       'click', toggleEditMode);

      // Admin panel
      on('btn-trigger-sync',    'click', e => triggerSync(e));
      on('btn-check-video',     'click', () => window.open('admin-check.html', '_blank'));
      on('btn-download-backup', 'click', downloadBackup);
      on('btn-upload-backup',   'click', () => document.getElementById('backup-file-input').click());
      on('backup-file-input',   'change', loadBackupFromFile);
      on('btn-flatten-all',     'click', previewFlattenAll);
      on('btn-unflatten',       'click', disableFlattenAll);
      on('btn-add-whitelist',   'click', addWhitelist);
      on('btn-reload-admin',    'click', loadAdminData);

      // Landing
      on('btn-signin-google', 'click', signInGoogle);

      // Lesson
      on('btn-watch', 'click', () => toggleWatch());

      // Edit overlay
      on('edit-overlay', 'click', closeEditModal);
    })();
