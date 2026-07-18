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

    // ── Sidebar drawer (course & lesson) ──
    function setSidebarOpen(open) {
        document.body.classList.toggle('sidebar-open', open);
        const btn = document.getElementById('btn-sidebar-toggle');
        if (btn) btn.textContent = open ? '<<' : '>>';
    }

    document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
        setSidebarOpen(!document.body.classList.contains('sidebar-open'));
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
    });

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