// ─────────────────────────────────────────────
// responsive.js — Giao diện điện thoại (orientation: portrait)
// Không đụng vào logic app.js, chỉ thêm hành vi UI cho mobile.
// Khi xoay ngang, các rule CSS @media(orientation:portrait) tự tắt
// nên toàn bộ code dưới đây trở thành no-op → tự quay lại desktop.
// ─────────────────────────────────────────────
(function () {
    function isPortrait() {
        return window.matchMedia('(orientation: portrait)').matches;
    }

    // ── Đồng bộ chiều rộng sidebar hiện tại → CSS var --sidebar-current-w
    // để backdrop mobile "khoét" đúng phần diện tích sidebar (xem style.css),
    // giúp hiệu ứng glass của sidebar blur đúng nền thật thay vì lớp đen mờ.
    function syncSidebarCutout() {
        const activeSidebar = document.querySelector('#page-course.active .sidebar, #page-lesson.active .sidebar');
        const w = activeSidebar ? activeSidebar.getBoundingClientRect().width : 0;
        document.documentElement.style.setProperty('--sidebar-current-w', w + 'px');
    }

    // ── Sidebar drawer (course & lesson) ──
    function setSidebarOpen(open) {
        document.body.classList.toggle('sidebar-open', open);
        const btn = document.getElementById('btn-sidebar-toggle');
        if (btn) btn.textContent = open ? '<<' : '>>';
        if (open) syncSidebarCutout();
    }

    document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
        setSidebarOpen(!document.body.classList.contains('sidebar-open'));
    });

    document.getElementById('btn-home-mobile')?.addEventListener('click', () => {
        if (typeof navigate === 'function') navigate('home');
    });

    document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
        setSidebarOpen(false);
    });

    // Chọn bài trong sidebar (không phải mở/đóng chương) → tự đóng drawer.
    // Lesson label: không chứa .toggle-icon (chỉ chương/folder mới có .toggle-icon).
    function handleTreeClick(e) {
        if (!isPortrait() || !document.body.classList.contains('sidebar-open')) return;
        const label = e.target.closest('.tree-label');
        if (!label) return;
        if (e.target.closest('.btn-icon') || e.target.tagName === 'INPUT') return;
        if (label.querySelector('.toggle-icon')) return; // click mở/đóng chương → không đóng
        setSidebarOpen(false);
    }
    document.getElementById('sidebar-tree')?.addEventListener('click', handleTreeClick);
    document.getElementById('sidebar-lesson-tree')?.addEventListener('click', handleTreeClick);

    // Xoay ngang / thoát trang có sidebar → dọn state để lần mở lại nhất quán
    window.addEventListener('resize', () => {
        if (!isPortrait()) setSidebarOpen(false);
        if (document.body.classList.contains('sidebar-open')) syncSidebarCutout();
    });

    // Theo dõi mọi thay đổi kích thước sidebar thật (kéo resize, đổi breakpoint…)
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
            if (document.body.classList.contains('sidebar-open')) syncSidebarCutout();
        });
        document.querySelectorAll('.sidebar').forEach(el => ro.observe(el));
    }

    // ── Resize sidebar bằng chuột kéo (chỉ desktop, không áp dụng ở drawer mobile) ──
    const SIDEBAR_MIN_W = 180;
    const SIDEBAR_MAX_W = 520;

    function attachSidebarResize(sidebarEl) {
        const handle = document.createElement('div');
        handle.className = 'sidebar-resize-handle';
        handle.title = 'Kéo để đổi chiều rộng sidebar';
        sidebarEl.appendChild(handle);

        handle.addEventListener('pointerdown', (e) => {
            if (isPortrait()) return; // resize tay chỉ dành cho giao diện desktop
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = sidebarEl.getBoundingClientRect().width;
            handle.setPointerCapture(e.pointerId);
            handle.classList.add('active');
            document.body.classList.add('sidebar-resizing');

            function onMove(ev) {
                const newWidth = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(startWidth + (ev.clientX - startX))));
                document.documentElement.style.setProperty('--sidebar-w', newWidth + 'px');
            }

            function onUp() {
                handle.releasePointerCapture(e.pointerId);
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.classList.remove('active');
                document.body.classList.remove('sidebar-resizing');

                const finalWidth = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim();
                console.log(
                    '%c[Sidebar resize] Chiều rộng hiện tại: ' + finalWidth,
                    'color:#4fc3f7;font-weight:bold;font-size:12px;'
                );
                console.log(
                    '→ Vừa mắt rồi thì mở style.css, tìm "--sidebar-w: 280px;" trong :root và đổi thành "--sidebar-w: ' +
                    finalWidth + ';" để đặt làm mặc định.'
                );
            }

            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
        });
    }

    document.querySelectorAll('.sidebar').forEach(attachSidebarResize);

    // ── Admin panel: nút X đóng (fullscreen trên mobile) ──
    document.getElementById('btn-admin-close')?.addEventListener('click', () => {
        document.getElementById('admin-panel')?.classList.remove('open');
    });

    // ── Calendar: mobile mặc định mở dạng danh sách, tự cuộn + nhấp nháy hôm nay ──
    document.addEventListener('click', function (e) {
        if (!e.target.closest('#btn-calendar')) return;
        if (!isPortrait()) return;
        if (typeof renderCalendar !== 'function') return;
        // Chặn handler mặc định (render dạng tháng) của app.js, tự render dạng danh sách.
        e.stopImmediatePropagation();
        e.preventDefault();
        if (typeof window.setCalViewMode === 'function') window.setCalViewMode('list');
        if (typeof window.resetCalViewDate === 'function') window.resetCalViewDate();
        Promise.resolve(renderCalendar()).then(() => {
            const todayDate = typeof getTodayStr === 'function' ? getTodayStr() : null;
            if (!todayDate) return;
            const header = document.querySelector(`.cal-list-date-header[data-date="${todayDate}"]`);
            if (header) {
                header.scrollIntoView({ behavior: 'smooth', block: 'center' });
                header.classList.remove('flash-today');
                void header.offsetWidth;
                header.classList.add('flash-today');
                setTimeout(() => header.classList.remove('flash-today'), 1600);
            }
        });
    }, true);
})();